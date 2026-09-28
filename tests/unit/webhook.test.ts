import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signWebhook, verifyWebhook } from '../../modules/payment/signature';
const secret = 'webhook-test-secret-with-32-characters';
test('sandbox webhook authenticates exact raw bytes and timestamp', () => {
  const raw = Buffer.from('{"intentId":"test","amount":180000}'), timestamp = '1801094400';
  const now = Number(timestamp) * 1000;
  const signature = signWebhook(raw, timestamp, secret);
  assert.doesNotThrow(() => verifyWebhook(raw, timestamp, signature, secret, now));
  assert.throws(() => verifyWebhook(Buffer.from('{}'), timestamp, signature, secret, now));
  assert.throws(() => verifyWebhook(raw, timestamp, signature, secret, now + 301000));
  assert.throws(() => verifyWebhook(raw, timestamp, undefined, secret, now));
});
