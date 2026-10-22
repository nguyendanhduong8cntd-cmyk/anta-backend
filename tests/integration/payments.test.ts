import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { INestApplication } from '@nestjs/common';
import { createApplication } from '../../apps/api/bootstrap';
import { migrate } from '../../scripts/migrate';
import { seed, demoIds } from '../../scripts/seed';
import { signWebhook } from '../../modules/payment/signature';
import { payosSign, vnpaySign } from '../../modules/payment/providers';
import { IdentityService } from '../../modules/identity/service';
import { RefundService } from '../../modules/payment/refunds';
import { buildOpenApi } from '../../packages/contracts/openapi';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://anta:anta_local@127.0.0.1:55432/anta_test';
assert.match(new URL(process.env.DATABASE_URL).pathname, /_test$/);
process.env.NODE_ENV = 'test';
process.env.PAYMENT_PROVIDER = 'sandbox';
process.env.OTP_DELIVERY = 'development';
delete process.env.OTP_DEV_PUSH;
process.env.DEV_OTP_ENABLED = 'true';
process.env.DEV_ADMIN_KEY = 'integration-tests-only-development-key-32';
process.env.FCM_ENABLED = 'false';
const runId = randomUUID().slice(0, 8);
process.env.REDIS_KEY_PREFIX = `anta-payments-${runId}:`;
const branchId = randomUUID(), yardId = randomUUID(), serviceId = randomUUID();
const payosKey = 'payos-checksum-key-for-tests-only', vnpaySecret = 'vnpay-hash-secret-for-tests-only';
let app: INestApplication, origin: string, base: string, pool: Pool, fakePayos: Server, payosRequests: any[] = [];
type Account = { user: { id: string }; accessToken: string; refreshToken: string; identifier: string };
let admin: Account, alice: Account, bob: Account, leaver: Account;

async function request(path: string, method = 'GET', body?: unknown, jwt?: string, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json',
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
const key = () => ({ 'Idempotency-Key': randomUUID() });
async function account(suffix: string): Promise<Account> {
  const identifier = `${runId}-${suffix}@example.com`;
  const sent = await request('/public/auth/otp/send', 'POST', { identifier, purpose: 'register' });
  assert.equal(sent.status, 201);
  const code = await request(`/dev/otp/${sent.body.data.challengeId}`, 'GET', undefined, undefined, { 'X-Dev-Key': process.env.DEV_ADMIN_KEY! });
  const verified = await request('/public/auth/otp/verify', 'POST', { challengeId: sent.body.data.challengeId, code: code.body.data.code });
  const registered = await request('/public/auth/register', 'POST', { identifier, password: 'test-password-long-123',
    displayName: `Pay ${suffix}`, deviceId: 'test-device', verificationToken: verified.body.data.verificationToken });
  assert.equal(registered.status, 201);
  return { ...registered.body.data, identifier };
}
async function sandboxPay(intent: { id: string; amount: number }) {
  const raw = Buffer.from(JSON.stringify({ eventId: randomUUID(), intentId: intent.id, status: 'paid', amount: intent.amount, currency: 'VND' }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(`${base}/webhooks/payments/sandbox`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json',
    'X-Webhook-Timestamp': timestamp, 'X-Webhook-Signature': signWebhook(raw, timestamp, process.env.SANDBOX_WEBHOOK_SECRET!) } });
  return { status: response.status, body: await response.json() as any };
}
/** Whole-hour slot `days` ahead at 10:00 + `hour` in Asia/Ho_Chi_Minh, inside the 06-23 opening window. */
function slot(days: number, hour: number) {
  const start = new Date(Math.floor(Date.now() / 86400000) * 86400000 + days * 86400000 + (3 + hour) * 3600000);
  return { yardId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600000).toISOString() };
}
async function pendingBooking(user: Account, days: number, hour: number) {
  const hold = await request('/booking-holds', 'POST', slot(days, hour), user.accessToken, key());
  assert.equal(hold.status, 201, JSON.stringify(hold.body));
  const booking = await request('/bookings', 'POST', { holdId: hold.body.data.holdId }, user.accessToken, key());
  assert.equal(booking.status, 201);
  return booking.body.data;
}
async function paidBooking(user: Account, days: number, hour: number) {
  const booking = await pendingBooking(user, days, hour);
  const intent = await request('/payment-intents', 'POST', { bookingId: booking.id }, user.accessToken, key());
  assert.equal(intent.status, 201, JSON.stringify(intent.body));
  assert.equal((await sandboxPay(intent.body.data)).body.data.outcome, 'SUCCEEDED');
  return { booking, intent: intent.body.data };
}
function useProvider(name: 'sandbox' | 'payos' | 'vnpay') {
  process.env.PAYMENT_PROVIDER = name;
  process.env.PAYMENT_RETURN_URL = 'anta://payment/return';
  process.env.PAYOS_CLIENT_ID = 'test-client'; process.env.PAYOS_API_KEY = 'test-api-key'; process.env.PAYOS_CHECKSUM_KEY = payosKey;
  process.env.PAYOS_BASE_URL = `http://127.0.0.1:${(fakePayos.address() as AddressInfo).port}`;
  process.env.VNPAY_TMN_CODE = 'TESTTMN1'; process.env.VNPAY_HASH_SECRET = vnpaySecret;
}

before(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await migrate(pool); await seed(pool);
  await pool.query(`INSERT INTO catalog.branches(id,shop_id,name,address,description,location,timezone,opening_hour,closing_hour)
    SELECT $1,shop_id,name,address,description,ST_SetSRID(ST_MakePoint(108.2022,16.0544),4326)::geography,timezone,opening_hour,closing_hour
    FROM catalog.branches WHERE id=$2`, [branchId, demoIds.branch]);
  await pool.query(`INSERT INTO catalog.yards(id,branch_id,sport_id,name,hourly_price,currency)
    SELECT $1,$2,sport_id,name,hourly_price,currency FROM catalog.yards WHERE id=$3`, [yardId, branchId, demoIds.yard]);
  await pool.query("INSERT INTO catalog.services(id,branch_id,name,price) VALUES($1,$2,'Thuê vợt',30000)", [serviceId, branchId]);
  // Stand-in for the PayOS API: records what the backend sends and answers like a created payment link.
  fakePayos = createServer((req, res) => {
    let text = ''; req.on('data', chunk => { text += chunk; });
    req.on('end', () => { const body = JSON.parse(text); payosRequests.push({ url: req.url, headers: req.headers, body });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: '00', desc: 'success', data: { checkoutUrl: `https://pay.payos.test/${body.orderCode}`, qrCode: 'QR-DATA', paymentLinkId: 'link-1' } })); });
  });
  await new Promise<void>(resolve => fakePayos.listen(0, '127.0.0.1', resolve));
  app = await createApplication(); await app.listen(0, '127.0.0.1');
  origin = await app.getUrl(); base = `${origin}/api/v1`;
  [admin, alice, bob, leaver] = await Promise.all(['admin', 'alice', 'bob', 'leaver'].map(account));
  await pool.query("INSERT INTO identity.roles(user_id,role) VALUES($1,'admin')", [admin.user.id]);
});
after(async () => { await app?.close(); await pool?.end(); await new Promise(resolve => fakePayos?.close(resolve)); });

test('cancelling a paid booking refunds by policy and frees the slot', async () => {
  const { booking, intent } = await paidBooking(alice, 3, 0);
  const cancelKey = key();
  const cancelled = await request(`/bookings/${booking.id}/cancel`, 'POST', undefined, alice.accessToken, cancelKey);
  assert.equal(cancelled.status, 201, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.status, 'CANCELLED');
  assert.deepEqual({ amount: cancelled.body.data.refund.amount, percent: cancelled.body.data.refund.percent, status: cancelled.body.data.refund.status },
    { amount: intent.amount, percent: 100, status: 'SUCCEEDED' });
  // Retrying the same cancel returns the same result and never creates a second refund.
  assert.equal((await request(`/bookings/${booking.id}/cancel`, 'POST', undefined, alice.accessToken, cancelKey)).body.data.refund.id, cancelled.body.data.refund.id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment.refunds WHERE intent_id=$1', [intent.id])).rows[0].n, 1);
  const mine = await request('/users/me/refunds', 'GET', undefined, alice.accessToken);
  assert.ok(mine.body.data.some((row: any) => row.id === cancelled.body.data.refund.id));
  assert.equal((await request('/users/me/refunds', 'GET', undefined, bob.accessToken)).body.data.length, 0);
  // The released slot can be booked by someone else.
  assert.equal((await request('/booking-holds', 'POST', slot(3, 0), bob.accessToken, key())).status, 201);
});

test('late cancellation refunds partially, then closes', async () => {
  const { booking, intent } = await paidBooking(alice, 4, 1);
  // Move the confirmed booking inside the partial window (2h <= lead < 24h), then inside the closed window.
  await pool.query("UPDATE booking.bookings SET starts_at=now()+interval '5 hours',ends_at=now()+interval '6 hours' WHERE id=$1", [booking.id]);
  const partial = await request(`/bookings/${booking.id}/cancel`, 'POST', undefined, alice.accessToken, key());
  assert.equal(partial.body.data.refund.percent, 50);
  assert.equal(partial.body.data.refund.amount, Math.floor(intent.amount / 2));
  const second = await paidBooking(alice, 4, 2);
  await pool.query("UPDATE booking.bookings SET starts_at=now()+interval '1 hour',ends_at=now()+interval '2 hours' WHERE id=$1", [second.booking.id]);
  const closed = await request(`/bookings/${second.booking.id}/cancel`, 'POST', undefined, alice.accessToken, key());
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error.code, 'CANCELLATION_WINDOW_CLOSED');
  // Paid but never confirmed by the owner in this test, so it stays in the awaiting-confirmation state.
  assert.equal((await request(`/bookings/${second.booking.id}`, 'GET', undefined, alice.accessToken)).body.data.status, 'PENDING_OWNER_CONFIRMATION');
});

test('paid order can be cancelled for a full refund', async () => {
  const order = await request('/orders', 'POST', { branchId, items: [{ serviceId, quantity: 2 }] }, alice.accessToken, key());
  assert.equal(order.status, 201, JSON.stringify(order.body));
  const intent = await request('/payment-intents', 'POST', { orderId: order.body.data.id }, alice.accessToken, key());
  assert.equal((await sandboxPay(intent.body.data)).body.data.outcome, 'SUCCEEDED');
  const cancelled = await request(`/orders/${order.body.data.id}/cancel`, 'POST', undefined, alice.accessToken, key());
  assert.equal(cancelled.body.data.status, 'CANCELLED');
  assert.deepEqual([cancelled.body.data.refund.amount, cancelled.body.data.refund.status], [60000, 'SUCCEEDED']);
});

test('events, courses and membership plans are gone: their routes are 404 and an intent pays for a booking or an order only', async () => {
  for (const [method, path] of [['GET', '/events'], ['GET', '/users/me/tickets'], ['POST', '/teams'], ['GET', '/academy/courses'], ['GET', '/users/me/class-sessions'],
    ['GET', '/public/membership-plans'], ['GET', '/users/me/membership-contracts']]) {
    const gone = await request(path, method, undefined, alice.accessToken);
    assert.deepEqual([gone.status, gone.body.error?.code], [404, 'NOT_FOUND'], `${method} ${path}`);
  }
  assert.deepEqual(Object.keys(buildOpenApi(app).paths).filter(path => /\/(events|tickets|teams|matches|academy|membership-\w+|class-sessions)\b/.test(path)), []);
  const features = (await request('/public/config')).body.data.features;
  assert.deepEqual(Object.keys(features).filter(flag => /membership|academy|class|event|ticket/i.test(flag)), []);
  // Neither the request nor the table accepts a membership contract, a class enrollment or an event ticket as the thing paid for.
  for (const target of ['contractId', 'enrollmentId', 'ticketId']) {
    const refused = await request('/payment-intents', 'POST', { [target]: randomUUID() }, alice.accessToken, key());
    assert.deepEqual([refused.status, refused.body.error.code], [400, 'VALIDATION_FAILED'], target);
  }
  const none = await request('/payment-intents', 'POST', {}, alice.accessToken, key());
  assert.deepEqual([none.status, none.body.error.code, none.body.error.message], [400, 'INVALID_PAYMENT_TARGET', 'Specify exactly one of bookingId or orderId']);
  const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='payment' AND table_name='intents'")).rows.map(row => row.column_name);
  assert.deepEqual(columns.filter(name => name.endsWith('_id')).sort(), ['booking_id', 'order_id', 'user_id']);
  await assert.rejects(pool.query(`INSERT INTO payment.intents(user_id,provider,amount,currency,expires_at)
    VALUES($1,'sandbox',1000,'VND',now()+interval '15 minutes')`, [alice.user.id]), (error: any) => error.constraint === 'intent_exactly_one_target');
  assert.deepEqual((await pool.query("SELECT nspname FROM pg_namespace WHERE nspname IN ('membership','academy','social')")).rows, []);
});

test('payment that arrives after the deadline goes to review and an admin refunds it', async () => {
  const booking = await pendingBooking(bob, 6, 3);
  const intent = await request('/payment-intents', 'POST', { bookingId: booking.id }, bob.accessToken, key());
  await pool.query("UPDATE booking.bookings SET payment_expires_at=now()-interval '1 minute' WHERE id=$1", [booking.id]);
  assert.equal((await sandboxPay(intent.body.data)).body.data.outcome, 'NEEDS_REVIEW');
  assert.equal((await request(`/admin/payment-intents/${intent.body.data.id}/refund`, 'POST', undefined, bob.accessToken)).status, 403);
  const listed = await request('/admin/payment-intents?status=NEEDS_REVIEW', 'GET', undefined, admin.accessToken);
  assert.ok(listed.body.data.some((row: any) => row.id === intent.body.data.id));
  const refunded = await request(`/admin/payment-intents/${intent.body.data.id}/refund`, 'POST', undefined, admin.accessToken);
  assert.equal(refunded.status, 200, JSON.stringify(refunded.body));
  assert.deepEqual([refunded.body.data.amount, refunded.body.data.status], [intent.body.data.amount, 'SUCCEEDED']);
  const stats = await request('/admin/stats', 'GET', undefined, admin.accessToken);
  assert.equal(stats.status, 200);
  assert.ok(Number(stats.body.data.payments.refunded) >= intent.body.data.amount);
  assert.equal((await request('/admin/stats', 'GET', undefined, alice.accessToken)).status, 403);
});

test('PayOS checkout is signed, and only a correctly signed webhook confirms the booking', async () => {
  useProvider('payos');
  try {
    const booking = await pendingBooking(bob, 7, 4);
    const intent = await request('/payment-intents', 'POST', { bookingId: booking.id }, bob.accessToken, key());
    assert.equal(intent.status, 201, JSON.stringify(intent.body));
    const data = intent.body.data, sent = payosRequests.at(-1);
    assert.deepEqual([data.provider, data.checkoutUrl, data.qrCode], ['payos', `https://pay.payos.test/${data.order_code}`, 'QR-DATA']);
    assert.deepEqual([sent.url, sent.headers['x-client-id'], sent.headers['x-api-key']], ['/v2/payment-requests', 'test-client', 'test-api-key']);
    const { signature, expiredAt, ...signed } = sent.body;
    assert.equal(signature, payosSign(signed, payosKey));
    assert.equal(sent.body.amount, data.amount);
    const payload = { orderCode: Number(data.order_code), amount: data.amount, description: sent.body.description, accountNumber: '12345678',
      reference: `FT${runId}`, transactionDateTime: '2026-10-07 10:00:00', currency: 'VND', paymentLinkId: 'link-1', code: '00', desc: 'success' };
    const forged = await request('/webhooks/payments/payos', 'POST', { code: '00', desc: 'success', success: true, data: payload, signature: payosSign({ ...payload, amount: 1 }, payosKey) });
    assert.equal(forged.status, 401);
    assert.equal((await request(`/bookings/${booking.id}`, 'GET', undefined, bob.accessToken)).body.data.status, 'PENDING_PAYMENT');
    const body = { code: '00', desc: 'success', success: true, data: payload, signature: payosSign(payload, payosKey) };
    const accepted = await request('/webhooks/payments/payos', 'POST', body);
    assert.deepEqual([accepted.status, accepted.body.data.outcome], [200, 'SUCCEEDED']);
    assert.equal((await request('/webhooks/payments/payos', 'POST', body)).body.data.duplicate, true);
    assert.equal((await request(`/bookings/${booking.id}`, 'GET', undefined, bob.accessToken)).body.data.status, 'PENDING_OWNER_CONFIRMATION');
    // PayOS probes the webhook URL with an order it never created; that must be acknowledged, not rejected.
    const probe = { ...payload, orderCode: 123, reference: 'probe' };
    assert.equal((await request('/webhooks/payments/payos', 'POST', { code: '00', desc: 'success', success: true, data: probe, signature: payosSign(probe, payosKey) })).status, 200);
    // PayOS has no refund API: the refund waits for an admin to record the manual payout.
    const cancelled = await request(`/bookings/${booking.id}/cancel`, 'POST', undefined, bob.accessToken, key());
    assert.equal(cancelled.body.data.refund.status, 'PENDING');
    await app.get(RefundService).processPending();
    const queue = await request('/admin/refunds?status=MANUAL_REVIEW', 'GET', undefined, admin.accessToken);
    assert.ok(queue.body.data.some((row: any) => row.id === cancelled.body.data.refund.id));
    const resolved = await request(`/admin/refunds/${cancelled.body.data.refund.id}/resolve`, 'POST', { outcome: 'SUCCEEDED', providerRef: 'BANK-REF-1' }, admin.accessToken);
    assert.deepEqual([resolved.status, resolved.body.data.status, resolved.body.data.provider_ref], [200, 'SUCCEEDED', 'BANK-REF-1']);
    assert.equal((await request(`/admin/refunds/${cancelled.body.data.refund.id}/resolve`, 'POST', { outcome: 'FAILED' }, admin.accessToken)).status, 409);
    // The sandbox route is closed while a real provider is active.
    assert.equal((await sandboxPay({ id: data.id, amount: data.amount })).status, 404);
  } finally { useProvider('sandbox'); }
});

test('VNPay returns a signed pay URL and its IPN follows the RspCode contract', async () => {
  useProvider('vnpay');
  try {
    const booking = await pendingBooking(bob, 8, 5);
    const intent = await request('/payment-intents', 'POST', { bookingId: booking.id }, bob.accessToken, key());
    assert.equal(intent.status, 201, JSON.stringify(intent.body));
    const url = new URL(intent.body.data.checkoutUrl), sentParams: Record<string, string> = {};
    for (const [name, value] of url.searchParams) if (name !== 'vnp_SecureHash') sentParams[name] = value;
    assert.equal(url.searchParams.get('vnp_SecureHash'), vnpaySign(sentParams, vnpaySecret));
    assert.deepEqual([sentParams.vnp_Amount, sentParams.vnp_TxnRef, sentParams.vnp_TmnCode], [String(intent.body.data.amount * 100), intent.body.data.order_code, 'TESTTMN1']);
    const ipn = async (params: Record<string, string>, secret = vnpaySecret) => {
      const query = new URLSearchParams({ ...params, vnp_SecureHash: vnpaySign(params, secret) });
      return (await fetch(`${base}/webhooks/payments/vnpay/ipn?${query}`)).json() as Promise<any>;
    };
    const params = { vnp_TmnCode: 'TESTTMN1', vnp_Amount: sentParams.vnp_Amount, vnp_TxnRef: sentParams.vnp_TxnRef, vnp_TransactionNo: '14012345',
      vnp_PayDate: '20261007100000', vnp_ResponseCode: '00', vnp_TransactionStatus: '00', vnp_OrderInfo: 'Dat san', vnp_BankCode: 'NCB' };
    assert.equal((await ipn(params, 'wrong-secret-wrong-secret')).RspCode, '97');
    assert.equal((await ipn({ ...params, vnp_TxnRef: '999999999' })).RspCode, '01');
    assert.equal((await ipn({ ...params, vnp_Amount: '100' })).RspCode, '04');
    assert.equal((await request(`/bookings/${booking.id}`, 'GET', undefined, bob.accessToken)).body.data.status, 'PENDING_PAYMENT');
    assert.deepEqual(await ipn(params), { RspCode: '00', Message: 'Confirm Success' });
    assert.equal((await ipn(params)).RspCode, '02');
    assert.equal((await request(`/bookings/${booking.id}`, 'GET', undefined, bob.accessToken)).body.data.status, 'PENDING_OWNER_CONFIRMATION');
    const stored = (await pool.query('SELECT provider_ref,provider_paid_at FROM payment.transactions WHERE intent_id=$1', [intent.body.data.id])).rows[0];
    assert.deepEqual([stored.provider_ref, stored.provider_paid_at], ['14012345', '20261007100000']);
  } finally { useProvider('sandbox'); }
});

test('end-to-end encrypted conversation relays ciphertext only', async () => {
  const b64 = (bytes: number) => Buffer.alloc(bytes, 7).toString('base64');
  const bundle = (deviceId: string) => ({ deviceId, registrationId: 4242, identityKey: b64(33),
    signedPreKey: { keyId: 1, publicKey: b64(33), signature: b64(64) }, oneTimePreKeys: [{ keyId: 1, publicKey: b64(33) }, { keyId: 2, publicKey: b64(33) }] });
  assert.equal((await request('/crypto/handshake?deviceId=alice-phone-01', 'POST', {}, alice.accessToken)).body.data.registered, false);
  assert.equal((await request('/crypto/keys', 'POST', bundle('alice-phone-01'), alice.accessToken)).status, 201);
  assert.equal((await request('/crypto/keys', 'POST', bundle('bob-phone-0001'), bob.accessToken)).body.data.oneTimePreKeys, 2);
  assert.equal((await request('/crypto/keys', 'POST', { ...bundle('bob-phone-0001'), identityKey: 'not base64!' }, bob.accessToken)).status, 400);
  // Strangers cannot drain someone's prekeys.
  assert.equal((await request(`/crypto/keys/${bob.user.id}`, 'GET', undefined, alice.accessToken)).status, 404);
  const conversation = await request('/conversation', 'POST', { title: 'Secret', memberIds: [bob.user.id], encrypted: true }, alice.accessToken);
  assert.equal(conversation.body.data.encryption, 'E2E');
  const id = conversation.body.data.id;
  assert.equal((await request(`/conversation/${id}/accept`, 'POST', undefined, bob.accessToken)).status, 201);
  const first = await request(`/crypto/keys/${bob.user.id}`, 'GET', undefined, alice.accessToken);
  assert.deepEqual([first.body.data.devices.length, first.body.data.devices[0].oneTimePreKey.keyId], [1, 1]);
  // Each fetch consumes a different one-time prekey; when they run out the bundle still serves the signed prekey.
  assert.equal((await request(`/crypto/keys/${bob.user.id}`, 'GET', undefined, alice.accessToken)).body.data.devices[0].oneTimePreKey.keyId, 2);
  assert.equal((await request(`/crypto/keys/${bob.user.id}`, 'GET', undefined, alice.accessToken)).body.data.devices[0].oneTimePreKey, null);
  const plain = await request(`/conversation/${id}/message`, 'POST', { body: 'hello in the clear' }, alice.accessToken, key());
  assert.deepEqual([plain.status, plain.body.error.code], [400, 'ENCRYPTION_REQUIRED']);
  const ciphertext = Buffer.from('opaque-signal-ciphertext').toString('base64');
  const stranger = await request(`/conversation/${id}/message`, 'POST', { senderDeviceId: 'alice-phone-01',
    envelopes: [{ recipientId: leaver.user.id, deviceId: 'leaver-phone-1', kind: 'PREKEY', ciphertext }] }, alice.accessToken, key());
  assert.equal(stranger.body.error.code, 'UNKNOWN_RECIPIENT_DEVICE');
  const sent = await request(`/conversation/${id}/message`, 'POST', { senderDeviceId: 'alice-phone-01',
    envelopes: [{ recipientId: bob.user.id, deviceId: 'bob-phone-0001', kind: 'PREKEY', ciphertext }] }, alice.accessToken, key());
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.data.body, null);
  const inbox = await request(`/conversation/${id}/messages?deviceId=bob-phone-0001`, 'GET', undefined, bob.accessToken);
  assert.deepEqual(inbox.body.data[0].envelope, { kind: 'PREKEY', ciphertext });
  assert.deepEqual([inbox.body.data[0].body, inbox.body.data[0].sender_device_id], [null, 'alice-phone-01']);
  // Another device, or the sender, sees the message exists but receives no ciphertext it was not addressed.
  assert.equal((await request(`/conversation/${id}/messages?deviceId=bob-tablet-001`, 'GET', undefined, bob.accessToken)).body.data[0].envelope, null);
  assert.equal((await pool.query('SELECT body FROM chat.messages WHERE id=$1', [sent.body.data.id])).rows[0].body, '');
  // A plaintext conversation refuses envelopes.
  const open = await request('/conversation', 'POST', { title: 'Open', memberIds: [bob.user.id] }, alice.accessToken);
  assert.equal((await request(`/conversation/${open.body.data.id}/message`, 'POST', { senderDeviceId: 'alice-phone-01',
    envelopes: [{ recipientId: bob.user.id, deviceId: 'bob-phone-0001', kind: 'MESSAGE', ciphertext }] }, alice.accessToken, key())).body.error.code, 'ENCRYPTION_NOT_ENABLED');
});

test('account purge erases personal data after the grace period and keeps anonymised bookings', async () => {
  const { booking } = await paidBooking(leaver, 9, 6);
  await request(`/users/me/favorites/${branchId}`, 'POST', undefined, leaver.accessToken);
  const conversation = await request('/conversation', 'POST', { title: 'Goodbye', memberIds: [alice.user.id] }, leaver.accessToken);
  await request(`/conversation/${conversation.body.data.id}/message`, 'POST', { body: 'my phone is 0900000000' }, leaver.accessToken, key());
  const deletion = await request('/users/me', 'DELETE', { password: 'test-password-long-123' }, leaver.accessToken);
  assert.equal(deletion.status, 200, JSON.stringify(deletion.body));
  const identity = app.get(IdentityService);
  // Still inside the 30-day grace period: nothing is erased.
  assert.equal(await identity.purge(leaver.user.id), false);
  assert.equal((await pool.query('SELECT identifier FROM identity.users WHERE id=$1', [leaver.user.id])).rows[0].identifier, leaver.identifier);
  await pool.query("UPDATE identity.deletion_requests SET purge_after=now()-interval '1 minute' WHERE user_id=$1", [leaver.user.id]);
  assert.ok(await identity.purgeDue() >= 1);
  const user = (await pool.query('SELECT identifier,display_name,status,password_login_enabled FROM identity.users WHERE id=$1', [leaver.user.id])).rows[0];
  assert.deepEqual(user, { identifier: `deleted:${leaver.user.id}`, display_name: 'Deleted user', status: 'DELETED', password_login_enabled: false });
  for (const table of ['identity.refresh_sessions', 'catalog.favorites', 'notification.notifications', 'platform.outbox_events', 'platform.idempotency'])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`, [leaver.user.id])).rows[0].n, 0, table);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM chat.messages WHERE sender_id=$1 AND body<>''", [leaver.user.id])).rows[0].n, 0);
  // Accounting records survive, attached to the anonymised user.
  assert.equal((await pool.query('SELECT status FROM booking.bookings WHERE id=$1', [booking.id])).rows[0].status, 'PENDING_OWNER_CONFIRMATION');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM payment.intents WHERE user_id=$1 AND status='SUCCEEDED'", [leaver.user.id])).rows[0].n, 1);
  const completed = (await pool.query('SELECT completed_at,purge_summary FROM identity.deletion_requests WHERE user_id=$1', [leaver.user.id])).rows[0];
  assert.ok(completed.completed_at && completed.purge_summary.favorites === 1);
  assert.equal((await request('/public/auth/login', 'POST', { identifier: leaver.identifier, password: 'test-password-long-123', deviceId: 'test-device' })).status, 401);
  assert.equal(await identity.purge(leaver.user.id), false);
  const listed = await request('/admin/deletion-requests', 'GET', undefined, admin.accessToken);
  assert.ok(listed.body.data.some((row: any) => row.user_id === leaver.user.id && row.status === 'DELETED'));
});

test('admin portal is served as static files and its API is admin-only', async () => {
  const page = await fetch(`${origin}/admin/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /text\/html/);
  assert.match(await page.text(), /<script src="app\.js"><\/script>/);
  assert.equal((await fetch(`${origin}/admin/app.js`)).status, 200);
  // Helmet's CSP forbids inline scripts, so the portal cannot be turned into an XSS vector by injected markup.
  assert.match(page.headers.get('content-security-policy') || '', /script-src 'self'/);
  for (const path of ['/admin/users', '/admin/bookings', '/admin/refunds', '/admin/branches', '/admin/audit-events']) {
    assert.equal((await request(path, 'GET', undefined, alice.accessToken)).status, 403, path);
    assert.equal((await request(path, 'GET', undefined, admin.accessToken)).status, 200, path);
  }
  const found = await request(`/admin/users?q=${encodeURIComponent(alice.identifier)}`, 'GET', undefined, admin.accessToken);
  assert.deepEqual(found.body.data.map((row: any) => row.id), [alice.user.id]);
  assert.ok((await request('/admin/users?q=%25', 'GET', undefined, admin.accessToken)).body.data.length === 0);
});
