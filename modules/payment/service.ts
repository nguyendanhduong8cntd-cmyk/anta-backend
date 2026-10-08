import { Injectable } from '@nestjs/common';
import { Database, DbClient } from '../../packages/database';
import { Idempotency } from '../../packages/idempotency';
import { emitEvent } from '../../packages/events';
import { digest, secureEqual } from '../../packages/auth/crypto';
import { loadConfig } from '../../packages/config';
import { ApiError, invariant } from '../../packages/contracts/errors';
import { BookingService } from '../booking/service';
import { CommerceService } from '../commerce/service';
import { IntentDto, SandboxWebhookDto } from './dto';
import { verifyWebhook } from './signature';
import { createCheckout, payosWebhook, ProviderPayment, vnpayIpn } from './providers';

const TARGETS = { bookingId: 'booking_id', orderId: 'order_id' } as const;
type TargetColumn = typeof TARGETS[keyof typeof TARGETS];
/** A payable thing: lock it, confirm it on payment, or close it when the money arrives too late. */
interface Target {
  label: string;
  owned(userId: string, id: string, tx: DbClient): Promise<unknown>;
  lock(tx: DbClient, id: string): Promise<any>;
  confirm(tx: DbClient, row: any, requestId: string): Promise<boolean>;
  expireLate(tx: DbClient, row: any, requestId: string): Promise<unknown>;
}
@Injectable()
export class PaymentService {
  private readonly targets: Record<TargetColumn, Target>;
  constructor(private readonly db: Database, private readonly idem: Idempotency,
    private readonly bookings: BookingService, private readonly commerce: CommerceService) {
    this.targets = {
      booking_id: { label: 'Dat san', owned: (u, id, tx) => bookings.get(u, id, tx), lock: (tx, id) => bookings.lock(tx, id),
        confirm: (tx, row, r) => bookings.confirm(tx, row, r),
        expireLate: async (tx, row, r) => { await bookings.transition(tx, row, 'EXPIRED', 'payment received after deadline', undefined, r);
          await tx.query('UPDATE booking.reservations SET active=false WHERE booking_id=$1', [row.id]); } },
      order_id: { label: 'Don hang', owned: (u, id, tx) => commerce.get(u, id, tx), lock: (tx, id) => commerce.lock(tx, id),
        confirm: (tx, row, r) => commerce.confirm(tx, row, r),
        expireLate: (tx, row, r) => commerce.transition(tx, row, 'EXPIRED', 'payment received after deadline', undefined, r) }
    };
  }
  private resolve(dto: IntentDto) {
    const given = (Object.keys(TARGETS) as (keyof typeof TARGETS)[]).filter(key => dto[key]);
    invariant(given.length === 1, 'INVALID_PAYMENT_TARGET', 'Specify exactly one of bookingId or orderId', 400);
    return { column: TARGETS[given[0]], id: dto[given[0]]! };
  }
  private view(intent: any) {
    return { ...intent, order_code: intent.order_code === null ? null : String(intent.order_code), sandbox: intent.provider === 'sandbox',
      checkoutUrl: intent.checkout_url, qrCode: intent.qr_code };
  }
  async create(userId: string, dto: IntentDto, key: string | undefined, clientIp = '127.0.0.1') {
    const { column, id } = this.resolve(dto), target = this.targets[column], config = loadConfig();
    return this.idem.run(userId, 'payment-intent', key, dto, async tx => {
      await target.owned(userId, id, tx);
      const subject = await target.lock(tx, id);
      invariant(subject.status === 'PENDING_PAYMENT' && subject.payment_expires_at?.getTime() > Date.now() && subject.amount > 0,
        'TARGET_NOT_PAYABLE', 'This item cannot be paid');
      const existing = (await tx.query(`SELECT * FROM payment.intents WHERE ${column}=$1 AND status IN ('CREATED','SUCCEEDED') ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];
      if (existing) return this.view(existing);
      const intent = (await tx.query(`INSERT INTO payment.intents(user_id,${column},provider,amount,currency,expires_at,order_code)
        VALUES($1,$2,$3,$4,$5,$6,nextval('payment.order_code_seq')) RETURNING *`,
        [userId, id, config.paymentProvider, subject.amount, subject.currency, subject.payment_expires_at])).rows[0];
      // The provider call runs inside the transaction: a rejected checkout leaves no intent behind.
      const checkout = await createCheckout(config, { orderCode: String(intent.order_code), amount: intent.amount,
        description: `${target.label} ${intent.order_code}`, expiresAt: intent.expires_at, clientIp });
      if (!checkout.checkoutUrl && !checkout.qrCode) return this.view(intent);
      return this.view((await tx.query('UPDATE payment.intents SET checkout_url=$2,qr_code=$3 WHERE id=$1 RETURNING *',
        [intent.id, checkout.checkoutUrl, checkout.qrCode])).rows[0]);
    });
  }
  async get(userId: string, id: string) {
    const intent = (await this.db.query('SELECT * FROM payment.intents WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
    invariant(intent, 'NOT_FOUND', 'Payment intent not found', 404);
    return this.view(intent);
  }
  /** Applies one authenticated provider notification exactly once. `find` resolves the intent row reference. */
  private async settle(provider: string, payment: ProviderPayment, rawHash: string, where: { sql: string; value: string }, requestId: string) {
    return this.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`webhook:${provider}:${payment.eventId}`]);
      const prior = (await tx.query('SELECT * FROM payment.webhook_events WHERE provider=$1 AND event_id=$2', [provider, payment.eventId])).rows[0];
      if (prior) {
        invariant(prior.raw_hash === rawHash, 'WEBHOOK_EVENT_CONFLICT', 'Event id has a different payload');
        return { accepted: true, duplicate: true, outcome: prior.outcome as string };
      }
      const ref = (await tx.query(`SELECT * FROM payment.intents WHERE ${where.sql}=$1 AND provider=$2`, [where.value, provider])).rows[0];
      invariant(ref, 'NOT_FOUND', 'Payment intent not found', 404);
      const column = (Object.values(TARGETS) as TargetColumn[]).find(name => ref[name])!, target = this.targets[column];
      const subject = await target.lock(tx, ref[column]);
      const intent = (await tx.query('SELECT * FROM payment.intents WHERE id=$1 FOR UPDATE', [ref.id])).rows[0];
      invariant(intent.amount === payment.amount && intent.currency === payment.currency, 'PAYMENT_AMOUNT_MISMATCH', 'Amount or currency mismatch');
      let outcome = intent.status;
      if (intent.status !== 'SUCCEEDED' && intent.status !== 'NEEDS_REVIEW') {
        const confirmed = await target.confirm(tx, subject, requestId);
        if (!confirmed && subject.status === 'PENDING_PAYMENT' && subject.payment_expires_at.getTime() <= Date.now()) await target.expireLate(tx, subject, requestId);
        // A late payment cannot take a slot now held by another client. It goes to review and refund.
        outcome = confirmed ? 'SUCCEEDED' : 'NEEDS_REVIEW';
        await tx.query('UPDATE payment.intents SET status=$2,updated_at=now(),version=version+1 WHERE id=$1', [intent.id, outcome]);
        await tx.query(`INSERT INTO payment.transactions(intent_id,event_id,amount,currency,provider_ref,provider_paid_at)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(intent_id) DO NOTHING`,
          [intent.id, payment.eventId, payment.amount, payment.currency, payment.providerRef || null, payment.paidAt || null]);
        await emitEvent(tx, intent.user_id, `payment.${outcome.toLowerCase()}`, { paymentIntentId: intent.id, bookingId: intent.booking_id || undefined,
          orderId: intent.order_id || undefined, status: outcome }, requestId);
      }
      await tx.query('INSERT INTO payment.webhook_events(provider,event_id,raw_hash,intent_id,outcome) VALUES($1,$2,$3,$4,$5)',
        [provider, payment.eventId, rawHash, intent.id, outcome]);
      return { accepted: true, duplicate: false, outcome: outcome as string };
    });
  }
  private active(provider: string) {
    invariant(loadConfig().paymentProvider === provider, 'UNSUPPORTED_PROVIDER', 'Provider is not configured', 404);
  }
  async webhook(provider: string, dto: SandboxWebhookDto, raw: Buffer | undefined, timestamp: string | undefined, signature: string | undefined, requestId: string) {
    invariant(provider === 'sandbox', 'UNSUPPORTED_PROVIDER', 'Provider is not configured', 404);
    this.active('sandbox');
    verifyWebhook(raw, timestamp, signature, loadConfig().webhookSecret);
    return this.settle('sandbox', { eventId: dto.eventId, orderCode: '', amount: dto.amount, currency: dto.currency, paid: true },
      digest(raw!), { sql: 'id', value: dto.intentId }, requestId);
  }
  /**
   * Development stand-in for the sandbox provider's signed webhook, so a locally run app can finish a payment.
   * Gated like the development OTP endpoint: never in production, only for sandbox, only with the development key.
   */
  async developmentPay(userId: string, intentId: string, key: string | undefined, requestId: string) {
    const config = loadConfig();
    invariant(!config.production && config.paymentProvider === 'sandbox' && config.devKey.length >= 32, 'NOT_FOUND', 'Not found', 404);
    invariant(key && secureEqual(key, config.devKey), 'FORBIDDEN', 'Invalid development key', 403);
    const intent = await this.get(userId, intentId), eventId = `development:${intentId}`;
    // An expired intent would be filed as a late payment awaiting refund, for money that was never taken.
    invariant(intent.status === 'CREATED' || intent.status === 'SUCCEEDED', 'TARGET_NOT_PAYABLE', 'This item cannot be paid');
    return this.settle('sandbox', { eventId, orderCode: '', amount: intent.amount, currency: intent.currency, paid: true },
      digest(eventId), { sql: 'id', value: intentId }, requestId);
  }
  /** PayOS posts JSON signed over `data`. Non-payment notifications and its webhook-URL probe are acknowledged without effect. */
  async payos(body: unknown, raw: Buffer | undefined, requestId: string) {
    this.active('payos');
    const payment = payosWebhook(body, loadConfig().payos!.checksumKey);
    if (!payment.paid) return { accepted: true, ignored: true };
    try { return await this.settle('payos', payment, digest(raw || JSON.stringify(body)), { sql: 'order_code', value: payment.orderCode }, requestId); }
    catch (error) { if (error instanceof ApiError && error.code === 'NOT_FOUND') return { accepted: true, ignored: true }; throw error; }
  }
  /** VNPay IPN. The reply uses VNPay's own RspCode contract, not the API envelope. */
  async vnpay(query: Record<string, unknown>, requestId: string) {
    if (loadConfig().paymentProvider !== 'vnpay') return { RspCode: '99', Message: 'Provider not configured' };
    const payment = vnpayIpn(query, loadConfig().vnpay!.hashSecret);
    if (!payment) return { RspCode: '97', Message: 'Invalid signature' };
    if (!/^\d{1,18}$/.test(payment.orderCode)) return { RspCode: '01', Message: 'Order not found' };
    if (!payment.paid) return { RspCode: '00', Message: 'Confirm Success' };
    try {
      const canonical = Object.keys(query).sort().map(key => `${key}=${String(query[key])}`).join('&');
      const result = await this.settle('vnpay', payment, digest(canonical), { sql: 'order_code', value: payment.orderCode }, requestId);
      return result.duplicate ? { RspCode: '02', Message: 'Order already confirmed' } : { RspCode: '00', Message: 'Confirm Success' };
    } catch (error) {
      const code = error instanceof ApiError ? error.code : '';
      if (code === 'NOT_FOUND') return { RspCode: '01', Message: 'Order not found' };
      if (code === 'PAYMENT_AMOUNT_MISMATCH') return { RspCode: '04', Message: 'Invalid amount' };
      if (code === 'WEBHOOK_EVENT_CONFLICT') return { RspCode: '02', Message: 'Order already confirmed' };
      return { RspCode: '99', Message: 'Unknown error' };
    }
  }
  async expireDue() {
    await this.db.query("UPDATE payment.intents SET status='EXPIRED',updated_at=now(),version=version+1 WHERE status='CREATED' AND expires_at<=now()");
  }
}
