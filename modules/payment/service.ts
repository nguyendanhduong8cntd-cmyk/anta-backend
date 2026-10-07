import { Injectable } from '@nestjs/common';
import { Database } from '../../packages/database';
import { Idempotency } from '../../packages/idempotency';
import { emitEvent } from '../../packages/events';
import { digest } from '../../packages/auth/crypto';
import { loadConfig } from '../../packages/config';
import { invariant } from '../../packages/contracts/errors';
import { BookingService } from '../booking/service';
import { CommerceService } from '../commerce/service';
import { IntentDto, SandboxWebhookDto } from './dto';
import { verifyWebhook } from './signature';
@Injectable()
export class PaymentService {
  constructor(private readonly db: Database, private readonly idem: Idempotency,
    private readonly bookings: BookingService, private readonly commerce: CommerceService) {}
  async create(userId: string, target: IntentDto, key: string | undefined) {
    invariant(Boolean(target.bookingId) !== Boolean(target.orderId), 'INVALID_PAYMENT_TARGET', 'Specify exactly one bookingId or orderId', 400);
    return this.idem.run(userId, 'payment-intent', key, target, async tx => {
      let subject: any;
      if (target.bookingId) {
        await this.bookings.get(userId, target.bookingId, tx);
        subject = await this.bookings.lock(tx, target.bookingId);
      } else {
        await this.commerce.get(userId, target.orderId!, tx);
        subject = await this.commerce.lock(tx, target.orderId!);
      }
      invariant(subject.status === 'PENDING_PAYMENT' && subject.payment_expires_at.getTime() > Date.now(),
        'TARGET_NOT_PAYABLE', 'Booking or order cannot be paid');
      const existing = (await tx.query('SELECT * FROM payment.intents WHERE booking_id=$1 OR order_id=$2', [target.bookingId || null, target.orderId || null])).rows[0];
      if (existing) return { ...existing, sandbox: true, checkoutUrl: null };
      const intent = (await tx.query(`INSERT INTO payment.intents(user_id,booking_id,order_id,provider,amount,currency,expires_at)
        VALUES($1,$2,$3,'sandbox',$4,$5,$6) RETURNING *`, [userId, target.bookingId || null, target.orderId || null,
        subject.amount, subject.currency, subject.payment_expires_at])).rows[0];
      // No fake merchant URL or QR. Local signed webhook is the only sandbox payment confirmation.
      return { ...intent, sandbox: true, checkoutUrl: null };
    });
  }
  async get(userId: string, id: string) {
    const intent = (await this.db.query('SELECT * FROM payment.intents WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
    invariant(intent, 'NOT_FOUND', 'Payment intent not found', 404);
    return intent;
  }
  async webhook(provider: string, dto: SandboxWebhookDto, raw: Buffer | undefined, timestamp: string | undefined, signature: string | undefined, requestId: string) {
    invariant(provider === 'sandbox', 'UNSUPPORTED_PROVIDER', 'Provider is not configured', 404);
    verifyWebhook(raw, timestamp, signature, loadConfig().webhookSecret);
    const rawHash = digest(raw!);
    return this.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`webhook:${provider}:${dto.eventId}`]);
      const prior = (await tx.query('SELECT * FROM payment.webhook_events WHERE provider=$1 AND event_id=$2', [provider, dto.eventId])).rows[0];
      if (prior) {
        invariant(prior.raw_hash === rawHash, 'WEBHOOK_EVENT_CONFLICT', 'Event id has a different payload');
        return { accepted: true, duplicate: true, outcome: prior.outcome };
      }
      const ref = (await tx.query('SELECT booking_id,order_id FROM payment.intents WHERE id=$1', [dto.intentId])).rows[0];
      invariant(ref, 'NOT_FOUND', 'Payment intent not found', 404);
      const subject = ref.booking_id ? await this.bookings.lock(tx, ref.booking_id) : await this.commerce.lock(tx, ref.order_id);
      const intent = (await tx.query('SELECT * FROM payment.intents WHERE id=$1 FOR UPDATE', [dto.intentId])).rows[0];
      invariant(intent.amount === dto.amount && intent.currency === dto.currency, 'PAYMENT_AMOUNT_MISMATCH', 'Amount or currency mismatch');
      let outcome = intent.status;
      if (intent.status !== 'SUCCEEDED' && intent.status !== 'NEEDS_REVIEW') {
        const confirmed = ref.booking_id ? await this.bookings.confirm(tx, subject, requestId) : await this.commerce.confirm(tx, subject, requestId);
        if (!confirmed && subject.status === 'PENDING_PAYMENT' && subject.payment_expires_at.getTime() <= Date.now()) {
          if (ref.booking_id) {
            await this.bookings.transition(tx, subject, 'EXPIRED', 'payment received after deadline', undefined, requestId);
            await tx.query('UPDATE booking.reservations SET active=false WHERE booking_id=$1', [subject.id]);
          } else await this.commerce.transition(tx, subject, 'EXPIRED', 'payment received after deadline', undefined, requestId);
        }
        // A late payment cannot take a slot now held by another client. It goes to reconciliation/refund.
        outcome = confirmed ? 'SUCCEEDED' : 'NEEDS_REVIEW';
        await tx.query('UPDATE payment.intents SET status=$2,updated_at=now(),version=version+1 WHERE id=$1', [intent.id, outcome]);
        await tx.query('INSERT INTO payment.transactions(intent_id,event_id,amount,currency) VALUES($1,$2,$3,$4) ON CONFLICT(intent_id) DO NOTHING', [intent.id, dto.eventId, dto.amount, dto.currency]);
        await emitEvent(tx, intent.user_id, `payment.${outcome.toLowerCase()}`,
          { paymentIntentId: intent.id, bookingId: ref.booking_id || undefined, orderId: ref.order_id || undefined, status: outcome }, requestId);
      }
      await tx.query('INSERT INTO payment.webhook_events(provider,event_id,raw_hash,intent_id,outcome) VALUES($1,$2,$3,$4,$5)', [provider, dto.eventId, rawHash, intent.id, outcome]);
      return { accepted: true, duplicate: false, outcome };
    });
  }
  async expireDue() {
    await this.db.query("UPDATE payment.intents SET status='EXPIRED',updated_at=now(),version=version+1 WHERE status='CREATED' AND expires_at<=now()");
  }
}
