import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createApplication } from '../../apps/api/bootstrap';
import { migrate } from '../../scripts/migrate';
import { IdentityService } from '../../modules/identity/service';
import { OtpMessage } from '../../modules/identity/delivery';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://anta:anta_local@127.0.0.1:55432/anta_test';
assert.match(new URL(process.env.DATABASE_URL).pathname, /_test$/);
// A development backend with only an SMTP account: email reaches its owner, phone numbers have no provider.
// Both transports are replaced before the first request, so nothing leaves this machine.
Object.assign(process.env, {
  NODE_ENV: 'test', OTP_DELIVERY: 'provider', SMTP_HOST: 'smtp.invalid', SMTP_PORT: '465', SMTP_USER: 'tests', SMTP_PASS: 'tests',
  SMTP_FROM: 'Anta <no-reply@example.com>', DEV_OTP_ENABLED: 'true', DEV_ADMIN_KEY: 'integration-tests-only-development-key-32',
  OTP_DEV_PUSH: 'true', GOOGLE_APPLICATION_CREDENTIALS: 'never-read-by-these-tests.json', FCM_ENABLED: 'false',
});
for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'GOOGLE_CLIENT_ID', 'GOOGLE_JWKS_URL']) delete process.env[key];
const runId = randomUUID().slice(0, 8);
process.env.REDIS_KEY_PREFIX = `anta-otp-${runId}:`;

const devKey = { 'X-Dev-Key': process.env.DEV_ADMIN_KEY! };
const phoneToken = 'fcm-registration-token-of-the-test-phone';
const emails: { to: string; subject: string; text: string }[] = [];
const pushes: { token: string; message: OtpMessage }[] = [];
let emailDown = false, pushDown = false;
let app: INestApplication, base: string, pool: Pool;

async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
const send = (identifier: string, extra: object = {}, headers: Record<string, string> = {}) =>
  request('/public/auth/otp/send', 'POST', { identifier, purpose: 'register', ...extra }, headers);
const developmentCode = async (challengeId: string) => (await request(`/dev/otp/${challengeId}`, 'GET', undefined, devKey)).body.data?.code;
const phone = () => `+8490${randomInt(1000000, 10000000)}`;

before(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await migrate(pool);
  app = await createApplication(); await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/api/v1`;
  app.get(IdentityService).otpTransports = {
    email: async (to, subject, text) => { if (emailDown) throw new Error('SMTP is down'); emails.push({ to, subject, text }); },
    push: async (token, message) => { if (pushDown) throw new Error('FCM is down'); pushes.push({ token, message }); },
  };
});
after(async () => { await app?.close(); await pool?.end(); });

test('an email address gets its code only by email, even on a development phone holding the key', async () => {
  const identifier = `${runId}-mail@example.com`;
  const sent = await send(identifier, { fcmToken: phoneToken }, devKey);
  assert.equal(sent.status, 201);
  assert.equal(sent.body.data.delivery, 'email');
  assert.deepEqual(emails.map(email => email.to), [identifier]);
  // The development aids stand in for a channel this backend lacks; a code that went to the mailbox is read there.
  assert.equal(pushes.length, 0);
  const lookup = await request(`/dev/otp/${sent.body.data.challengeId}`, 'GET', undefined, devKey);
  assert.equal(lookup.status, 404);
  const code = emails[0].text.match(/\b\d{6}\b/)?.[0];
  const verified = await request('/public/auth/otp/verify', 'POST', { challengeId: sent.body.data.challengeId, code });
  assert.equal(verified.status, 201);
});

test('a phone number without an SMS provider still gets a code on a development backend, pushed to the phone that asked', async () => {
  pushes.length = 0;
  const sent = await send(phone(), { fcmToken: phoneToken }, devKey);
  assert.equal(sent.status, 201);
  assert.equal(sent.body.data.delivery, 'development-only');
  assert.deepEqual(pushes.map(pushed => pushed.message.code), [await developmentCode(sent.body.data.challengeId)]);
});

test('without the development key nothing is pushed, whatever token the caller names', async () => {
  pushes.length = 0;
  assert.equal((await send(phone(), { fcmToken: phoneToken })).status, 201);
  assert.equal((await send(phone(), { fcmToken: phoneToken }, { 'X-Dev-Key': 'not-the-development-key-not-the-key' })).status, 201);
  assert.equal(pushes.length, 0);
});

test('a failed push leaves the code usable, while a failed email spends it', async () => {
  pushDown = true;
  const pushed = await send(phone(), { fcmToken: phoneToken }, devKey);
  pushDown = false;
  assert.equal(pushed.status, 201);
  assert.match(await developmentCode(pushed.body.data.challengeId), /^\d{6}$/);

  emailDown = true;
  const identifier = `${runId}-down@example.com`;
  const mailed = await send(identifier);
  emailDown = false;
  assert.equal(mailed.status, 503);
  assert.equal(mailed.body.error.code, 'OTP_DELIVERY_FAILED');
  const challenge = (await pool.query('SELECT consumed_at FROM identity.otp_challenges WHERE identifier=$1', [identifier])).rows[0];
  assert.ok(challenge.consumed_at, 'an undelivered code must not stay valid');
});
