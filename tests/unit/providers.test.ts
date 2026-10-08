import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { loadConfig } from '../../packages/config';
import { payosCheckout, payosSign, payosSignatureText, payosWebhook, vnpayCheckout, vnpayDate, vnpayIpn, vnpayQuery, vnpayRefund, vnpaySign } from '../../modules/payment/providers';
import { bookingRefundPercent, orderRefundPercent, refundAmount } from '../../modules/payment/refunds';
import { channelOf, deliverOtp, otpText, twilioTransport } from '../../modules/identity/delivery';
const secret = 'unit-test-secret-with-more-than-32-characters';
const env = { DATABASE_URL: 'postgresql://localhost/x', REDIS_URL: 'redis://localhost', JWT_SECRET: secret, OTP_HASH_SECRET: secret,
  SANDBOX_WEBHOOK_SECRET: secret, PAYMENT_PROVIDER: 'sandbox', OTP_DELIVERY: 'development' };
const payosEnv = { ...env, PAYMENT_PROVIDER: 'payos', PAYMENT_RETURN_URL: 'https://app.example/return', PAYOS_CLIENT_ID: 'client',
  PAYOS_API_KEY: 'api-key', PAYOS_CHECKSUM_KEY: 'checksum-key-0123456789' };
const vnpayEnv = { ...env, PAYMENT_PROVIDER: 'vnpay', PAYMENT_RETURN_URL: 'https://app.example/return', VNPAY_TMN_CODE: 'TMN00001',
  VNPAY_HASH_SECRET: 'vnpay-secret-0123456789' };

test('configuration fails closed for real providers without credentials', () => {
  assert.throws(() => loadConfig({ ...env, PAYMENT_PROVIDER: 'stripe' }));
  assert.throws(() => loadConfig({ ...env, PAYMENT_PROVIDER: 'payos' }));
  assert.throws(() => loadConfig({ ...payosEnv, PAYOS_CHECKSUM_KEY: 'short' }));
  assert.throws(() => loadConfig({ ...vnpayEnv, PAYMENT_RETURN_URL: 'not a url' }));
  assert.equal(loadConfig(payosEnv).payos?.baseUrl, 'https://api-merchant.payos.vn');
  assert.equal(loadConfig(vnpayEnv).vnpay?.tmnCode, 'TMN00001');
  assert.throws(() => loadConfig({ ...env, OTP_DELIVERY: 'provider' }));
  assert.throws(() => loadConfig({ ...env, OTP_DELIVERY: 'provider', SMTP_HOST: 'smtp.example.com' }));
  assert.throws(() => loadConfig({ ...env, OTP_DELIVERY: 'provider', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+1555', DEV_OTP_ENABLED: 'true', DEV_ADMIN_KEY: secret }));
  const live = loadConfig({ ...payosEnv, NODE_ENV: 'production', OTP_DELIVERY: 'provider', SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'no-reply@example.com' });
  assert.deepEqual([live.production, live.smtp?.port, live.smtp?.secure, live.twilio], [true, 587, false, undefined]);
  assert.throws(() => loadConfig({ ...env, REFUND_PARTIAL_HOURS: '48' }));
});

test('PayOS signs sorted key=value pairs and rejects any altered webhook field', () => {
  const data = { orderCode: 100001, amount: 180000, description: 'Dat san 100001', reference: 'FT123', code: '00', desc: 'success', counterAccountName: null };
  assert.equal(payosSignatureText(data), 'amount=180000&code=00&counterAccountName=&desc=success&description=Dat san 100001&orderCode=100001&reference=FT123');
  const key = 'checksum-key-0123456789';
  assert.equal(payosSign(data, key), createHmac('sha256', key).update(payosSignatureText(data)).digest('hex'));
  const body = { code: '00', desc: 'success', success: true, data, signature: payosSign(data, key) };
  assert.deepEqual(payosWebhook(body, key), { eventId: 'payos:100001:FT123', orderCode: '100001', amount: 180000, currency: 'VND', paid: true, providerRef: 'FT123', paidAt: undefined });
  assert.throws(() => payosWebhook({ ...body, data: { ...data, amount: 1 } }, key));
  assert.throws(() => payosWebhook(body, key + 'x'));
  assert.throws(() => payosWebhook({ ...body, signature: undefined }, key));
  assert.equal(payosWebhook({ ...body, success: false }, key).paid, false);
});

test('PayOS checkout posts a signed request and surfaces provider rejection', async () => {
  const config = loadConfig(payosEnv), calls: any[] = [];
  const request = { orderCode: '100002', amount: 50000, description: 'A description longer than twenty-five characters', expiresAt: new Date('2026-10-08T00:00:00Z'), clientIp: '1.2.3.4' };
  const ok = (async (url: any, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ code: '00', data: { checkoutUrl: 'https://pay/x', qrCode: 'qr' } })); }) as typeof fetch;
  assert.deepEqual(await payosCheckout(config, request, ok), { checkoutUrl: 'https://pay/x', qrCode: 'qr' });
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, 'https://api-merchant.payos.vn/v2/payment-requests');
  assert.equal(sent.description.length, 25);
  assert.equal(sent.signature, payosSign({ amount: 50000, cancelUrl: config.paymentCancelUrl, description: sent.description, orderCode: 100002, returnUrl: config.paymentReturnUrl }, config.payos!.checksumKey));
  await assert.rejects(payosCheckout(config, request, (async () => new Response(JSON.stringify({ code: '20', desc: 'bad' }))) as typeof fetch), /rejected/);
  await assert.rejects(payosCheckout(config, request, (async () => { throw new Error('offline'); }) as typeof fetch), /unavailable/);
});

test('VNPay pay URL, IPN verification and refund request use HMAC-SHA512', async () => {
  const config = loadConfig(vnpayEnv), now = new Date('2026-10-07T03:04:05Z');
  assert.equal(vnpayDate(now), '20261007100405');
  assert.equal(vnpayQuery({ b: 'x y', a: 'ư&=', empty: '' }), 'a=%C6%B0%26%3D&b=x+y');
  const checkout = vnpayCheckout(config, { orderCode: '100003', amount: 180000, description: 'Dat san 100003', expiresAt: new Date('2026-10-07T03:19:05Z'), clientIp: '::ffff:10.0.0.9' }, now);
  const url = new URL(checkout.checkoutUrl!), params: Record<string, string> = {};
  for (const [name, value] of url.searchParams) if (name !== 'vnp_SecureHash') params[name] = value;
  assert.deepEqual([params.vnp_Amount, params.vnp_IpAddr, params.vnp_CreateDate, params.vnp_ExpireDate, params.vnp_ReturnUrl],
    ['18000000', '10.0.0.9', '20261007100405', '20261007101905', 'https://app.example/return']);
  assert.equal(url.searchParams.get('vnp_SecureHash'), createHmac('sha512', config.vnpay!.hashSecret).update(vnpayQuery(params)).digest('hex'));
  const ipn = { vnp_Amount: '18000000', vnp_TxnRef: '100003', vnp_TransactionNo: '777', vnp_PayDate: '20261007100500', vnp_ResponseCode: '00', vnp_TransactionStatus: '00' };
  const signed = { ...ipn, vnp_SecureHash: vnpaySign(ipn, config.vnpay!.hashSecret), vnp_SecureHashType: 'HmacSHA512' };
  assert.deepEqual(vnpayIpn(signed, config.vnpay!.hashSecret), { eventId: 'vnpay:100003:777', orderCode: '100003', amount: 180000, currency: 'VND', paid: true, providerRef: '777', paidAt: '20261007100500' });
  assert.equal(vnpayIpn({ ...signed, vnp_Amount: '100' }, config.vnpay!.hashSecret), null);
  assert.equal(vnpayIpn({ ...ipn }, config.vnpay!.hashSecret), null);
  assert.equal(vnpayIpn({ ...signed, vnp_ResponseCode: '24', vnp_SecureHash: vnpaySign({ ...ipn, vnp_ResponseCode: '24' }, config.vnpay!.hashSecret) }, config.vnpay!.hashSecret)?.paid, false);
  let sent: any;
  const http = (async (_url: any, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ vnp_ResponseCode: '00', vnp_TransactionNo: '888' })); }) as typeof fetch;
  const refund = { refundId: '11111111-2222-4333-8444-555555555555', orderCode: '100003', amount: 90000, full: false, providerRef: '777', paidAt: '20261007100500', reason: 'booking cancelled' };
  assert.deepEqual(await vnpayRefund(config, refund, http, now), { status: 'SUCCEEDED', providerRef: '888' });
  assert.deepEqual([sent.vnp_Command, sent.vnp_TransactionType, sent.vnp_Amount, sent.vnp_RequestId], ['refund', '03', '9000000', '11111111222243338444555555555555']);
  assert.equal(sent.vnp_SecureHash, createHmac('sha512', config.vnpay!.hashSecret).update(
    `${sent.vnp_RequestId}|2.1.0|refund|TMN00001|03|100003|9000000|777|20261007100500|alobo-backend|20261007100405|127.0.0.1|booking cancelled`).digest('hex'));
  assert.deepEqual(await vnpayRefund(config, { ...refund, providerRef: null }, http, now), { status: 'MANUAL_REVIEW' });
  assert.equal((await vnpayRefund(config, refund, (async () => new Response(JSON.stringify({ vnp_ResponseCode: '94' }))) as typeof fetch, now)).status, 'FAILED');
});

test('refund policy: full, partial, closed', () => {
  const policy = loadConfig(env).refund, now = Date.parse('2026-10-07T00:00:00Z'), at = (hours: number) => new Date(now + hours * 3600000);
  assert.deepEqual([bookingRefundPercent(at(48), now, policy), bookingRefundPercent(at(24), now, policy), bookingRefundPercent(at(23.9), now, policy),
    bookingRefundPercent(at(2), now, policy), bookingRefundPercent(at(1.9), now, policy), bookingRefundPercent(at(-1), now, policy)], [100, 100, 50, 50, 0, 0]);
  assert.deepEqual([orderRefundPercent(at(-1), now, policy), orderRefundPercent(at(-25), now, policy)], [100, 0]);
  assert.deepEqual([refundAmount(180000, 100), refundAmount(180001, 50), refundAmount(1, 50)], [180000, 90000, 0]);
});

test('OTP delivery picks the channel from the identifier and never leaks transport errors', async () => {
  const sent: any[] = [];
  const transports = { email: async (to: string, subject: string, text: string) => { sent.push({ to, subject, text }); }, sms: async (to: string, text: string) => { sent.push({ to, text }); } };
  assert.deepEqual([channelOf('a@b.co'), channelOf('+84912345678')], ['email', 'sms']);
  assert.equal(await deliverOtp(transports, { identifier: 'a@b.co', code: '123456', purpose: 'register' }), 'email');
  assert.equal(await deliverOtp(transports, { identifier: '+84912345678', code: '654321', purpose: 'reset-password' }), 'sms');
  assert.ok(sent[0].text.includes('123456') && sent[1].text.includes('654321') && sent[1].to === '+84912345678');
  // GSM-7 only, single segment.
  assert.ok(/^[\x20-\x7e]{1,160}$/.test(otpText({ identifier: '+84912345678', code: '654321', purpose: 'reset-password' })));
  await assert.rejects(deliverOtp({ email: transports.email }, { identifier: '+84912345678', code: '1', purpose: 'register' }), /sms is not available/);
  await assert.rejects(deliverOtp({ sms: async () => { throw new Error('twilio 401: bad token abc'); } }, { identifier: '+84912345678', code: '1', purpose: 'register' }),
    (error: Error) => !error.message.includes('abc') && /Could not send/.test(error.message));
  let request: any;
  const sms = twilioTransport({ accountSid: 'AC123', authToken: 'tok', from: '+15550001111' }, (async (url: any, init: any) => { request = { url, init }; return new Response('{}', { status: 201 }); }) as typeof fetch)!;
  await sms('+84912345678', 'hello');
  assert.equal(request.url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
  assert.equal(request.init.headers.Authorization, `Basic ${Buffer.from('AC123:tok').toString('base64')}`);
  assert.deepEqual(Object.fromEntries(request.init.body), { To: '+84912345678', Body: 'hello', From: '+15550001111' });
  await assert.rejects(twilioTransport({ accountSid: 'AC123', authToken: 'tok', from: 'MG1' }, (async () => new Response('{}', { status: 401 })) as typeof fetch)!('+1', 'x'));
});
