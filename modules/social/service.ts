import { Injectable } from '@nestjs/common';
import { Database, DbClient } from '../../packages/database';
import { Idempotency } from '../../packages/idempotency';
import { AccessService } from '../../packages/access';
import { invariant } from '../../packages/contracts/errors';
import { keyedDigest, digest, secureEqual, token } from '../../packages/auth/crypto';
import { loadConfig } from '../../packages/config';
import { emitEvent } from '../../packages/events';
import { MembershipService } from '../membership/service';
import { CreateEventDto, CreateMatchDto, MatchResultDto } from './dto';

@Injectable()
export class SocialService {
  constructor(private readonly db: Database, private readonly access: AccessService,
    private readonly idem: Idempotency, private readonly membership: MembershipService) {}
  async events(branchId?: string) {
    return (await this.db.query(`SELECT id,branch_id,organizer_id,title,description,starts_at,ends_at,capacity,ticket_price,currency,status
      FROM social.events WHERE status='OPEN' AND ends_at>now() AND ($1::uuid IS NULL OR branch_id=$1) ORDER BY starts_at,id`, [branchId || null])).rows;
  }
  async event(id: string) {
    const row = (await this.db.query('SELECT * FROM social.events WHERE id=$1', [id])).rows[0];
    invariant(row, 'NOT_FOUND', 'Event not found', 404); return row;
  }
  async createEvent(userId: string, dto: CreateEventDto, requestId: string) {
    const start = new Date(dto.startsAt), end = new Date(dto.endsAt);
    invariant(Number.isFinite(start.getTime()) && start.getTime() > Date.now() && end > start && end.getTime() - start.getTime() <= 7 * 86400000,
      'INVALID_EVENT_TIME', 'Event must be future and at most seven days', 400);
    invariant(!(dto.ticketPrice > 0 && dto.membershipRequired), 'INVALID_EVENT_PRICING', 'An event is either paid by ticket or membership-only, not both', 400);
    return this.db.transaction(async tx => {
      await this.access.staff(userId, dto.branchId, tx);
      const row = (await tx.query(`INSERT INTO social.events(branch_id,organizer_id,title,description,starts_at,ends_at,capacity,ticket_price,membership_required)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [dto.branchId, userId, dto.title.trim(), dto.description, start, end, dto.capacity, dto.ticketPrice, dto.membershipRequired || false])).rows[0];
      await this.access.audit(tx, userId, 'social.event.create', 'event', row.id, requestId);
      return row;
    });
  }
  private qrToken(ticketId: string) { return `${ticketId}.${keyedDigest(`ticket:${ticketId}`, loadConfig().otpSecret)}`; }
  async buyTicket(userId: string, eventId: string, contractId: string | undefined, key: string | undefined, requestId: string) {
    return this.idem.run(userId, `ticket:${eventId}`, key, { eventId, contractId }, async tx => {
      const event = (await tx.query('SELECT * FROM social.events WHERE id=$1 FOR UPDATE', [eventId])).rows[0];
      invariant(event, 'NOT_FOUND', 'Event not found', 404);
      invariant(event.status === 'OPEN' && event.starts_at.getTime() > Date.now(), 'EVENT_CLOSED', 'Event is closed');
      const existing = (await tx.query("SELECT * FROM social.tickets WHERE event_id=$1 AND user_id=$2", [eventId, userId])).rows[0];
      const pendingLive = existing?.status === 'PENDING_PAYMENT' && existing.payment_expires_at.getTime() > Date.now();
      if (existing?.status === 'VALID') return { ...existing, qrToken: this.qrToken(existing.id) };
      if (pendingLive) return { ...existing, qrToken: null };
      invariant(existing?.status !== 'USED', 'TICKET_NOT_AVAILABLE', 'Ticket already used');
      // Seats awaiting payment are held until their deadline.
      const sold = (await tx.query(`SELECT count(*)::int AS n FROM social.tickets WHERE event_id=$1 AND user_id<>$2
        AND (status IN ('VALID','USED') OR (status='PENDING_PAYMENT' AND payment_expires_at>now()))`, [eventId, userId])).rows[0].n;
      invariant(sold < event.capacity, 'EVENT_FULL', 'Event capacity reached');
      invariant(!event.membership_required || contractId, 'MEMBERSHIP_REQUIRED', 'Event requires a membership contract');
      const paid = event.ticket_price > 0;
      const id = existing?.id || (await tx.query('SELECT gen_random_uuid() AS id')).rows[0].id;
      // A cancelled or expired ticket row is reused so one user holds at most one ticket per event.
      const row = (await tx.query(`INSERT INTO social.tickets(id,event_id,branch_id,user_id,status,qr_nonce_hash,amount,payment_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8::boolean THEN now()+interval '15 minutes' END)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,amount=excluded.amount,payment_expires_at=excluded.payment_expires_at,updated_at=now()
        RETURNING *`, [id, eventId, event.branch_id, userId, paid ? 'PENDING_PAYMENT' : 'VALID', digest(this.qrToken(id)), event.ticket_price, paid])).rows[0];
      if (event.membership_required) await this.membership.consumeForTicket(tx, userId, contractId!, id, event.branch_id);
      await emitEvent(tx, userId, paid ? 'ticket.pending_payment' : 'ticket.issued', { ticketId: id, eventId }, requestId);
      return { ...row, qrToken: paid ? null : this.qrToken(id) };
    });
  }
  async tickets(userId: string) {
    const rows = (await this.db.query('SELECT * FROM social.tickets WHERE user_id=$1 ORDER BY created_at DESC', [userId])).rows;
    return rows.map(row => ({ ...row, qrToken: row.status === 'VALID' ? this.qrToken(row.id) : null }));
  }
  async ticket(userId: string, id: string, tx: DbClient = this.db.pool) {
    const row = (await tx.query('SELECT * FROM social.tickets WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
    invariant(row, 'NOT_FOUND', 'Ticket not found', 404);
    return row;
  }
  /** Lock order is event -> ticket, the same as buyTicket. */
  async lock(tx: DbClient, id: string) {
    const ref = (await tx.query('SELECT event_id FROM social.tickets WHERE id=$1', [id])).rows[0];
    invariant(ref, 'NOT_FOUND', 'Ticket not found', 404);
    await tx.query('SELECT 1 FROM social.events WHERE id=$1 FOR UPDATE', [ref.event_id]);
    return (await tx.query('SELECT * FROM social.tickets WHERE id=$1 FOR UPDATE', [id])).rows[0];
  }
  async confirmPaid(tx: DbClient, row: any, requestId: string) {
    if (row.status !== 'PENDING_PAYMENT' || row.payment_expires_at.getTime() <= Date.now()) return false;
    await tx.query("UPDATE social.tickets SET status='VALID',updated_at=now() WHERE id=$1", [row.id]);
    await emitEvent(tx, row.user_id, 'ticket.issued', { ticketId: row.id, eventId: row.event_id }, requestId);
    row.status = 'VALID';
    return true;
  }
  async expire(tx: DbClient, row: any) {
    await tx.query("UPDATE social.tickets SET status='EXPIRED',updated_at=now() WHERE id=$1 AND status='PENDING_PAYMENT'", [row.id]);
    row.status = 'EXPIRED';
  }
  async expireDue() {
    await this.db.query("UPDATE social.tickets SET status='EXPIRED',updated_at=now() WHERE status='PENDING_PAYMENT' AND payment_expires_at<=now()");
  }
  async scan(userId: string, signedToken: string, requestId: string) {
    const [id, signature] = signedToken.split('.');
    invariant(secureEqual(keyedDigest(`ticket:${id}`, loadConfig().otpSecret), signature), 'INVALID_QR', 'QR token is invalid', 400);
    return this.db.transaction(async tx => {
      const ticket = (await tx.query(`SELECT t.*,e.ends_at,e.status AS event_status FROM social.tickets t
        JOIN social.events e ON e.id=t.event_id WHERE t.id=$1 FOR UPDATE OF t`, [id])).rows[0];
      invariant(ticket && ticket.qr_nonce_hash === digest(signedToken), 'INVALID_QR', 'QR token is invalid', 400);
      await this.access.staff(userId, ticket.branch_id, tx);
      invariant(ticket.status === 'VALID' && ticket.event_status === 'OPEN' && ticket.ends_at.getTime() > Date.now(),
        'TICKET_NOT_AVAILABLE', 'Ticket has already been used or event ended');
      await tx.query("UPDATE social.tickets SET status='USED',updated_at=now() WHERE id=$1", [id]);
      await this.access.audit(tx, userId, 'ticket.scan', 'ticket', id, requestId);
      await emitEvent(tx, ticket.user_id, 'ticket.used', { ticketId: id, eventId: ticket.event_id }, requestId);
      return { ticketId: id, status: 'USED' };
    });
  }
  async createTeam(userId: string, name: string) {
    return this.db.transaction(async tx => {
      const row = (await tx.query('INSERT INTO social.teams(owner_id,name) VALUES($1,$2) RETURNING *', [userId, name.trim()])).rows[0];
      await tx.query('INSERT INTO social.team_members(team_id,user_id) VALUES($1,$2)', [row.id, userId]);
      return row;
    });
  }
  async teams(userId: string) {
    return (await this.db.query(`SELECT t.* FROM social.teams t JOIN social.team_members m ON m.team_id=t.id WHERE m.user_id=$1 ORDER BY t.created_at DESC`, [userId])).rows;
  }
  async invitation(userId: string, teamId: string, maxUses: number) {
    return this.db.transaction(async tx => {
      const team = (await tx.query('SELECT * FROM social.teams WHERE id=$1', [teamId])).rows[0];
      invariant(team, 'NOT_FOUND', 'Team not found', 404);
      invariant(team.owner_id === userId, 'FORBIDDEN', 'Only team owner may invite', 403);
      const raw = token();
      const row = (await tx.query(`INSERT INTO social.invitations(team_id,created_by,token_hash,max_uses,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '7 days') RETURNING id,team_id,max_uses,expires_at`, [teamId, userId, digest(raw), maxUses])).rows[0];
      return { ...row, token: raw };
    });
  }
  async accept(userId: string, raw: string) {
    return this.db.transaction(async tx => {
      const invitation = (await tx.query('SELECT * FROM social.invitations WHERE token_hash=$1 FOR UPDATE', [digest(raw)])).rows[0];
      invariant(invitation && invitation.expires_at.getTime() > Date.now() && invitation.uses < invitation.max_uses,
        'INVITATION_EXPIRED', 'Invitation is expired or used', 400);
      const joined = await tx.query('INSERT INTO social.team_members(team_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING team_id', [invitation.team_id, userId]);
      if (joined.rowCount) await tx.query('UPDATE social.invitations SET uses=uses+1 WHERE id=$1', [invitation.id]);
      return { teamId: invitation.team_id, joined: Boolean(joined.rowCount) };
    });
  }
  async matches(eventId: string) {
    await this.event(eventId);
    return (await this.db.query('SELECT * FROM social.matches WHERE event_id=$1 ORDER BY created_at,id', [eventId])).rows;
  }
  async createMatch(userId: string, eventId: string, dto: CreateMatchDto, requestId: string) {
    invariant(dto.homeTeamId !== dto.awayTeamId, 'INVALID_MATCH', 'Teams must be different', 400);
    return this.db.transaction(async tx => {
      const event = (await tx.query('SELECT * FROM social.events WHERE id=$1 FOR UPDATE', [eventId])).rows[0];
      invariant(event, 'NOT_FOUND', 'Event not found', 404);
      await this.access.staff(userId, event.branch_id, tx);
      invariant(event.status === 'OPEN' && event.ends_at.getTime() > Date.now(), 'EVENT_CLOSED', 'Event is closed');
      const eligible = (await tx.query(`SELECT DISTINCT tm.team_id FROM social.team_members tm
        JOIN social.tickets t ON t.user_id=tm.user_id AND t.event_id=$1 AND t.status IN ('VALID','USED')
        WHERE tm.team_id=ANY($2::uuid[])`, [eventId, [dto.homeTeamId, dto.awayTeamId]])).rows;
      invariant(eligible.length === 2, 'TEAM_NOT_REGISTERED', 'Each team must have a ticketed participant', 409);
      const row = (await tx.query(`INSERT INTO social.matches(event_id,home_team_id,away_team_id)
        VALUES($1,$2,$3) RETURNING *`, [eventId, dto.homeTeamId, dto.awayTeamId])).rows[0];
      await this.access.audit(tx, userId, 'social.match.create', 'match', row.id, requestId);
      return row;
    });
  }
  async recordResult(userId: string, matchId: string, dto: MatchResultDto, requestId: string) {
    return this.db.transaction(async tx => {
      const row = (await tx.query(`SELECT m.*,e.branch_id,e.starts_at,e.status AS event_status
        FROM social.matches m JOIN social.events e ON e.id=m.event_id WHERE m.id=$1 FOR UPDATE OF m`, [matchId])).rows[0];
      invariant(row, 'NOT_FOUND', 'Match not found', 404);
      await this.access.staff(userId, row.branch_id, tx);
      invariant(row.event_status === 'OPEN' && row.starts_at.getTime() <= Date.now(),
        'MATCH_NOT_STARTED', 'Event must have started before recording a result', 409);
      if (row.status === 'FINISHED') {
        invariant(row.home_score === dto.homeScore && row.away_score === dto.awayScore,
          'MATCH_RESULT_LOCKED', 'Finished match result cannot be changed', 409);
        return row;
      }
      invariant(row.status === 'OPEN', 'MATCH_CLOSED', 'Match is closed', 409);
      const updated = (await tx.query(`UPDATE social.matches SET status='FINISHED',home_score=$2,away_score=$3
        WHERE id=$1 RETURNING *`, [matchId, dto.homeScore, dto.awayScore])).rows[0];
      await this.access.audit(tx, userId, 'social.match.result', 'match', matchId, requestId,
        { homeScore: dto.homeScore, awayScore: dto.awayScore });
      return updated;
    });
  }
}
