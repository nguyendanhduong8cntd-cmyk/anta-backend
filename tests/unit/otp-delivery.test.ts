import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../packages/config';
import { deliverOtp, devPushMessage, OtpMessage, otpEmail, otpText, realChannel } from '../../modules/identity/delivery';

const secret = 'unit-test-secret-with-more-than-32-characters';
const env = { DATABASE_URL: 'postgresql://localhost/x', REDIS_URL: 'redis://localhost', JWT_SECRET: secret, OTP_HASH_SECRET: secret,
  SANDBOX_WEBHOOK_SECRET: secret, PAYMENT_PROVIDER: 'sandbox', OTP_DELIVERY: 'development' };
const gmail = { OTP_DELIVERY: 'provider', SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_USER: 'anta@gmail.com',
  SMTP_PASS: 'app-password', SMTP_FROM: 'Anta <anta@gmail.com>' };
const devOtp = { DEV_OTP_ENABLED: 'true', DEV_ADMIN_KEY: secret };
const push = { OTP_DEV_PUSH: 'true', GOOGLE_APPLICATION_CREDENTIALS: 'secrets/firebase-service-account.json' };
const payos = { PAYMENT_PROVIDER: 'payos', PAYMENT_RETURN_URL: 'https://app.example/return', PAYOS_CLIENT_ID: 'client',
  PAYOS_API_KEY: 'api-key', PAYOS_CHECKSUM_KEY: 'checksum-key-0123456789' };

test('a development backend sends real email and keeps its own helpers for what it cannot deliver', () => {
  const config = loadConfig({ ...env, ...gmail, ...devOtp });
  assert.deepEqual([config.otpDelivery, config.devOtp, config.smtp?.host, config.smtp?.secure], ['provider', true, 'smtp.gmail.com', true]);
  assert.throws(() => loadConfig({ ...env, ...payos, ...gmail, ...devOtp, NODE_ENV: 'production' }), /blocked in production/);
});

test('pushing codes to the phone that asked needs development codes and the FCM service account, and never runs in production', () => {
  assert.equal(loadConfig({ ...env, ...devOtp, ...push }).devOtpPush, true);
  assert.equal(loadConfig({ ...env, ...devOtp }).devOtpPush, false);
  assert.throws(() => loadConfig({ ...env, ...push }), /DEV_OTP_ENABLED/);
  assert.throws(() => loadConfig({ ...env, ...devOtp, OTP_DEV_PUSH: 'true' }), /GOOGLE_APPLICATION_CREDENTIALS/);
  assert.throws(() => loadConfig({ ...env, ...payos, ...gmail, ...push, NODE_ENV: 'production' }), /blocked in production/);
});

test('a configured channel is used only for the identifiers it can reach', () => {
  const email = async () => {};
  assert.equal(realChannel({ email }, 'an@example.com'), 'email');
  assert.equal(realChannel({ email }, '+84912345678'), null);
  assert.equal(realChannel({ sms: async () => {} }, '+84912345678'), 'sms');
  assert.equal(realChannel({}, 'an@example.com'), null);
});

test('an emailed code is written in Vietnamese; a text message stays ASCII so it fits one SMS', async () => {
  const message: OtpMessage = { identifier: 'an@example.com', code: '123456', purpose: 'register' };
  const { subject, text } = otpEmail(message);
  assert.match(subject, /Anta/);
  assert.match(text, /123456/);
  assert.match(text, /đăng ký tài khoản/);
  assert.match(otpEmail({ ...message, purpose: 'reset-password' }).text, /đặt lại mật khẩu/);
  assert.match(otpText(message), /^[\x20-\x7e]+$/);

  const sent: unknown[][] = [];
  assert.equal(await deliverOtp({ email: async (...args) => { sent.push(args); } }, message), 'email');
  assert.deepEqual(sent, [['an@example.com', subject, text]]);
});

test('the development push carries the code as data, is urgent and is dropped once the code has expired', () => {
  assert.deepEqual(devPushMessage('fcm-token-of-the-phone', { identifier: '+84912345678', code: '654321', purpose: 'reset-password' }), {
    token: 'fcm-token-of-the-phone',
    data: { type: 'otp', code: '654321', purpose: 'reset-password' },
    android: { priority: 'high', ttl: 300000 },
  });
});
