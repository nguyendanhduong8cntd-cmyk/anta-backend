import { Injectable } from '@nestjs/common';
import { Database, DbClient } from '../../packages/database';
import { Idempotency } from '../../packages/idempotency';
import { AccessService } from '../../packages/access';
import { ApiError, invariant } from '../../packages/contracts/errors';
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
      if (plan.price > 0) throw new ApiError('PAYMENT_PROVIDER_REQUIRED', 'Paid membership purchase is not configured', 503);
      const existing = (await tx.query(`SELECT * FROM membership.contracts WHERE user_id=$1 AND plan_id=$2
        AND status='ACTIVE' AND expires_at>now() ORDER BY created_at DESC LIMIT 1`, [userId, planId])).rows[0];
      if (existing) return existing;
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
  async get(userId: string, contractId: string) {
    const row = (await this.db.query('SELECT * FROM membership.contracts WHERE id=$1 AND user_id=$2', [contractId, userId])).rows[0];
    invariant(row, 'NOT_FOUND', 'Membership contract not found', 404);
    return row;
  }
  async usages(userId: string, contractId: string) {
    await this.get(userId, contractId);
    return (await this.db.query('SELECT * FROM membership.usages WHERE contract_id=$1 AND user_id=$2 ORDER BY created_at DESC', [contractId, userId])).rows;
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
