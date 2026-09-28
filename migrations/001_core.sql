CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS booking;
CREATE SCHEMA IF NOT EXISTS payment;
CREATE SCHEMA IF NOT EXISTS notification;
CREATE SCHEMA IF NOT EXISTS content;
CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE identity.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), identifier text NOT NULL UNIQUE,
  display_name text NOT NULL, password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);
CREATE TABLE identity.otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), identifier text NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('register','reset-password')),
  code_hash text NOT NULL, expires_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0,
  consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON identity.otp_challenges(identifier, created_at DESC);
CREATE TABLE identity.refresh_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES identity.users,
  family_id uuid NOT NULL, refresh_hash text NOT NULL UNIQUE, device_id text NOT NULL,
  expires_at timestamptz NOT NULL, revoked_at timestamptz, rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON identity.refresh_sessions(user_id, family_id);
CREATE TABLE identity.devices (
  user_id uuid NOT NULL REFERENCES identity.users, device_id text NOT NULL, fcm_token text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,device_id), UNIQUE(fcm_token)
);

CREATE TABLE catalog.sports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text NOT NULL UNIQUE);
CREATE TABLE catalog.shops (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
CREATE TABLE catalog.branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL REFERENCES catalog.shops,
  name text NOT NULL, address text NOT NULL, description text NOT NULL DEFAULT '',
  location geography(Point,4326) NOT NULL, timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  opening_hour integer NOT NULL DEFAULT 6, closing_hour integer NOT NULL DEFAULT 23,
  images jsonb NOT NULL DEFAULT '[]', rules jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  CHECK(opening_hour>=0 AND closing_hour<=24 AND opening_hour<closing_hour)
);
CREATE INDEX branch_location_gist ON catalog.branches USING gist(location);
CREATE INDEX ON catalog.branches(shop_id);
CREATE TABLE catalog.yards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), branch_id uuid NOT NULL REFERENCES catalog.branches,
  sport_id uuid NOT NULL REFERENCES catalog.sports, name text NOT NULL,
  hourly_price integer NOT NULL CHECK(hourly_price>0), currency text NOT NULL DEFAULT 'VND' CHECK(currency='VND'),
  active boolean NOT NULL DEFAULT true
);
CREATE INDEX ON catalog.yards(branch_id,sport_id);
CREATE TABLE catalog.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), branch_id uuid NOT NULL REFERENCES catalog.branches,
  name text NOT NULL, price integer NOT NULL CHECK(price>=0), currency text NOT NULL DEFAULT 'VND'
);
CREATE INDEX ON catalog.services(branch_id);
CREATE TABLE catalog.favorites (
  user_id uuid NOT NULL REFERENCES identity.users, branch_id uuid NOT NULL REFERENCES catalog.branches,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,branch_id)
);

CREATE TABLE booking.holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES identity.users,
  yard_id uuid NOT NULL REFERENCES catalog.yards, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  amount integer NOT NULL CHECK(amount>0), currency text NOT NULL CHECK(currency='VND'), expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','CONVERTED','RELEASED','EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(ends_at>starts_at)
);
CREATE INDEX ON booking.holds(yard_id,status,expires_at);
CREATE TABLE booking.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES identity.users,
  branch_id uuid NOT NULL REFERENCES catalog.branches, yard_id uuid NOT NULL REFERENCES catalog.yards,
  hold_id uuid NOT NULL UNIQUE REFERENCES booking.holds,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  amount integer NOT NULL CHECK(amount>0), currency text NOT NULL CHECK(currency='VND'),
  status text NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK(status IN ('PENDING_PAYMENT','CONFIRMED','CANCELLED','EXPIRED')),
  payment_expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1, CHECK(ends_at>starts_at)
);
CREATE INDEX ON booking.bookings(user_id,created_at DESC);
CREATE INDEX ON booking.bookings(branch_id,status);
CREATE INDEX ON booking.bookings(yard_id,status,payment_expires_at);
-- Holds and bookings share ONE exclusion domain. Separate tables alone cannot prevent overlaps.
CREATE TABLE booking.reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), yard_id uuid NOT NULL REFERENCES catalog.yards,
  hold_id uuid NOT NULL UNIQUE REFERENCES booking.holds, booking_id uuid UNIQUE REFERENCES booking.bookings,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, active boolean NOT NULL DEFAULT true,
  expires_at timestamptz, CHECK(ends_at>starts_at),
  CONSTRAINT no_yard_overlap EXCLUDE USING gist(yard_id WITH =, tstzrange(starts_at,ends_at,'[)') WITH &&) WHERE(active)
);
CREATE TABLE booking.status_history (
  id bigserial PRIMARY KEY, booking_id uuid NOT NULL REFERENCES booking.bookings,
  from_status text, to_status text NOT NULL, actor_id uuid REFERENCES identity.users,
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment.intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL UNIQUE REFERENCES booking.bookings,
  user_id uuid NOT NULL REFERENCES identity.users, provider text NOT NULL CHECK(provider='sandbox'),
  amount integer NOT NULL CHECK(amount>0), currency text NOT NULL CHECK(currency='VND'),
  status text NOT NULL DEFAULT 'CREATED' CHECK(status IN ('CREATED','SUCCEEDED','EXPIRED','NEEDS_REVIEW')),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);
CREATE INDEX ON payment.intents(user_id);
CREATE TABLE payment.webhook_events (
  provider text NOT NULL, event_id text NOT NULL, raw_hash text NOT NULL,
  intent_id uuid NOT NULL REFERENCES payment.intents, outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(provider,event_id)
);
CREATE TABLE payment.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), intent_id uuid NOT NULL UNIQUE REFERENCES payment.intents,
  event_id text NOT NULL, amount integer NOT NULL, currency text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.idempotency (
  user_id uuid NOT NULL REFERENCES identity.users, scope text NOT NULL, key text NOT NULL,
  request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,scope,key)
);
CREATE TABLE platform.outbox_events (
  id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES identity.users,
  type text NOT NULL, payload jsonb NOT NULL, request_id text,
  created_at timestamptz NOT NULL DEFAULT now(), queued_at timestamptz
);
CREATE INDEX outbox_pending ON platform.outbox_events(id) WHERE queued_at IS NULL;
CREATE INDEX ON platform.outbox_events(user_id,id);
CREATE TABLE notification.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES identity.users,
  event_id bigint NOT NULL UNIQUE REFERENCES platform.outbox_events,
  type text NOT NULL, payload jsonb NOT NULL, read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz
);
CREATE INDEX ON notification.notifications(user_id,created_at DESC);
CREATE TABLE notification.preferences (
  user_id uuid PRIMARY KEY REFERENCES identity.users, push_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE content.documents (
  slug text PRIMARY KEY, title text NOT NULL, body text NOT NULL, version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
