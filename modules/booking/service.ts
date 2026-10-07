import { Injectable } from '@nestjs/common';
import { DbClient, Database } from '../../packages/database';
import { Idempotency } from '../../packages/idempotency';
import { emitEvent } from '../../packages/events';
import { invariant } from '../../packages/contracts/errors';
import { CatalogService } from '../catalog/service';
import { bookingRefundPercent, RefundService } from '../payment/refunds';
import { assertTransition, BookingStatus, validateSlot } from './domain';
import { AvailabilityQuery, BookingQuery, BookingServiceDto, RecurringBookingDto, ReviewDto, SlotDto } from './dto';
@Injectable()
export class BookingService {
  constructor(private readonly db: Database, private readonly catalog: CatalogService, private readonly idem: Idempotency,
    private readonly refunds: RefundService) {}
  async quote(dto: SlotDto, tx: DbClient = this.db.pool) {
    const slot = validateSlot(dto.startsAt, dto.endsAt);
    const yard = await this.catalog.yard(tx, dto.yardId);
    const open = (await tx.query(`SELECT ($1::timestamptz AT TIME ZONE $3)::date= (($2::timestamptz-interval '1 millisecond') AT TIME ZONE $3)::date
      AND extract(hour FROM $1::timestamptz AT TIME ZONE $3)>=$4
      AND extract(hour FROM ($2::timestamptz-interval '1 millisecond') AT TIME ZONE $3)<$5 AS valid`,
      [slot.start, slot.end, yard.timezone, yard.opening_hour, yard.closing_hour])).rows[0].valid;
    invariant(open, 'OUTSIDE_OPENING_HOURS', 'Slot is outside branch opening hours', 400);
    return { subtotal: yard.hourly_price * slot.hours, discount: 0, fee: 0, total: yard.hourly_price * slot.hours,
      currency: yard.currency, yardId: yard.id, branchId: yard.branch_id, startsAt: slot.start.toISOString(), endsAt: slot.end.toISOString() };
  }
  async transition(tx: DbClient, row: any, to: BookingStatus, reason: string, actorId?: string, requestId?: string) {
    assertTransition(row.status, to);
    await tx.query('UPDATE booking.bookings SET status=$2,version=version+1,updated_at=now() WHERE id=$1', [row.id, to]);
    await tx.query('INSERT INTO booking.status_history(booking_id,from_status,to_status,reason,actor_id) VALUES($1,$2,$3,$4,$5)', [row.id, row.status, to, reason, actorId || null]);
    await emitEvent(tx, row.user_id, `booking.${to.toLowerCase()}`, { bookingId: row.id, status: to }, requestId);
    row.status = to;
    return row;
  }
  async expireYard(tx: DbClient, yardId: string) {
    // Caller holds the yard row lock. All booking/payment writers use yard -> booking -> intent order.
    await tx.query("UPDATE booking.holds SET status='EXPIRED' WHERE yard_id=$1 AND status='ACTIVE' AND expires_at<=now()", [yardId]);
    await tx.query('UPDATE booking.reservations SET active=false WHERE yard_id=$1 AND active AND expires_at<=now()', [yardId]);
    const stale = (await tx.query("SELECT * FROM booking.bookings WHERE yard_id=$1 AND status='PENDING_PAYMENT' AND payment_expires_at<=now() FOR UPDATE", [yardId])).rows;
    for (const row of stale) await this.transition(tx, row, 'EXPIRED', 'payment deadline elapsed');
  }
  async expireDue() {
    const ids = (await this.db.query('SELECT DISTINCT yard_id FROM booking.reservations WHERE active AND expires_at<=now() LIMIT 100')).rows;
    for (const row of ids) await this.db.transaction(async tx => { await this.catalog.yard(tx, row.yard_id, true); await this.expireYard(tx, row.yard_id); });
    return ids.length;
  }
  async hold(userId: string, dto: SlotDto, key: string | undefined) {
    return this.idem.run(userId, 'booking-hold', key, dto, async tx => {
      await this.catalog.yard(tx, dto.yardId, true);
      await this.expireYard(tx, dto.yardId);
      const quote = await this.quote(dto, tx);
      const hold = (await tx.query(`INSERT INTO booking.holds(user_id,yard_id,starts_at,ends_at,amount,currency,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,now()+interval '5 minutes') RETURNING *`, [userId, dto.yardId, quote.startsAt, quote.endsAt, quote.total, quote.currency])).rows[0];
      await tx.query('INSERT INTO booking.reservations(yard_id,hold_id,starts_at,ends_at,expires_at) VALUES($1,$2,$3,$4,$5)',
        [dto.yardId, hold.id, quote.startsAt, quote.endsAt, hold.expires_at]);
      return { holdId: hold.id, expiresAt: hold.expires_at, quote };
    });
  }
  async release(userId: string, id: string) {
    return this.db.transaction(async tx => {
      const row = (await tx.query('SELECT * FROM booking.holds WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
      invariant(row, 'NOT_FOUND', 'Hold not found', 404);
      await this.catalog.yard(tx, row.yard_id, true);
      const current = (await tx.query('SELECT * FROM booking.holds WHERE id=$1 FOR UPDATE', [id])).rows[0];
      invariant(current.status !== 'CONVERTED', 'HOLD_CONVERTED', 'Cancel the booking instead');
      await tx.query("UPDATE booking.holds SET status='RELEASED' WHERE id=$1 AND status='ACTIVE'", [id]);
      await tx.query('UPDATE booking.reservations SET active=false WHERE hold_id=$1', [id]);
      return { released: true };
    });
  }
  async create(userId: string, holdId: string, key: string | undefined, requestId: string) {
    return this.idem.run(userId, 'booking', key, { holdId }, async tx => {
      const ref = (await tx.query('SELECT yard_id FROM booking.holds WHERE id=$1 AND user_id=$2', [holdId, userId])).rows[0];
      invariant(ref, 'NOT_FOUND', 'Hold not found', 404);
      const yard = await this.catalog.yard(tx, ref.yard_id, true);
      const hold = (await tx.query('SELECT * FROM booking.holds WHERE id=$1 FOR UPDATE', [holdId])).rows[0];
      invariant(hold.status === 'ACTIVE' && hold.expires_at.getTime() > Date.now(), 'HOLD_EXPIRED', 'Hold is expired or already used');
      const row = (await tx.query(`INSERT INTO booking.bookings(user_id,branch_id,yard_id,hold_id,starts_at,ends_at,amount,currency,payment_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [userId, yard.branch_id, yard.id, holdId, hold.starts_at, hold.ends_at, hold.amount, hold.currency, hold.expires_at])).rows[0];
      await tx.query("UPDATE booking.holds SET status='CONVERTED' WHERE id=$1", [holdId]);
      await tx.query('UPDATE booking.reservations SET booking_id=$2 WHERE hold_id=$1 AND active', [holdId, row.id]);
      await tx.query("INSERT INTO booking.status_history(booking_id,to_status,actor_id,reason) VALUES($1,'PENDING_PAYMENT',$2,'hold converted')", [row.id, userId]);
      await emitEvent(tx, userId, 'booking.pending_payment', { bookingId: row.id, status: row.status }, requestId);
      return row;
    });
  }
  async createSeries(userId: string, dto: RecurringBookingDto, key: string | undefined, requestId: string) {
    validateSlot(dto.startsAt, dto.endsAt);
    return this.idem.run(userId, 'booking-series', key, dto, async tx => {
      const yard = await this.catalog.yard(tx, dto.yardId, true);
      await this.expireYard(tx, dto.yardId);
      const series = (await tx.query(`INSERT INTO booking.series(user_id,yard_id,frequency)
        VALUES($1,$2,'WEEKLY') RETURNING *`, [userId, dto.yardId])).rows[0];
      const bookings = [];
      for (let week = 0; week < dto.weeks; week++) {
        // Move in branch-local calendar time, preserving the wall-clock hour across DST transitions.
        const shifted = (await tx.query(`SELECT (($1::timestamptz AT TIME ZONE $3)+($4::int*interval '7 days')) AT TIME ZONE $3 AS start,
          (($2::timestamptz AT TIME ZONE $3)+($4::int*interval '7 days')) AT TIME ZONE $3 AS finish`,
          [dto.startsAt, dto.endsAt, yard.timezone, week])).rows[0];
        const quote = await this.quote({ yardId: dto.yardId, startsAt: shifted.start.toISOString(), endsAt: shifted.finish.toISOString() }, tx);
        const hold = (await tx.query(`INSERT INTO booking.holds(user_id,yard_id,starts_at,ends_at,amount,currency,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,now()+interval '5 minutes') RETURNING *`,
          [userId, dto.yardId, quote.startsAt, quote.endsAt, quote.total, quote.currency])).rows[0];
        await tx.query('INSERT INTO booking.reservations(yard_id,hold_id,starts_at,ends_at,expires_at) VALUES($1,$2,$3,$4,$5)',
          [dto.yardId, hold.id, quote.startsAt, quote.endsAt, hold.expires_at]);
        const booking = (await tx.query(`INSERT INTO booking.bookings(user_id,branch_id,yard_id,hold_id,starts_at,ends_at,amount,currency,payment_expires_at,series_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [userId, yard.branch_id, dto.yardId, hold.id, quote.startsAt, quote.endsAt, quote.total, quote.currency, hold.expires_at, series.id])).rows[0];
        await tx.query("UPDATE booking.holds SET status='CONVERTED' WHERE id=$1", [hold.id]);
        await tx.query('UPDATE booking.reservations SET booking_id=$2 WHERE hold_id=$1', [hold.id, booking.id]);
        await tx.query("INSERT INTO booking.status_history(booking_id,to_status,actor_id,reason) VALUES($1,'PENDING_PAYMENT',$2,'weekly series')",
          [booking.id, userId]);
        await emitEvent(tx, userId, 'booking.pending_payment', { bookingId: booking.id, seriesId: series.id }, requestId);
        bookings.push(booking);
      }
      return { seriesId: series.id, frequency: 'WEEKLY', bookings,
        note: 'Each booking requires its own payment intent; no automatic recurring charge is configured' };
    });
  }
  async series(userId: string, id: string) {
    const row = (await this.db.query('SELECT * FROM booking.series WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
    invariant(row, 'NOT_FOUND', 'Booking series not found', 404);
    const bookings = (await this.db.query('SELECT * FROM booking.bookings WHERE series_id=$1 AND user_id=$2 ORDER BY starts_at', [id, userId])).rows;
    return { ...row, bookings };
  }
  async get(userId: string, id: string, tx: DbClient = this.db.pool) {
    const row = (await tx.query('SELECT * FROM booking.bookings WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
    invariant(row, 'NOT_FOUND', 'Booking not found', 404);
    return row;
  }
  async lock(tx: DbClient, id: string) {
    const ref = (await tx.query('SELECT yard_id FROM booking.bookings WHERE id=$1', [id])).rows[0];
    invariant(ref, 'NOT_FOUND', 'Booking not found', 404);
    await this.catalog.yard(tx, ref.yard_id, true);
    return (await tx.query('SELECT * FROM booking.bookings WHERE id=$1 FOR UPDATE', [id])).rows[0];
  }
  async confirm(tx: DbClient, row: any, requestId: string) {
    const valid = row.status === 'PENDING_PAYMENT' && row.payment_expires_at.getTime() > Date.now();
    if (!valid) return false;
    const reservation = await tx.query('UPDATE booking.reservations SET expires_at=NULL WHERE booking_id=$1 AND active RETURNING id', [row.id]);
    invariant(reservation.rowCount, 'RESERVATION_MISSING', 'Reservation is unavailable');
    await this.transition(tx, row, 'CONFIRMED', 'signed payment webhook', undefined, requestId);
    return true;
  }
  async list(userId: string, q: BookingQuery) {
    const page = q.page || 1, pageSize = q.pageSize || 20;
    const rows = (await this.db.query('SELECT *,count(*) OVER()::int AS total FROM booking.bookings WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3', [userId, pageSize, (page - 1) * pageSize])).rows;
    return { items: rows.map(({ total, ...row }) => row), page, pageSize, total: rows[0]?.total || 0 };
  }
  async cancel(userId: string, id: string, key: string | undefined, requestId: string) {
    return this.idem.run(userId, `booking-cancel:${id}`, key, { id }, async tx => {
      await this.get(userId, id, tx);
      const row = await this.lock(tx, id);
      if (row.status === 'CANCELLED') return row;
      invariant(row.status === 'PENDING_PAYMENT' || row.status === 'CONFIRMED', 'INVALID_BOOKING_TRANSITION', 'Booking cannot be cancelled');
      // Paid booking: the refund share depends on how far ahead of the slot the user cancels.
      const paid = row.status === 'CONFIRMED';
      const percent = paid ? bookingRefundPercent(row.starts_at, Date.now(), this.refunds.policy) : 0;
      invariant(!paid || percent > 0, 'CANCELLATION_WINDOW_CLOSED', 'This booking is too close to its start time to cancel');
      await this.transition(tx, row, 'CANCELLED', paid ? 'user cancellation with refund' : 'user cancellation', userId, requestId);
      await tx.query('UPDATE booking.reservations SET active=false WHERE booking_id=$1', [id]);
      const refund = paid ? await this.refunds.request(tx, 'booking', id, percent, 'booking cancelled', requestId) : null;
      return { ...row, refund: refund ? { id: refund.id, amount: refund.amount, percent: refund.percent, status: refund.status } : null };
    });
  }
  async inviteParticipant(userId: string, bookingId: string, participantId: string, requestId: string) {
    invariant(userId !== participantId, 'INVALID_PARTICIPANT', 'Owner is already part of the booking', 400);
    return this.db.transaction(async tx => {
      const booking = await this.get(userId, bookingId, tx);
      await tx.query('SELECT id FROM booking.bookings WHERE id=$1 FOR UPDATE', [bookingId]);
      invariant(booking.status !== 'CANCELLED' && booking.status !== 'EXPIRED' && booking.ends_at.getTime() > Date.now(),
        'BOOKING_CLOSED', 'Booking is closed');
      const target = await tx.query("SELECT 1 FROM identity.users WHERE id=$1 AND status='ACTIVE'", [participantId]);
      invariant(target.rowCount, 'USER_UNAVAILABLE', 'Participant is unavailable', 404);
      const count = (await tx.query('SELECT count(*)::int AS n FROM booking.participants WHERE booking_id=$1', [bookingId])).rows[0].n;
      invariant(count < 20, 'PARTICIPANT_LIMIT', 'Booking participant limit reached');
      const row = (await tx.query(`INSERT INTO booking.participants(booking_id,user_id,status)
        VALUES($1,$2,'INVITED') ON CONFLICT(booking_id,user_id) DO UPDATE SET status='INVITED'
        RETURNING *`, [bookingId, participantId])).rows[0];
      await emitEvent(tx, participantId, 'booking.participant_invited', { bookingId }, requestId);
      return row;
    });
  }
  async participants(userId: string, bookingId: string) {
    await this.get(userId, bookingId);
    return (await this.db.query('SELECT user_id,status,created_at FROM booking.participants WHERE booking_id=$1 ORDER BY created_at', [bookingId])).rows;
  }
  async acceptParticipant(userId: string, bookingId: string) {
    return this.db.transaction(async tx => {
      const booking = (await tx.query('SELECT status,ends_at FROM booking.bookings WHERE id=$1', [bookingId])).rows[0];
      invariant(booking && booking.status !== 'CANCELLED' && booking.status !== 'EXPIRED' && booking.ends_at.getTime() > Date.now(),
        'BOOKING_CLOSED', 'Booking is closed');
      const row = (await tx.query(`UPDATE booking.participants SET status='ACCEPTED' WHERE booking_id=$1 AND user_id=$2
        AND status IN ('INVITED','ACCEPTED') RETURNING *`, [bookingId, userId])).rows[0];
      invariant(row, 'NOT_FOUND', 'Participant invitation not found', 404);
      return row;
    });
  }
  async removeParticipant(userId: string, bookingId: string, participantId: string) {
    await this.get(userId, bookingId);
    const result = await this.db.query('DELETE FROM booking.participants WHERE booking_id=$1 AND user_id=$2', [bookingId, participantId]);
    return { removed: Boolean(result.rowCount) };
  }
  async addService(userId: string, bookingId: string, dto: BookingServiceDto, key: string | undefined, requestId: string) {
    return this.idem.run(userId, `booking-service:${bookingId}`, key, dto, async tx => {
      await this.get(userId, bookingId, tx);
      const booking = await this.lock(tx, bookingId);
      invariant(booking.status === 'PENDING_PAYMENT' && booking.payment_expires_at.getTime() > Date.now(),
        'BOOKING_CLOSED', 'Services can be added only before payment');
      const intent = await tx.query('SELECT 1 FROM payment.intents WHERE booking_id=$1', [bookingId]);
      invariant(!intent.rowCount, 'PAYMENT_ALREADY_STARTED', 'Services cannot change after payment starts');
      const service = (await tx.query('SELECT * FROM catalog.services WHERE id=$1 AND branch_id=$2',
        [dto.serviceId, booking.branch_id])).rows[0];
      invariant(service, 'SERVICE_UNAVAILABLE', 'Service is unavailable for this branch', 404);
      const existing = await tx.query('SELECT 1 FROM booking.services WHERE booking_id=$1 AND service_id=$2', [bookingId, dto.serviceId]);
      invariant(!existing.rowCount, 'SERVICE_ALREADY_ADDED', 'Service is already on the booking');
      const amount = booking.amount + service.price * dto.quantity;
      invariant(Number.isSafeInteger(amount) && amount <= 1000000000, 'INVALID_BOOKING_AMOUNT', 'Booking amount exceeds limit', 400);
      const row = (await tx.query(`INSERT INTO booking.services(booking_id,service_id,quantity,unit_price)
        VALUES($1,$2,$3,$4) RETURNING *`, [bookingId, dto.serviceId, dto.quantity, service.price])).rows[0];
      await tx.query('UPDATE booking.bookings SET amount=$2,updated_at=now(),version=version+1 WHERE id=$1', [bookingId, amount]);
      await emitEvent(tx, userId, 'booking.service_added', { bookingId, serviceId: dto.serviceId, amount }, requestId);
      return { ...row, amount };
    });
  }
  async review(userId: string, bookingId: string, dto: ReviewDto, requestId: string) {
    return this.db.transaction(async tx => {
      const booking = await this.get(userId, bookingId, tx);
      invariant(booking.status === 'CONFIRMED' && booking.ends_at.getTime() <= Date.now(),
        'REVIEW_NOT_ALLOWED', 'Review is allowed only after a completed confirmed booking');
      const row = (await tx.query(`INSERT INTO booking.reviews(booking_id,user_id,rating,comment)
        VALUES($1,$2,$3,$4) ON CONFLICT(booking_id) DO NOTHING RETURNING *`,
        [bookingId, userId, dto.rating, dto.comment.trim()])).rows[0];
      invariant(row, 'REVIEW_ALREADY_EXISTS', 'Booking has already been reviewed');
      await emitEvent(tx, userId, 'booking.reviewed', { bookingId, reviewId: row.id }, requestId);
      return row;
    });
  }
  async reviews(branchId: string) {
    await this.catalog.branch(branchId);
    return (await this.db.query(`SELECT r.id,r.rating,r.comment,r.created_at,b.yard_id FROM booking.reviews r
      JOIN booking.bookings b ON b.id=r.booking_id WHERE b.branch_id=$1 ORDER BY r.created_at DESC LIMIT 100`, [branchId])).rows;
  }
  async availability(branchId: string, q: AvailabilityQuery) {
    await this.catalog.branch(branchId);
    const from = new Date(q.from), to = new Date(q.to);
    invariant(to > from && to.getTime() - from.getTime() <= 7 * 86400000 && from.getTime() % 3600000 === 0 && to.getTime() % 3600000 === 0,
      'INVALID_RANGE', 'Availability range must use whole hours and be at most 7 days', 400);
    return (await this.db.query(`SELECT y.id AS yard_id,y.name,y.hourly_price AS amount,y.currency,s AS starts_at,s+interval '1 hour' AS ends_at,
      NOT EXISTS(SELECT 1 FROM booking.reservations r WHERE r.yard_id=y.id AND r.active AND (r.expires_at IS NULL OR r.expires_at>now())
        AND tstzrange(r.starts_at,r.ends_at,'[)') && tstzrange(s,s+interval '1 hour','[)')) AS available
      FROM catalog.yards y JOIN catalog.branches b ON b.id=y.branch_id,
      generate_series($2::timestamptz,$3::timestamptz-interval '1 hour',interval '1 hour') s
      WHERE y.branch_id=$1 AND y.active AND ($4::uuid IS NULL OR y.sport_id=$4) AND s>now()
      AND extract(hour FROM s AT TIME ZONE b.timezone)>=b.opening_hour AND extract(hour FROM s AT TIME ZONE b.timezone)<b.closing_hour
      ORDER BY s,y.name`, [branchId, from, to, q.sportId || null])).rows;
  }
}
