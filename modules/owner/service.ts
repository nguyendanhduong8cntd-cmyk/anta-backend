import { Injectable } from '@nestjs/common';
import { Database } from '../../packages/database';
import { AccessService } from '../../packages/access';
import { CatalogService } from '../catalog/service';
import { invariant } from '../../packages/contracts/errors';
import { BlockDto, OwnerBookingQuery, OwnerScheduleQuery } from './dto';

const PAGE = 20;
/** A booking as the owner portal shows it: slot, money and who booked it, nothing more than the screens need. */
const OWNER_BOOKING_ROW = `b.id,b.yard_id,y.name AS yard_name,b.starts_at,b.ends_at,b.amount,b.currency,b.status,b.source,
  b.confirm_deadline_at,b.created_at,u.display_name AS customer_name,u.identifier AS customer_contact`;

@Injectable()
export class OwnerService {
  constructor(private readonly db: Database, private readonly access: AccessService, private readonly catalog: CatalogService) {}

  async myBranches(userId: string) {
    return (await this.db.query(`SELECT DISTINCT br.id,br.name,br.address FROM identity.roles r
      JOIN catalog.branches br ON br.id=r.branch_id WHERE r.user_id=$1 AND r.role IN ('branch_owner','branch_staff')
      ORDER BY br.name`, [userId])).rows;
  }

  /** The day bounds of `date` expressed in the branch's own timezone, as UTC instants ready for range queries. */
  private async dayBounds(branchId: string, date: string) {
    const row = (await this.db.query(`SELECT b.timezone,b.opening_hour,b.closing_hour,b.name,
      ($1::date::timestamp AT TIME ZONE b.timezone) AS day_start,
      (($1::date + 1)::timestamp AT TIME ZONE b.timezone) AS day_end
      FROM catalog.branches b WHERE b.id=$2`, [date, branchId])).rows[0];
    invariant(row, 'NOT_FOUND', 'Branch not found', 404);
    return row;
  }

  async schedule(userId: string, q: OwnerScheduleQuery) {
    await this.access.staff(userId, q.branchId);
    const branch = await this.dayBounds(q.branchId, q.date);
    const courts = (await this.db.query(`SELECT y.id AS court_id,y.name,y.sport_id,s.slug AS sport_slug,s.name AS sport_name
      FROM catalog.yards y JOIN catalog.sports s ON s.id=y.sport_id
      WHERE y.branch_id=$1 AND y.active AND ($2::uuid IS NULL OR y.sport_id=$2) AND ($3::uuid IS NULL OR y.id=$3)
      ORDER BY y.name`, [q.branchId, q.sportId || null, q.courtId || null])).rows;
    const bookings = (await this.db.query(`SELECT ${OWNER_BOOKING_ROW} FROM booking.bookings b
      JOIN catalog.yards y ON y.id=b.yard_id JOIN identity.users u ON u.id=b.user_id
      WHERE b.branch_id=$1 AND b.status IN ('PENDING_PAYMENT','PENDING_OWNER_CONFIRMATION','CONFIRMED')
      AND tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)')
      AND ($4::uuid IS NULL OR b.yard_id=$4) ORDER BY b.starts_at`,
      [q.branchId, branch.day_start, branch.day_end, q.courtId || null])).rows;
    const blocks = (await this.db.query(`SELECT bl.id,bl.yard_id,bl.starts_at,bl.ends_at,bl.reason,bl.created_at FROM booking.blocks bl
      JOIN catalog.yards y ON y.id=bl.yard_id WHERE y.branch_id=$1 AND bl.active
      AND tstzrange(bl.starts_at,bl.ends_at,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)')
      AND ($4::uuid IS NULL OR bl.yard_id=$4) ORDER BY bl.starts_at`,
      [q.branchId, branch.day_start, branch.day_end, q.courtId || null])).rows;
    return { date: q.date, branch: { id: q.branchId, name: branch.name, timezone: branch.timezone,
      openingHour: branch.opening_hour, closingHour: branch.closing_hour }, courts, bookings, blocks };
  }

  async bookings(userId: string, q: OwnerBookingQuery) {
    await this.access.staff(userId, q.branchId);
    const page = q.page || 1, pageSize = q.pageSize || PAGE;
    const tz = (await this.db.query('SELECT timezone FROM catalog.branches WHERE id=$1', [q.branchId])).rows[0]?.timezone;
    invariant(tz, 'NOT_FOUND', 'Branch not found', 404);
    const from = q.fromDate ? (await this.db.query('SELECT $1::date::timestamp AT TIME ZONE $2 AS v', [q.fromDate, tz])).rows[0].v : null;
    const to = q.toDate ? (await this.db.query("SELECT ($1::date+1)::timestamp AT TIME ZONE $2 AS v", [q.toDate, tz])).rows[0].v : null;
    const keyword = q.q ? q.q.trim().replace(/[%_\\]/g, '\\$&') : null;
    const rows = (await this.db.query(`SELECT count(*) OVER()::int AS total,${OWNER_BOOKING_ROW} FROM booking.bookings b
      JOIN catalog.yards y ON y.id=b.yard_id JOIN identity.users u ON u.id=b.user_id
      WHERE b.branch_id=$1
      AND ($2::timestamptz IS NULL OR b.starts_at>=$2) AND ($3::timestamptz IS NULL OR b.starts_at<$3)
      AND ($4::uuid IS NULL OR b.yard_id=$4) AND ($5::text IS NULL OR b.status=$5) AND ($6::text IS NULL OR b.source=$6)
      AND ($7::text IS NULL OR u.display_name ILIKE '%'||$7||'%' OR u.identifier ILIKE '%'||$7||'%' OR b.id::text=$7)
      ORDER BY b.created_at DESC,b.id LIMIT $8 OFFSET $9`,
      [q.branchId, from, to, q.courtId || null, q.status || null, q.source || null, keyword, pageSize, (page - 1) * pageSize])).rows;
    return { items: rows.map(({ total, ...row }) => row), page, pageSize, total: rows[0]?.total || 0 };
  }

  async stats(userId: string, branchId: string) {
    await this.access.staff(userId, branchId);
    const tz = (await this.db.query('SELECT timezone FROM catalog.branches WHERE id=$1', [branchId])).rows[0]?.timezone;
    invariant(tz, 'NOT_FOUND', 'Branch not found', 404);
    const row = (await this.db.query(`SELECT
      count(*) FILTER (WHERE status='PENDING_OWNER_CONFIRMATION')::int AS pending_confirmation,
      count(*) FILTER (WHERE status='CONFIRMED' AND (starts_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date)::int AS today,
      count(*) FILTER (WHERE status='CONFIRMED' AND starts_at>now())::int AS upcoming,
      count(*) FILTER (WHERE status='CANCELLED' AND updated_at>=date_trunc('week',now() AT TIME ZONE $2) AT TIME ZONE $2)::int AS cancelled_this_week
      FROM booking.bookings WHERE branch_id=$1`, [branchId, tz])).rows[0];
    return { pendingConfirmation: row.pending_confirmation, today: row.today, upcoming: row.upcoming, cancelledThisWeek: row.cancelled_this_week };
  }

  async detail(userId: string, id: string) {
    const row = (await this.db.query(`SELECT b.*,y.name AS yard_name,y.hourly_price,s.id AS sport_id,s.name AS sport_name,s.slug AS sport_slug,
      br.name AS branch_name,br.timezone AS branch_timezone,
      u.display_name AS customer_name,u.identifier AS customer_contact
      FROM booking.bookings b JOIN catalog.yards y ON y.id=b.yard_id JOIN catalog.sports s ON s.id=y.sport_id
      JOIN catalog.branches br ON br.id=b.branch_id JOIN identity.users u ON u.id=b.user_id WHERE b.id=$1`, [id])).rows[0];
    invariant(row, 'NOT_FOUND', 'Booking not found', 404);
    await this.access.staff(userId, row.branch_id);
    const services = (await this.db.query(`SELECT bs.service_id,c.name,bs.quantity,bs.unit_price,(bs.quantity*bs.unit_price) AS subtotal
      FROM booking.services bs JOIN catalog.services c ON c.id=bs.service_id WHERE bs.booking_id=$1 ORDER BY bs.created_at`, [id])).rows;
    const intent = (await this.db.query(`SELECT id,status,amount,currency,created_at,updated_at FROM payment.intents
      WHERE booking_id=$1 ORDER BY created_at DESC LIMIT 1`, [id])).rows[0] || null;
    const paid = (await this.db.query(`SELECT coalesce(sum(t.amount),0)::bigint AS paid FROM payment.transactions t
      JOIN payment.intents i ON i.id=t.intent_id WHERE i.booking_id=$1`, [id])).rows[0];
    const history = (await this.db.query(`SELECT from_status,to_status,reason,actor_id,created_at FROM booking.status_history
      WHERE booking_id=$1 ORDER BY created_at`, [id])).rows;
    const refund = (await this.db.query(`SELECT r.amount,r.percent,r.status,r.reason,r.created_at FROM payment.refunds r
      JOIN payment.intents i ON i.id=r.intent_id WHERE i.booking_id=$1 ORDER BY r.created_at DESC LIMIT 1`, [id])).rows[0] || null;
    const hours = Math.round((new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()) / 3600000);
    const servicesTotal = services.reduce((sum: number, s: any) => sum + Number(s.subtotal), 0);
    return { ...row, hours, courtAmount: row.hourly_price * hours, servicesTotal, services,
      paymentIntent: intent, paidAmount: String(paid.paid), outstanding: String(Math.max(0, Number(row.amount) - Number(paid.paid))),
      statusHistory: history, refund,
      canConfirm: row.status === 'PENDING_OWNER_CONFIRMATION' && row.confirm_deadline_at && new Date(row.confirm_deadline_at).getTime() > Date.now(),
      canReject: row.status === 'PENDING_OWNER_CONFIRMATION' };
  }

  // ---- maintenance blocks ----
  async listBlocks(userId: string, courtId: string, date?: string) {
    const yard = await this.catalog.yard(this.db.pool, courtId);
    await this.access.staff(userId, yard.branch_id);
    if (date) {
      const bounds = await this.dayBounds(yard.branch_id, date);
      return (await this.db.query(`SELECT id,yard_id,starts_at,ends_at,reason,created_at FROM booking.blocks
        WHERE yard_id=$1 AND active AND tstzrange(starts_at,ends_at,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)')
        ORDER BY starts_at`, [courtId, bounds.day_start, bounds.day_end])).rows;
    }
    return (await this.db.query(`SELECT id,yard_id,starts_at,ends_at,reason,created_at FROM booking.blocks
      WHERE yard_id=$1 AND active ORDER BY starts_at DESC LIMIT 200`, [courtId])).rows;
  }

  async createBlock(userId: string, courtId: string, dto: BlockDto, requestId: string) {
    return this.db.transaction(async tx => {
      const yard = await this.catalog.yard(tx, courtId, true);
      await this.access.staff(userId, yard.branch_id, tx);
      const start = new Date(dto.startsAt), end = new Date(dto.endsAt);
      invariant(Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && end.getTime() > start.getTime(),
        'INVALID_BLOCK_RANGE', 'endsAt must be after startsAt', 400);
      invariant(start.getTime() > Date.now() - 3600000, 'INVALID_BLOCK_RANGE', 'Cannot lock a time already in the past', 400);
      const open = (await tx.query(`SELECT extract(hour FROM $1::timestamptz AT TIME ZONE $3)>=$4
        AND extract(hour FROM ($2::timestamptz-interval '1 millisecond') AT TIME ZONE $3)<$5 AS valid`,
        [start, end, yard.timezone, yard.opening_hour, yard.closing_hour])).rows[0].valid;
      invariant(open, 'OUTSIDE_OPENING_HOURS', 'Block must be within branch opening hours', 400);
      const block = (await tx.query(`INSERT INTO booking.blocks(yard_id,starts_at,ends_at,reason,created_by)
        VALUES($1,$2,$3,$4,$5) RETURNING *`, [courtId, start, end, dto.reason.trim(), userId])).rows[0];
      // Shares the same exclusion constraint as holds/bookings: a conflicting booking or block raises 23P01 -> 409.
      await tx.query('INSERT INTO booking.reservations(yard_id,block_id,starts_at,ends_at) VALUES($1,$2,$3,$4)',
        [courtId, block.id, start, end]);
      await this.access.audit(tx, userId, 'court.block_create', 'court_block', block.id, requestId, { courtId, reason: dto.reason });
      return block;
    });
  }

  async releaseBlock(userId: string, id: string, requestId: string) {
    return this.db.transaction(async tx => {
      const block = (await tx.query('SELECT * FROM booking.blocks WHERE id=$1 FOR UPDATE', [id])).rows[0];
      invariant(block, 'NOT_FOUND', 'Block not found', 404);
      const yard = await this.catalog.yard(tx, block.yard_id, true);
      await this.access.staff(userId, yard.branch_id, tx);
      invariant(block.active, 'BLOCK_ALREADY_RELEASED', 'Block has already been released');
      await tx.query('UPDATE booking.blocks SET active=false,released_at=now(),released_by=$2 WHERE id=$1', [id, userId]);
      await tx.query('UPDATE booking.reservations SET active=false WHERE block_id=$1', [id]);
      await this.access.audit(tx, userId, 'court.block_release', 'court_block', id, requestId);
      return { released: true };
    });
  }
}
