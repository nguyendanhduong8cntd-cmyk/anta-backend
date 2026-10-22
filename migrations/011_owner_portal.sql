-- Additive migration for the venue-owner portal. Existing booking/payment rows remain intact.
-- Adds an owner-confirmation step between payment and CONFIRMED, a source flag for counter
-- bookings, and a maintenance-block model that shares the existing reservation exclusion
-- constraint so it keeps blocking double-booking at the database level.

ALTER TABLE booking.bookings ADD COLUMN source text NOT NULL DEFAULT 'APP' CHECK(source IN ('APP','COUNTER'));
ALTER TABLE booking.bookings ADD COLUMN created_by uuid REFERENCES identity.users;
ALTER TABLE booking.bookings ADD COLUMN confirm_deadline_at timestamptz;

-- Replace the status check to add PENDING_OWNER_CONFIRMATION without assuming the
-- auto-generated constraint name (it was never given an explicit name in 001_core.sql).
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
    WHERE conrelid = 'booking.bookings'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%IN%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE booking.bookings DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE booking.bookings ADD CONSTRAINT bookings_status_check
  CHECK(status IN ('PENDING_PAYMENT','PENDING_OWNER_CONFIRMATION','CONFIRMED','CANCELLED','EXPIRED'));

CREATE INDEX ON booking.bookings(branch_id,status,starts_at);
CREATE INDEX booking_owner_confirm_deadline ON booking.bookings(confirm_deadline_at) WHERE status='PENDING_OWNER_CONFIRMATION';

-- Maintenance/lock blocks for a yard. A block is its own object, never a disguised booking
-- status, but it shares the same overlap guard as holds/bookings through booking.reservations.
CREATE TABLE booking.blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  yard_id uuid NOT NULL REFERENCES catalog.yards,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  created_by uuid NOT NULL REFERENCES identity.users,
  active boolean NOT NULL DEFAULT true,
  released_at timestamptz, released_by uuid REFERENCES identity.users,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(ends_at>starts_at)
);
CREATE INDEX ON booking.blocks(yard_id,active);

ALTER TABLE booking.reservations ALTER COLUMN hold_id DROP NOT NULL;
ALTER TABLE booking.reservations ADD COLUMN block_id uuid UNIQUE REFERENCES booking.blocks;
ALTER TABLE booking.reservations ADD CONSTRAINT reservation_exactly_one_source CHECK((hold_id IS NOT NULL) <> (block_id IS NOT NULL));
