import { Global, Injectable, Module } from '@nestjs/common';
import { Database, DbClient, DatabaseModule } from '../../packages/database';
import { AccessService } from '../../packages/access';
import { Config, loadConfig } from '../../packages/config';
import { invariant } from '../../packages/contracts/errors';
import { emitEvent } from '../../packages/events';
import { executeRefund } from './providers';

type Policy = Config['refund'];
/** Share of a paid booking returned when the user cancels `hoursBefore` hours ahead of the slot. 0 = cancellation closed. */
export function bookingRefundPercent(startsAt: Date, now: number, policy: Policy) {
  const hoursBefore = (startsAt.getTime() - now) / 3600000;
  if (hoursBefore >= policy.fullHours) return 100;
  return hoursBefore >= policy.partialHours ? policy.partialPercent : 0;
}
/** Service orders are fully refundable for a fixed window after payment. */
export const orderRefundPercent = (paidAt: Date, now: number, policy: Policy) => (now - paidAt.getTime()) / 3600000 <= policy.orderHours ? 100 : 0;
export const refundAmount = (amount: number, percent: number) => Math.floor(amount * percent / 100);

@Injectable()
export class RefundService {
  constructor(private readonly db: Database, private readonly access: AccessService) {}
  readonly policy = loadConfig().refund;
  private column(target: string) {
    const column = ({ booking: 'booking_id', order: 'order_id' } as Record<string, string>)[target];
    invariant(column, 'INVALID_PAYMENT_TARGET', 'Unknown payment target', 400);
    return column;
  }
  /** Records a refund for the settled intent of a target. Caller already holds the target row lock. Returns null when nothing was paid. */
  async request(tx: DbClient, target: string, targetId: string, percent: number, reason: string, requestId?: string) {
    invariant(Number.isInteger(percent) && percent >= 1 && percent <= 100, 'INVALID_REFUND', 'Refund percent is invalid', 400);
    const intent = (await tx.query(`SELECT * FROM payment.intents WHERE ${this.column(target)}=$1 AND status='SUCCEEDED' FOR UPDATE`, [targetId])).rows[0];
    if (!intent) return null;
    const existing = (await tx.query('SELECT * FROM payment.refunds WHERE intent_id=$1', [intent.id])).rows[0];
    if (existing) return existing;
    const row = (await tx.query(`INSERT INTO payment.refunds(intent_id,user_id,amount,currency,percent,reason)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [intent.id, intent.user_id, refundAmount(intent.amount, percent), intent.currency, percent, reason])).rows[0];
    await emitEvent(tx, intent.user_id, 'refund.pending', { refundId: row.id, paymentIntentId: intent.id, amount: row.amount }, requestId);
    // Sandbox moves no money, so it settles inside the same transaction. Real providers are called by the worker.
    return intent.provider === 'sandbox' ? this.settle(tx, row, await executeRefund(loadConfig(), 'sandbox', this.providerRequest(row, intent, null))) : row;
  }
  private providerRequest(refund: any, intent: any, transaction: any) {
    return { refundId: refund.id, orderCode: String(intent.order_code || ''), amount: refund.amount, full: refund.amount === intent.amount,
      providerRef: transaction?.provider_ref, paidAt: transaction?.provider_paid_at, reason: refund.reason };
  }
  private async settle(tx: DbClient, refund: any, outcome: { status: string; providerRef?: string }, actorId?: string) {
    const row = (await tx.query(`UPDATE payment.refunds SET status=$2,provider_ref=coalesce($3,provider_ref),attempts=attempts+1,
      resolved_by=coalesce($4,resolved_by),updated_at=now() WHERE id=$1 RETURNING *`, [refund.id, outcome.status, outcome.providerRef || null, actorId || null])).rows[0];
    if (outcome.status !== 'PENDING') await emitEvent(tx, row.user_id, `refund.${outcome.status.toLowerCase()}`,
      { refundId: row.id, paymentIntentId: row.intent_id, amount: row.amount, status: row.status });
    return row;
  }
  /** Worker entry point: push pending refunds to the provider. A provider error leaves the row PENDING for the next tick. */
  async processPending() {
    const ids = (await this.db.query("SELECT id FROM payment.refunds WHERE status='PENDING' AND attempts<8 ORDER BY created_at LIMIT 20")).rows;
    for (const { id } of ids) await this.db.transaction(async tx => {
      const refund = (await tx.query("SELECT * FROM payment.refunds WHERE id=$1 AND status='PENDING' FOR UPDATE SKIP LOCKED", [id])).rows[0];
      if (!refund) return;
      const intent = (await tx.query('SELECT * FROM payment.intents WHERE id=$1', [refund.intent_id])).rows[0];
      const transaction = (await tx.query('SELECT * FROM payment.transactions WHERE intent_id=$1', [refund.intent_id])).rows[0];
      let outcome: { status: string; providerRef?: string };
      try { outcome = await executeRefund(loadConfig(), intent.provider, this.providerRequest(refund, intent, transaction)); }
      catch { outcome = { status: refund.attempts >= 7 ? 'MANUAL_REVIEW' : 'PENDING' }; }
      await this.settle(tx, refund, outcome);
    });
    return ids.length;
  }
  async mine(userId: string) {
    return (await this.db.query('SELECT id,intent_id,amount,currency,percent,reason,status,created_at,updated_at FROM payment.refunds WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [userId])).rows;
  }
  // ---- admin ----
  async list(actorId: string, status?: string) {
    await this.access.admin(actorId);
    return (await this.db.query(`SELECT r.*,i.provider,i.order_code,i.booking_id,i.order_id
      FROM payment.refunds r JOIN payment.intents i ON i.id=r.intent_id WHERE ($1::text IS NULL OR r.status=$1)
      ORDER BY r.created_at DESC LIMIT 200`, [status || null])).rows;
  }
  /** An admin records the result of a refund that had to be paid out by hand (PayOS, failed provider calls). */
  async resolve(actorId: string, refundId: string, outcome: 'SUCCEEDED' | 'FAILED', providerRef: string | undefined, requestId: string) {
    return this.db.transaction(async tx => {
      await this.access.admin(actorId, tx);
      const refund = (await tx.query('SELECT * FROM payment.refunds WHERE id=$1 FOR UPDATE', [refundId])).rows[0];
      invariant(refund, 'NOT_FOUND', 'Refund not found', 404);
      invariant(refund.status !== 'SUCCEEDED', 'REFUND_ALREADY_SETTLED', 'Refund has already been paid out');
      const row = await this.settle(tx, refund, { status: outcome, providerRef }, actorId);
      await this.access.audit(tx, actorId, 'refund.resolve', 'refund', refundId, requestId, { outcome, providerRef: providerRef || null });
      return row;
    });
  }
  /** Refund a payment that arrived after its deadline (intent NEEDS_REVIEW): the money was taken but nothing was delivered. */
  async refundLatePayment(actorId: string, intentId: string, requestId: string) {
    return this.db.transaction(async tx => {
      await this.access.admin(actorId, tx);
      const intent = (await tx.query('SELECT * FROM payment.intents WHERE id=$1 FOR UPDATE', [intentId])).rows[0];
      invariant(intent, 'NOT_FOUND', 'Payment intent not found', 404);
      invariant(intent.status === 'NEEDS_REVIEW', 'INTENT_NOT_REVIEWABLE', 'Only late payments awaiting review can be refunded here');
      const existing = (await tx.query('SELECT * FROM payment.refunds WHERE intent_id=$1', [intentId])).rows[0];
      if (existing) return existing;
      let row = (await tx.query(`INSERT INTO payment.refunds(intent_id,user_id,amount,currency,percent,reason)
        VALUES($1,$2,$3,$4,100,'payment received after deadline') RETURNING *`, [intentId, intent.user_id, intent.amount, intent.currency])).rows[0];
      await emitEvent(tx, intent.user_id, 'refund.pending', { refundId: row.id, paymentIntentId: intentId, amount: row.amount }, requestId);
      if (intent.provider === 'sandbox') row = await this.settle(tx, row, await executeRefund(loadConfig(), 'sandbox', this.providerRequest(row, intent, null)));
      await this.access.audit(tx, actorId, 'refund.late_payment', 'payment_intent', intentId, requestId);
      return row;
    });
  }
}
@Global()
@Module({ imports: [DatabaseModule], providers: [RefundService], exports: [RefundService] })
export class RefundModule {}
