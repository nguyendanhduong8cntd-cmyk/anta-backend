-- Real payment providers, paid membership/class/ticket targets, refunds, E2E key directory and account purge.
-- Additive: existing booking/payment rows remain valid.

-- 1. Payment intents: more providers and more payable targets.
ALTER TABLE payment.intents DROP CONSTRAINT intents_provider_check;
ALTER TABLE payment.intents ADD CONSTRAINT intents_provider_check CHECK(provider IN ('sandbox','payos','vnpay'));
ALTER TABLE payment.intents ADD COLUMN contract_id uuid REFERENCES membership.contracts;
ALTER TABLE payment.intents ADD COLUMN enrollment_id uuid REFERENCES academy.enrollments;
ALTER TABLE payment.intents ADD COLUMN ticket_id uuid REFERENCES social.tickets;
ALTER TABLE payment.intents DROP CONSTRAINT intent_exactly_one_target;
ALTER TABLE payment.intents ADD CONSTRAINT intent_exactly_one_target
  CHECK(num_nonnulls(booking_id,order_id,contract_id,enrollment_id,ticket_id)=1);
-- Membership, class and ticket rows can be paid again after an expired attempt; only live intents are unique.
CREATE UNIQUE INDEX payment_intent_live_contract ON payment.intents(contract_id) WHERE status IN ('CREATED','SUCCEEDED');
CREATE UNIQUE INDEX payment_intent_live_enrollment ON payment.intents(enrollment_id) WHERE status IN ('CREATED','SUCCEEDED');
CREATE UNIQUE INDEX payment_intent_live_ticket ON payment.intents(ticket_id) WHERE status IN ('CREATED','SUCCEEDED');
-- Provider-facing numeric order reference (PayOS orderCode, VNPay vnp_TxnRef). Never reuse the internal UUID.
CREATE SEQUENCE payment.order_code_seq START 100000;
ALTER TABLE payment.intents ADD COLUMN order_code bigint UNIQUE;
ALTER TABLE payment.intents ADD COLUMN checkout_url text;
ALTER TABLE payment.intents ADD COLUMN qr_code text;
-- Provider transaction reference needed to refund (VNPay vnp_TransactionNo / vnp_PayDate, PayOS reference).
ALTER TABLE payment.transactions ADD COLUMN provider_ref text;
ALTER TABLE payment.transactions ADD COLUMN provider_paid_at text;

-- 2. Paid targets reserve their seat while payment is pending.
ALTER TABLE membership.contracts DROP CONSTRAINT contracts_status_check;
ALTER TABLE membership.contracts ADD CONSTRAINT contracts_status_check
  CHECK(status IN ('PENDING_PAYMENT','ACTIVE','EXPIRED','CANCELLED'));
ALTER TABLE membership.contracts ADD COLUMN amount integer NOT NULL DEFAULT 0 CHECK(amount>=0);
ALTER TABLE membership.contracts ADD COLUMN currency text NOT NULL DEFAULT 'VND' CHECK(currency='VND');
ALTER TABLE membership.contracts ADD COLUMN payment_expires_at timestamptz;
ALTER TABLE academy.enrollments DROP CONSTRAINT enrollments_status_check;
ALTER TABLE academy.enrollments ADD CONSTRAINT enrollments_status_check
  CHECK(status IN ('PENDING_PAYMENT','ENROLLED','CANCELLED','EXPIRED'));
ALTER TABLE academy.enrollments ADD COLUMN amount integer NOT NULL DEFAULT 0 CHECK(amount>=0);
ALTER TABLE academy.enrollments ADD COLUMN currency text NOT NULL DEFAULT 'VND' CHECK(currency='VND');
ALTER TABLE academy.enrollments ADD COLUMN payment_expires_at timestamptz;
ALTER TABLE social.tickets DROP CONSTRAINT tickets_status_check;
ALTER TABLE social.tickets ADD CONSTRAINT tickets_status_check
  CHECK(status IN ('PENDING_PAYMENT','VALID','USED','CANCELLED','EXPIRED'));
ALTER TABLE social.tickets ADD COLUMN amount integer NOT NULL DEFAULT 0 CHECK(amount>=0);
ALTER TABLE social.tickets ADD COLUMN currency text NOT NULL DEFAULT 'VND' CHECK(currency='VND');
ALTER TABLE social.tickets ADD COLUMN payment_expires_at timestamptz;
CREATE INDEX membership_contracts_pending ON membership.contracts(payment_expires_at) WHERE status='PENDING_PAYMENT';
CREATE INDEX academy_enrollments_pending ON academy.enrollments(payment_expires_at) WHERE status='PENDING_PAYMENT';
CREATE INDEX social_tickets_pending ON social.tickets(payment_expires_at) WHERE status='PENDING_PAYMENT';

-- 3. Refunds. One refund per paid intent; money never moves without a row here.
CREATE TABLE payment.refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), intent_id uuid NOT NULL UNIQUE REFERENCES payment.intents,
  user_id uuid NOT NULL REFERENCES identity.users, amount integer NOT NULL CHECK(amount>0),
  currency text NOT NULL CHECK(currency='VND'), percent integer NOT NULL CHECK(percent BETWEEN 1 AND 100),
  reason text NOT NULL, status text NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','SUCCEEDED','FAILED','MANUAL_REVIEW')),
  provider_ref text, attempts integer NOT NULL DEFAULT 0, resolved_by uuid REFERENCES identity.users,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_refunds_open ON payment.refunds(created_at) WHERE status IN ('PENDING','MANUAL_REVIEW','FAILED');

-- 4. End-to-end encrypted chat: the server stores public keys and opaque per-device ciphertext only.
ALTER TABLE chat.conversations ADD COLUMN encryption text NOT NULL DEFAULT 'NONE' CHECK(encryption IN ('NONE','E2E'));
CREATE TABLE chat.device_keys (
  user_id uuid NOT NULL REFERENCES identity.users, device_id text NOT NULL,
  registration_id integer NOT NULL CHECK(registration_id BETWEEN 1 AND 16380),
  identity_key text NOT NULL, signed_prekey_id integer NOT NULL CHECK(signed_prekey_id>=0),
  signed_prekey text NOT NULL, signed_prekey_signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,device_id)
);
CREATE TABLE chat.one_time_prekeys (
  user_id uuid NOT NULL, device_id text NOT NULL, key_id integer NOT NULL CHECK(key_id>=0),
  public_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,device_id,key_id),
  FOREIGN KEY(user_id,device_id) REFERENCES chat.device_keys(user_id,device_id) ON DELETE CASCADE
);
CREATE TABLE chat.message_envelopes (
  message_id uuid NOT NULL REFERENCES chat.messages ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES identity.users, device_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('PREKEY','MESSAGE')), ciphertext text NOT NULL,
  PRIMARY KEY(message_id,recipient_id,device_id)
);
ALTER TABLE chat.messages ADD COLUMN sender_device_id text;

-- 5. Account purge bookkeeping.
ALTER TABLE identity.deletion_requests ADD COLUMN purge_summary jsonb;
CREATE INDEX identity_deletion_due ON identity.deletion_requests(purge_after) WHERE completed_at IS NULL;
