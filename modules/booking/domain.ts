import { invariant } from '../../packages/contracts/errors';
export type BookingStatus = 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';
const transitions: Record<BookingStatus, BookingStatus[]> = {
  PENDING_PAYMENT: ['CONFIRMED', 'CANCELLED', 'EXPIRED'], CONFIRMED: [], CANCELLED: [], EXPIRED: []
};
export function assertTransition(from: BookingStatus, to: BookingStatus) {
  invariant(transitions[from]?.includes(to), 'INVALID_BOOKING_TRANSITION', `Cannot change booking from ${from} to ${to}`);
}
export function validateSlot(startsAt: string, endsAt: string, now = Date.now()) {
  const start = new Date(startsAt), end = new Date(endsAt);
  const duration = end.getTime() - start.getTime();
  invariant(Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && start.getTime() > now && start.getTime() <= now + 90 * 86400000,
    'INVALID_SLOT', 'Slot must start in the next 90 days', 400);
  invariant(start.getTime() % 3600000 === 0 && end.getTime() % 3600000 === 0 && duration >= 3600000 && duration <= 8 * 3600000,
    'INVALID_SLOT', 'Use whole-hour slots with duration 1-8 hours', 400);
  return { start, end, hours: duration / 3600000 };
}
