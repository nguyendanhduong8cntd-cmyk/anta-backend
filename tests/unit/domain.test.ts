import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertTransition, validateSlot } from '../../modules/booking/domain';
import { fingerprint } from '../../packages/idempotency';
import { checkPassword, hashPassword } from '../../packages/auth/crypto';
import { signAccess, verifyAccess } from '../../packages/auth/tokens';
import { normalizeIdentifier } from '../../modules/identity/service';
import { loadConfig } from '../../packages/config';
import { parseCursor } from '../../apps/realtime/main';
const secret = 'unit-test-secret-with-more-than-32-characters';
test('booking state machine prevents terminal state reversal', () => {
  assert.doesNotThrow(() => assertTransition('PENDING_PAYMENT', 'CONFIRMED'));
  for (const status of ['CONFIRMED', 'CANCELLED', 'EXPIRED'] as const) assert.throws(() => assertTransition(status, 'PENDING_PAYMENT'));
  // A paid booking may only move to CANCELLED (with a refund); every other exit from a terminal state is refused.
  assert.doesNotThrow(() => assertTransition('CONFIRMED', 'CANCELLED'));
  assert.throws(() => assertTransition('CONFIRMED', 'EXPIRED'));
  assert.throws(() => assertTransition('CANCELLED', 'CONFIRMED'));
});
test('slot interval validation and integer pricing duration', () => {
  const now = Date.parse('2026-09-28T00:00:00Z');
  assert.equal(validateSlot('2026-09-29T09:00:00+07:00', '2026-09-29T11:00:00+07:00', now).hours, 2);
  assert.throws(() => validateSlot('2026-09-29T09:30:00+07:00', '2026-09-29T10:30:00+07:00', now));
  assert.throws(() => validateSlot('2026-09-27T09:00:00Z', '2026-09-27T10:00:00Z', now));
});
test('idempotency fingerprint ignores object field order but not values', () => {
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
});
test('passwords use salted hashes and constant-time verification', async () => {
  const left = await hashPassword('correct-horse-battery');
  assert.notEqual(left, await hashPassword('correct-horse-battery'));
  assert.equal(await checkPassword('correct-horse-battery', left), true);
  assert.equal(await checkPassword('wrong', left), false);
});
test('JWT verifies issuer/audience/signature', async () => {
  const jwt = await signAccess('user-id', 'session-id', secret);
  assert.deepEqual(await verifyAccess(jwt, secret), { userId: 'user-id', sessionId: 'session-id' });
  await assert.rejects(verifyAccess(jwt, secret + 'wrong'));
});
test('identifiers normalize and reject invalid phone formats', () => {
  assert.equal(normalizeIdentifier(' Demo@Example.com '), 'demo@example.com');
  assert.equal(normalizeIdentifier('+84912345678'), '+84912345678');
  assert.throws(() => normalizeIdentifier('0912345678'));
});
test('production refuses development providers and weak configuration', () => {
  const env = { DATABASE_URL: 'postgresql://localhost/x', REDIS_URL: 'redis://localhost', JWT_SECRET: secret, OTP_HASH_SECRET: secret,
    SANDBOX_WEBHOOK_SECRET: secret, PAYMENT_PROVIDER: 'sandbox', OTP_DELIVERY: 'development' };
  assert.equal(loadConfig(env).production, false);
  assert.throws(() => loadConfig({ ...env, NODE_ENV: 'production' }));
  assert.throws(() => loadConfig({ ...env, JWT_SECRET: 'weak' }));
});
test('realtime cursor preserves bigint precision and rejects SQL text', () => {
  assert.equal(parseCursor('999999999999999999'), '999999999999999999');
  assert.equal(parseCursor(undefined), '0');
  assert.throws(() => parseCursor('1;DROP TABLE'));
});
