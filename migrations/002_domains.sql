-- Additive migration for consumer-facing Phase 2 domains. Existing booking/payment rows remain intact.
CREATE SCHEMA IF NOT EXISTS membership;
CREATE SCHEMA IF NOT EXISTS academy;
CREATE SCHEMA IF NOT EXISTS social;
CREATE SCHEMA IF NOT EXISTS commerce;
CREATE SCHEMA IF NOT EXISTS chat;
CREATE SCHEMA IF NOT EXISTS media;

CREATE TABLE identity.roles (
  user_id uuid NOT NULL REFERENCES identity.users, role text NOT NULL
    CHECK(role IN ('admin','support','branch_owner','branch_staff','coach')),
  branch_id uuid REFERENCES catalog.branches,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role IN ('admin','support') AND branch_id IS NULL) OR
         (role IN ('branch_owner','branch_staff','coach') AND branch_id IS NOT NULL))
);
CREATE UNIQUE INDEX identity_roles_unique ON identity.roles(user_id,role,coalesce(branch_id,'00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX ON identity.roles(branch_id,role);
CREATE TABLE identity.profiles (
  user_id uuid PRIMARY KEY REFERENCES identity.users, favorite_sports uuid[] NOT NULL DEFAULT '{}',
  skill_level text, privacy text NOT NULL DEFAULT 'PRIVATE' CHECK(privacy IN ('PRIVATE','FRIENDS','PUBLIC')),
  updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);
CREATE TABLE identity.linked_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES identity.users,
  provider text NOT NULL CHECK(provider IN ('google','apple','facebook')),
  provider_subject text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_subject), UNIQUE(user_id,provider)
);
CREATE TABLE identity.deletion_requests (
  user_id uuid PRIMARY KEY REFERENCES identity.users, requested_at timestamptz NOT NULL DEFAULT now(),
  purge_after timestamptz NOT NULL, completed_at timestamptz
);
ALTER TABLE identity.users DROP CONSTRAINT users_status_check;
ALTER TABLE identity.users ADD CONSTRAINT users_status_check CHECK(status IN ('ACTIVE','DISABLED','DELETION_REQUESTED','DELETED'));

CREATE TABLE membership.plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), branch_id uuid NOT NULL REFERENCES catalog.branches,
  name text NOT NULL, price integer NOT NULL CHECK(price>=0), currency text NOT NULL DEFAULT 'VND' CHECK(currency='VND'),
  credits integer NOT NULL CHECK(credits>0 AND credits<=1000), duration_days integer NOT NULL CHECK(duration_days BETWEEN 1 AND 366),
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);
CREATE INDEX ON membership.plans(branch_id,active);
CREATE TABLE membership.contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_id uuid NOT NULL REFERENCES membership.plans,
  branch_id uuid NOT NULL REFERENCES catalog.branches, user_id uuid NOT NULL REFERENCES identity.users,
  remaining_credits integer NOT NULL CHECK(remaining_credits>=0),
  status text NOT NULL CHECK(status IN ('ACTIVE','EXPIRED','CANCELLED')),
  starts_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);
CREATE INDEX ON membership.contracts(user_id,status,expires_at);
CREATE INDEX ON membership.contracts(branch_id,status);
CREATE TABLE membership.usages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid NOT NULL REFERENCES membership.contracts,
  user_id uuid NOT NULL REFERENCES identity.users, ticket_id uuid,
  booking_id uuid REFERENCES booking.bookings, credits integer NOT NULL CHECK(credits>0),
  created_at timestamptz NOT NULL DEFAULT now(), CHECK((ticket_id IS NULL) <> (booking_id IS NULL))
);
CREATE UNIQUE INDEX membership_usage_ticket ON membership.usages(ticket_id) WHERE ticket_id IS NOT NULL;
CREATE UNIQUE INDEX membership_usage_booking ON membership.usages(booking_id) WHERE booking_id IS NOT NULL;

CREATE TABLE academy.centers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), branch_id uuid NOT NULL REFERENCES catalog.branches UNIQUE,
  name text NOT NULL, description text NOT NULL DEFAULT '', active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE academy.coaches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), center_id uuid NOT NULL REFERENCES academy.centers,
  user_id uuid NOT NULL REFERENCES identity.users, bio text NOT NULL DEFAULT '', active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(center_id,user_id)
);
CREATE TABLE academy.courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), center_id uuid NOT NULL REFERENCES academy.centers,
  sport_id uuid NOT NULL REFERENCES catalog.sports, name text NOT NULL, description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), active boolean NOT NULL DEFAULT true
);
CREATE TABLE academy.classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), course_id uuid NOT NULL REFERENCES academy.courses,
  coach_id uuid REFERENCES academy.coaches, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 1000),
  price integer NOT NULL CHECK(price>=0), currency text NOT NULL DEFAULT 'VND' CHECK(currency='VND'),
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CANCELLED','COMPLETED')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  CHECK(ends_at>starts_at)
);
CREATE INDEX ON academy.classes(course_id,status,starts_at);
CREATE TABLE academy.class_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), class_id uuid NOT NULL REFERENCES academy.classes,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(ends_at>starts_at), UNIQUE(class_id,starts_at)
);
CREATE TABLE academy.enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), class_id uuid NOT NULL REFERENCES academy.classes,
  user_id uuid NOT NULL REFERENCES identity.users, status text NOT NULL CHECK(status IN ('ENROLLED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  UNIQUE(class_id,user_id)
);
CREATE TABLE academy.attendance (
  session_id uuid NOT NULL REFERENCES academy.class_sessions, enrollment_id uuid NOT NULL REFERENCES academy.enrollments,
  present boolean NOT NULL, marked_by uuid NOT NULL REFERENCES identity.users,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id,enrollment_id)
);

CREATE TABLE social.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), branch_id uuid NOT NULL REFERENCES catalog.branches,
  organizer_id uuid NOT NULL REFERENCES identity.users, title text NOT NULL, description text NOT NULL DEFAULT '',
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 10000),
  ticket_price integer NOT NULL DEFAULT 0 CHECK(ticket_price>=0), currency text NOT NULL DEFAULT 'VND' CHECK(currency='VND'),
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CANCELLED','COMPLETED')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
  CHECK(ends_at>starts_at)
);
CREATE INDEX ON social.events(branch_id,status,starts_at);
CREATE TABLE social.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES social.events,
  branch_id uuid NOT NULL REFERENCES catalog.branches, user_id uuid NOT NULL REFERENCES identity.users,
  status text NOT NULL DEFAULT 'VALID' CHECK(status IN ('VALID','USED','CANCELLED')),
  qr_nonce_hash text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id,user_id)
);
CREATE INDEX ON social.tickets(user_id,status);
ALTER TABLE membership.usages ADD CONSTRAINT membership_usage_ticket_fk FOREIGN KEY(ticket_id) REFERENCES social.tickets;
CREATE TABLE social.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES identity.users,
  name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);
CREATE TABLE social.team_members (
  team_id uuid NOT NULL REFERENCES social.teams, user_id uuid NOT NULL REFERENCES identity.users,
  joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(team_id,user_id)
);
CREATE TABLE social.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid NOT NULL REFERENCES social.teams,
  created_by uuid NOT NULL REFERENCES identity.users, token_hash text NOT NULL UNIQUE,
  max_uses integer NOT NULL DEFAULT 1 CHECK(max_uses BETWEEN 1 AND 100), uses integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE social.matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES social.events,
  home_team_id uuid REFERENCES social.teams, away_team_id uuid REFERENCES social.teams,
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','FINISHED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commerce.vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, branch_id uuid REFERENCES catalog.branches,
  amount_off integer NOT NULL CHECK(amount_off>0), quota integer NOT NULL CHECK(quota>0),
  valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), CHECK(valid_to>valid_from)
);
CREATE TABLE commerce.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES identity.users,
  branch_id uuid NOT NULL REFERENCES catalog.branches, subtotal integer NOT NULL CHECK(subtotal>=0),
  discount integer NOT NULL DEFAULT 0 CHECK(discount>=0), amount integer NOT NULL CHECK(amount>=0),
  currency text NOT NULL DEFAULT 'VND' CHECK(currency='VND'),
  voucher_id uuid REFERENCES commerce.vouchers,
  status text NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK(status IN ('PENDING_PAYMENT','CONFIRMED','CANCELLED','EXPIRED')),
  payment_expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1
);
CREATE INDEX ON commerce.orders(user_id,created_at DESC);
CREATE INDEX ON commerce.orders(branch_id,status);
CREATE TABLE commerce.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES commerce.orders,
  service_id uuid NOT NULL REFERENCES catalog.services, quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 20),
  unit_price integer NOT NULL CHECK(unit_price>=0), total integer NOT NULL CHECK(total>=0)
);
CREATE TABLE commerce.voucher_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), voucher_id uuid NOT NULL REFERENCES commerce.vouchers,
  order_id uuid NOT NULL UNIQUE REFERENCES commerce.orders, user_id uuid NOT NULL REFERENCES identity.users,
  status text NOT NULL CHECK(status IN ('RESERVED','REDEEMED','RELEASED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON commerce.voucher_redemptions(voucher_id,status);
CREATE TABLE commerce.order_history (
  id bigserial PRIMARY KEY, order_id uuid NOT NULL REFERENCES commerce.orders,
  from_status text, to_status text NOT NULL, reason text NOT NULL,
  actor_id uuid REFERENCES identity.users, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payment.intents ALTER COLUMN booking_id DROP NOT NULL;
ALTER TABLE payment.intents ADD COLUMN order_id uuid UNIQUE REFERENCES commerce.orders;
ALTER TABLE payment.intents ADD CONSTRAINT intent_exactly_one_target CHECK((booking_id IS NULL) <> (order_id IS NULL));

CREATE TABLE booking.series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES identity.users,
  yard_id uuid NOT NULL REFERENCES catalog.yards, frequency text NOT NULL CHECK(frequency='WEEKLY'),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE booking.bookings ADD COLUMN series_id uuid REFERENCES booking.series;
CREATE TABLE booking.participants (
  booking_id uuid NOT NULL REFERENCES booking.bookings, user_id uuid NOT NULL REFERENCES identity.users,
  status text NOT NULL CHECK(status IN ('INVITED','ACCEPTED','DECLINED')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(booking_id,user_id)
);
CREATE TABLE booking.services (
  booking_id uuid NOT NULL REFERENCES booking.bookings, service_id uuid NOT NULL REFERENCES catalog.services,
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 20), unit_price integer NOT NULL CHECK(unit_price>=0),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(booking_id,service_id)
);
CREATE TABLE booking.reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL UNIQUE REFERENCES booking.bookings,
  user_id uuid NOT NULL REFERENCES identity.users, rating integer NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), branch_id uuid REFERENCES catalog.branches,
  kind text NOT NULL DEFAULT 'GROUP' CHECK(kind IN ('DIRECT','GROUP','BRANCH')),
  title text NOT NULL, created_by uuid NOT NULL REFERENCES identity.users,
  next_seq bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE chat.members (
  conversation_id uuid NOT NULL REFERENCES chat.conversations, user_id uuid NOT NULL REFERENCES identity.users,
  role text NOT NULL CHECK(role IN ('OWNER','MEMBER')), last_read_seq bigint NOT NULL DEFAULT 0,
  joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(conversation_id,user_id)
);
CREATE INDEX ON chat.members(user_id);
CREATE TABLE chat.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES chat.conversations,
  seq bigint NOT NULL, sender_id uuid NOT NULL REFERENCES identity.users,
  body text NOT NULL, deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(conversation_id,seq)
);
CREATE INDEX ON chat.messages(conversation_id,seq);
CREATE TABLE chat.pins (
  conversation_id uuid NOT NULL REFERENCES chat.conversations, message_id uuid NOT NULL REFERENCES chat.messages,
  pinned_by uuid NOT NULL REFERENCES identity.users, pinned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(conversation_id,message_id)
);

CREATE TABLE media.uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES identity.users,
  object_key text NOT NULL UNIQUE, mime_type text NOT NULL, expected_size integer NOT NULL CHECK(expected_size BETWEEN 1 AND 10485760),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','UPLOADED','REJECTED','CLEAN')),
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE platform.audit_events (
  id bigserial PRIMARY KEY, actor_id uuid REFERENCES identity.users, action text NOT NULL,
  target_type text NOT NULL, target_id text NOT NULL, request_id text,
  details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
