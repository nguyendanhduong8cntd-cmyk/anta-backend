-- Events, courses and membership plans are no longer part of the product: this removes their data model.
-- Destructive and not reversible. Booking and order payments are untouched.

-- 1. Payments made for a membership contract, a class enrollment or an event ticket, then the intents themselves.
DELETE FROM payment.refunds r USING payment.intents i
  WHERE i.id=r.intent_id AND coalesce(i.contract_id,i.enrollment_id,i.ticket_id) IS NOT NULL;
DELETE FROM payment.transactions t USING payment.intents i
  WHERE i.id=t.intent_id AND coalesce(i.contract_id,i.enrollment_id,i.ticket_id) IS NOT NULL;
DELETE FROM payment.webhook_events w USING payment.intents i
  WHERE i.id=w.intent_id AND coalesce(i.contract_id,i.enrollment_id,i.ticket_id) IS NOT NULL;
DELETE FROM payment.intents WHERE coalesce(contract_id,enrollment_id,ticket_id) IS NOT NULL;

-- 2. An intent pays for a booking or an order, nothing else.
DROP INDEX payment.payment_intent_live_contract, payment.payment_intent_live_enrollment, payment.payment_intent_live_ticket;
ALTER TABLE payment.intents DROP CONSTRAINT intent_exactly_one_target;
ALTER TABLE payment.intents DROP COLUMN contract_id, DROP COLUMN enrollment_id, DROP COLUMN ticket_id;
ALTER TABLE payment.intents ADD CONSTRAINT intent_exactly_one_target CHECK(num_nonnulls(booking_id,order_id)=1);

-- 3. The three schemas. Every table is named and nothing cascades: if anything else still depends on them,
-- the migration fails instead of dropping it.
DROP TABLE membership.usages, membership.contracts, membership.plans,
  academy.attendance, academy.class_sessions, academy.enrollments, academy.classes, academy.coaches, academy.courses, academy.centers,
  social.matches, social.invitations, social.team_members, social.teams, social.tickets, social.events;
DROP SCHEMA membership, academy, social;

-- 4. The coach role belonged to the academy; no permission check ever read it.
DELETE FROM identity.roles WHERE role='coach';
ALTER TABLE identity.roles DROP CONSTRAINT roles_role_check, DROP CONSTRAINT roles_check;
ALTER TABLE identity.roles ADD CONSTRAINT roles_role_check CHECK(role IN ('admin','support','branch_owner','branch_staff')),
  ADD CONSTRAINT roles_check CHECK((role IN ('admin','support') AND branch_id IS NULL) OR
    (role IN ('branch_owner','branch_staff') AND branch_id IS NOT NULL));
