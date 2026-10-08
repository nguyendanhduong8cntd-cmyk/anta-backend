import { Injectable } from '@nestjs/common';
import { Database } from '../../packages/database';
import { AccessService } from '../../packages/access';
import { invariant } from '../../packages/contracts/errors';
import { AdminListQuery, RoleDto } from './dto';
const PAGE = 50;
@Injectable()
export class AdminService {
  constructor(private readonly db: Database, private readonly access: AccessService) {}
  private validate(dto: RoleDto) {
    const global = dto.role === 'admin' || dto.role === 'support';
    invariant(global ? !dto.branchId : Boolean(dto.branchId), 'INVALID_ROLE_SCOPE', 'Role scope is invalid', 400);
  }
  async grant(actorId: string, dto: RoleDto, requestId: string) {
    this.validate(dto);
    return this.db.transaction(async tx => {
      await this.access.admin(actorId, tx);
      const target = await tx.query("SELECT 1 FROM identity.users WHERE id=$1 AND status='ACTIVE'", [dto.userId]);
      invariant(target.rowCount, 'NOT_FOUND', 'Active user not found', 404);
      if (dto.branchId) {
        const branch = await tx.query('SELECT 1 FROM catalog.branches WHERE id=$1', [dto.branchId]);
        invariant(branch.rowCount, 'NOT_FOUND', 'Branch not found', 404);
      }
      await tx.query('INSERT INTO identity.roles(user_id,role,branch_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [dto.userId, dto.role, dto.branchId || null]);
      await this.access.audit(tx, actorId, 'role.grant', 'user', dto.userId, requestId,
        { role: dto.role, branchId: dto.branchId || null });
      return { userId: dto.userId, role: dto.role, branchId: dto.branchId || null, granted: true };
    });
  }
  async revoke(actorId: string, dto: RoleDto, requestId: string) {
    this.validate(dto);
    return this.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['admin-role-changes']);
      await this.access.admin(actorId, tx);
      if (dto.role === 'admin') {
        const count = (await tx.query(`SELECT count(*)::int AS n FROM identity.roles r
          JOIN identity.users u ON u.id=r.user_id WHERE r.role='admin' AND u.status='ACTIVE'`)).rows[0].n;
        invariant(count > 1, 'LAST_ADMIN', 'Cannot remove the last administrator', 409);
      }
      const result = await tx.query('DELETE FROM identity.roles WHERE user_id=$1 AND role=$2 AND branch_id IS NOT DISTINCT FROM $3::uuid',
        [dto.userId, dto.role, dto.branchId || null]);
      if (result.rowCount) await this.access.audit(tx, actorId, 'role.revoke', 'user', dto.userId, requestId,
        { role: dto.role, branchId: dto.branchId || null });
      return { revoked: Boolean(result.rowCount) };
    });
  }
  async stats(actorId: string) {
    await this.access.admin(actorId);
    const one = async (sql: string) => (await this.db.query(sql)).rows[0];
    const [users, bookings, revenue, refunds, review, deletions] = await Promise.all([
      one("SELECT count(*) FILTER (WHERE status='ACTIVE')::int AS active,count(*)::int AS total FROM identity.users"),
      one(`SELECT count(*) FILTER (WHERE status='CONFIRMED')::int AS confirmed,count(*) FILTER (WHERE status='PENDING_PAYMENT')::int AS pending,
        count(*) FILTER (WHERE status='CANCELLED')::int AS cancelled,count(*)::int AS total FROM booking.bookings`),
      one("SELECT coalesce(sum(amount),0)::bigint AS paid,count(*)::int AS payments FROM payment.intents WHERE status='SUCCEEDED'"),
      one(`SELECT count(*) FILTER (WHERE status IN ('PENDING','MANUAL_REVIEW','FAILED'))::int AS open,
        coalesce(sum(amount) FILTER (WHERE status='SUCCEEDED'),0)::bigint AS refunded FROM payment.refunds`),
      one("SELECT count(*)::int AS n FROM payment.intents i WHERE status='NEEDS_REVIEW' AND NOT EXISTS(SELECT 1 FROM payment.refunds r WHERE r.intent_id=i.id)"),
      one('SELECT count(*)::int AS n FROM identity.deletion_requests WHERE completed_at IS NULL')]);
    return { users, bookings, payments: { count: revenue.payments, paid: String(revenue.paid), refunded: String(refunds.refunded) },
      openRefunds: refunds.open, latePaymentsToReview: review.n, pendingDeletions: deletions.n };
  }
  async users(actorId: string, q: AdminListQuery) {
    await this.access.admin(actorId);
    return (await this.db.query(`SELECT u.id,u.identifier,u.display_name,u.status,u.created_at,
      coalesce((SELECT jsonb_agg(jsonb_build_object('role',r.role,'branchId',r.branch_id)) FROM identity.roles r WHERE r.user_id=u.id),'[]') AS roles
      FROM identity.users u WHERE ($1::text IS NULL OR u.identifier ILIKE '%'||$1||'%' OR u.display_name ILIKE '%'||$1||'%' OR u.id::text=$1)
      AND ($2::text IS NULL OR u.status=$2) ORDER BY u.created_at DESC LIMIT $3 OFFSET $4`,
      [q.q?.replace(/[%_\\]/g, '\\$&') || null, q.status || null, PAGE, ((q.page || 1) - 1) * PAGE])).rows;
  }
  async branches(actorId: string) {
    await this.access.admin(actorId);
    return (await this.db.query('SELECT id,name,address FROM catalog.branches ORDER BY name LIMIT 500')).rows;
  }
  async bookings(actorId: string, q: AdminListQuery) {
    await this.access.admin(actorId);
    return (await this.db.query(`SELECT b.id,b.user_id,u.identifier,br.name AS branch,y.name AS yard,b.starts_at,b.ends_at,b.amount,b.currency,b.status,b.created_at
      FROM booking.bookings b JOIN identity.users u ON u.id=b.user_id JOIN catalog.branches br ON br.id=b.branch_id JOIN catalog.yards y ON y.id=b.yard_id
      WHERE ($1::text IS NULL OR b.status=$1) ORDER BY b.created_at DESC LIMIT $2 OFFSET $3`, [q.status || null, PAGE, ((q.page || 1) - 1) * PAGE])).rows;
  }
  async intents(actorId: string, q: AdminListQuery) {
    await this.access.admin(actorId);
    return (await this.db.query(`SELECT i.id,i.user_id,u.identifier,i.provider,i.order_code::text AS order_code,i.amount,i.currency,i.status,i.created_at,i.updated_at,
      CASE WHEN i.booking_id IS NOT NULL THEN 'booking' ELSE 'order' END AS target,
      (SELECT r.status FROM payment.refunds r WHERE r.intent_id=i.id) AS refund_status
      FROM payment.intents i JOIN identity.users u ON u.id=i.user_id WHERE ($1::text IS NULL OR i.status=$1)
      ORDER BY i.created_at DESC LIMIT $2 OFFSET $3`, [q.status || null, PAGE, ((q.page || 1) - 1) * PAGE])).rows;
  }
  async deletions(actorId: string) {
    await this.access.admin(actorId);
    return (await this.db.query(`SELECT d.user_id,u.status,d.requested_at,d.purge_after,d.completed_at,d.purge_summary
      FROM identity.deletion_requests d JOIN identity.users u ON u.id=d.user_id ORDER BY d.requested_at DESC LIMIT 200`)).rows;
  }
  async audit(actorId: string) {
    await this.access.admin(actorId);
    return (await this.db.query(`SELECT id,actor_id,action,target_type,target_id,request_id,details,created_at
      FROM platform.audit_events ORDER BY id DESC LIMIT 100`)).rows;
  }
}
