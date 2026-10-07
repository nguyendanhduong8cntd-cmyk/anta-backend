ALTER TABLE identity.users ADD COLUMN password_login_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE social.events ADD COLUMN membership_required boolean NOT NULL DEFAULT false;
