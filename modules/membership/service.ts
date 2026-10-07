import { Injectable } from '@nestjs/common';
import { Database, DbClient } from '../../packages/database';
import { Idempotency } from '../../packages/idempotency';
import { AccessService } from '../../packages/access';
import { invariant } from '../../packages/contracts/errors';
import { emitEvent } from '../../packages/events';
import { CreatePlanDto } from './dto';

@Injectable()
export class MembershipService {
  constructor(private readonly db: Database, private readonly idem: Idempotency, private readonly access: AccessService) {}
  async plans(branchId?: string) {
    return (await this.db.query('SELECT * FROM membership.plans WHERE active AND ($1::uuid IS NULL OR branch_id=$1) ORDER BY name,id', [branchId || null])).rows;
  }
  async plan(id: string) {
    const row = (await this.db.query('SELECT * FROM membership.plans WHERE id=$1 AND active', [id])).rows[0];
    invariant(row, 'NOT_FOUND', 'Membership plan not found', 404);
    return row;
  }
  async createPlan(userId: string, dto: CreatePlanDto, requestId: string) {
    return this.db.transaction(async tx => {
      await this.access.owner(userId, dto.branchId, tx);
      const branch = await tx.query('SELECT 1 FROM catalog.branches WHERE id=$1', [dto.branchId]);
      invariant(branch.rowCount, 'NOT_FOUND', 'Branch not found', 404);
      const row = (await tx.query(`INSERT INTO membership.plans(branch_id,name,price,credits,duration_days)
        VALUES($1,$2,$3,$4,$5) RETURNING *`, [dto.branchId, dto.name.trim(), dto.price, dto.credits, dto.durationDays])).rows[0];
      await this.access.audit(tx, userId, 'membership.plan.create', 'plan', row.id, requestId);
      return row;
    });
  }
  async enroll(userId: string, planId: string, key: string | undefined, requestId: string) {
    return this.idem.run(userId, `membership-enroll:${planId}`, key, { planId }, async tx => {
      const plan = (await tx.query('SELECT * FROM membership.plans WHERE id=$1 AND active FOR UPDATE', [planId])).rows[0];
      invariant(plan, 'NOT_FOUND', 'Membership plan not found', 404);
      const existing = (await tx.query(`SELECT * FROM membership.contracts WHERE user_id=$1 AND plan_id=$2
        AND ((status='ACTIVE' AND expires_at>now()) OR (status='PENDING_PAYMENT' AND payment_expires_at>now()))
        ORDER BY created_at DESC LIMIT 1`, [userId, planId])).rows[0];
      if (existing) return existing;
      if (plan.price > 0) {
        // Paid plan: the contract carries no usable credit until a signed provider notification confirms it.
        const pending = (await tx.query(`INSERT INTO membership.contracts(plan_id,branch_id,user_id,remaining_credits,status,expires_at,amount,payment_expires_at)
          VALUES($1,$2,$3,$4,'PENDING_PAYMENT',now()+($5::int * interval '1 day'),$6,now()+interval '15 minutes') RETURNING *`,
          [planId, plan.branch_id, userId, plan.credits, plan.duration_days, plan.price])).rows[0];
        await emitEvent(tx, userId, 'membership.pending_payment', { contractId: pending.id, amount: pending.amount }, requestId);
        return pending;
      }
      const row = (await tx.query(`INSERT INTO membership.contracts(plan_id,branch_id,user_id,remaining_credits,status,expires_at)
        VALUES($1,$2,$3,$4,'ACTIVE',now()+($5::int * interval '1 day')) RETURNING *`,
        [planId, plan.branch_id, userId, plan.credits, plan.duration_days])).rows[0];
      await emitEvent(tx, userId, 'membership.activated', { contractId: row.id }, requestId);
      return row;
    });
  }
  async contracts(userId: string) {
    return (await this.db.query('SELECT * FROM membership.contracts WHERE user_id=$1 ORDER BY created_at DESC', [userId])).rows;
  }
  async get(userId: string, contractId: string, tx: DbClient = this.db.pool) {
    const row = (await tx.query('SELECT * FROM membership.contracts WHERE id=$1 AND user_id=$2', [contractId, userId])).rows[0];
    invariant(row, 'NOT_FOUND', 'Membership contract not found', 404);
    return row;
  }
  async usages(userId: string, contractId: string) {
    await this.get(userId, contractId);
    return (await this.db.query('SELECT * FROM membership.usages WHERE contract_id=$1 AND user_id=$2 ORDER BY created_at DESC', [contractId, userId])).rows;
  }
  async lock(tx: DbClient, id: string) {
    const row = (await tx.query('SELECT * FROM membership.contracts WHERE id=$1 FOR UPDATE', [id])).rows[0];
    invariant(row, 'NOT_FOUND', 'Membership contract not found', 404);
    return row;
  }
  /** The membership term starts when the payment is confirmed, not when checkout began. */
  async confirmPaid(tx: DbClient, row: any, requestId: string) {
    if (row.status !== 'PENDING_PAYMENT' || row.payment_expires_at.getTime() <= Date.now()) return false;
    await tx.query(`UPDATE membership.contracts c SET status='ACTIVE',starts_at=now(),expires_at=now()+(p.duration_days * interval '1 day'),
      updated_at=now(),version=c.version+1 FROM membership.plans p WHERE c.id=$1 AND p.id=c.plan_id`, [row.id]);
    await emitEvent(tx, row.user_id, 'membership.activated', { contractId: row.id }, requestId);
    row.status = 'ACTIVE';
    return true;
  }
  async expire(tx: DbClient, row: any) {
    await tx.query("UPDATE membership.contracts SET status='EXPIRED',updated_at=now(),version=version+1 WHERE id=$1 AND status='PENDING_PAYMENT'", [row.id]);
    row.status = 'EXPIRED';
  }
  async expireDue() {
    await this.db.query("UPDATE membership.contracts SET status='EXPIRED',updated_at=now(),version=version+1 WHERE status='PENDING_PAYMENT' AND payment_expires_at<=now()");
  }
  async consumeForTicket(tx: DbClient, userId: string, contractId: string, ticketId: string, branchId: string) {
    const contract = (await tx.query(`UPDATE membership.contracts SET remaining_credits=remaining_credits-1,updated_at=now(),version=version+1
      WHERE id=$1 AND user_id=$2 AND branch_id=$3 AND status='ACTIVE' AND expires_at>now() AND remaining_credits>0
      RETURNING *`, [contractId, userId, branchId])).rows[0];
    invariant(contract, 'MEMBERSHIP_UNAVAILABLE', 'Membership has no usable credit for this branch');
    await tx.query('INSERT INTO membership.usages(contract_id,user_id,ticket_id,credits) VALUES($1,$2,$3,1)', [contractId, userId, ticketId]);
    return contract;
  }
}
