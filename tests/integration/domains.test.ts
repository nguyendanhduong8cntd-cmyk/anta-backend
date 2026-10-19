import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { INestApplication } from '@nestjs/common';
import { createApplication } from '../../apps/api/bootstrap';
import { migrate } from '../../scripts/migrate';
import { seed, demoIds } from '../../scripts/seed';
import { signWebhook } from '../../modules/payment/signature';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://anta:anta_local@127.0.0.1:55432/anta_test';
assert.match(new URL(process.env.DATABASE_URL).pathname, /_test$/);
process.env.NODE_ENV = 'test';
process.env.DEV_OTP_ENABLED = 'true';
process.env.DEV_ADMIN_KEY = 'integration-tests-only-development-key-32';
process.env.FCM_ENABLED = 'false';
// Codes stay on this machine whatever the developer's .env holds: no SMTP, SMS or push from these tests.
process.env.OTP_DELIVERY = 'development';
for (const key of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'GOOGLE_CLIENT_ID', 'GOOGLE_JWKS_URL', 'OTP_DEV_PUSH']) delete process.env[key];
const runId = randomUUID().slice(0, 8);
process.env.REDIS_KEY_PREFIX = `anta-domains-${runId}:`;
const branchId = randomUUID();
const serviceId = randomUUID();
const yardId = randomUUID();
let app: INestApplication, base: string, pool: Pool;
let chatUsers: Awaited<ReturnType<typeof account>>[];

async function request(path: string, method = 'GET', body?: unknown, jwt?: string, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json',
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
const key = () => ({ 'Idempotency-Key': randomUUID() });
async function account(suffix: string) {
  const identifier = `${runId}-${suffix}@example.com`;
  const sent = await request('/public/auth/otp/send', 'POST', { identifier, purpose: 'register' });
  assert.equal(sent.status, 201);
  const challengeId = sent.body.data.challengeId;
  const code = await request(`/dev/otp/${challengeId}`, 'GET', undefined, undefined, { 'X-Dev-Key': process.env.DEV_ADMIN_KEY! });
  const verified = await request('/public/auth/otp/verify', 'POST', { challengeId, code: code.body.data.code });
  const registered = await request('/public/auth/register', 'POST', { identifier, password: 'test-password-long-123',
    displayName: 'Domain Test', deviceId: 'test-device', verificationToken: verified.body.data.verificationToken });
  assert.equal(registered.status, 201);
  return registered.body.data as { user: { id: string }; accessToken: string; refreshToken: string };
}
async function role(userId: string, name: string) {
  await pool.query('INSERT INTO identity.roles(user_id,role,branch_id) VALUES($1,$2,$3)', [userId, name, branchId]);
}
before(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await migrate(pool); await seed(pool);
  await pool.query(`INSERT INTO catalog.branches(id,shop_id,name,address,description,location,timezone,opening_hour,closing_hour)
    SELECT $1,shop_id,name,address,description,ST_SetSRID(ST_MakePoint(108.2022,16.0544),4326)::geography,timezone,opening_hour,closing_hour
    FROM catalog.branches WHERE id=$2`, [branchId, demoIds.branch]);
  await pool.query(`INSERT INTO catalog.services(id,branch_id,name,price)
    SELECT $1,$2,name,price FROM catalog.services WHERE branch_id=$3 LIMIT 1`, [serviceId, branchId, demoIds.branch]);
  await pool.query(`INSERT INTO catalog.yards(id,branch_id,sport_id,name,hourly_price,currency)
    SELECT $1,$2,sport_id,name,hourly_price,currency FROM catalog.yards WHERE id=$3`, [yardId, branchId, demoIds.yard]);
  app = await createApplication(); await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/api/v1`;
});
after(async () => { await app?.close(); await pool?.end(); });

test('voucher quota, order ownership, signed payment and cancellation', async () => {
  const owner = await account('commerce-owner'), a = await account('buyer-a'), b = await account('buyer-b');
  chatUsers = [owner, a, b];
  await role(owner.user.id, 'branch_owner');
  const voucher = await request('/vouchers', 'POST', { branchId, code: `TEST${runId.toUpperCase()}`, amountOff: 10000,
    quota: 1, validFrom: new Date(Date.now() - 60000).toISOString(), validTo: new Date(Date.now() + 86400000).toISOString() }, owner.accessToken);
  assert.equal(voucher.status, 201);
  const body = { branchId, items: [{ serviceId, quantity: 1 }], voucherCode: voucher.body.data.code };
  const results = await Promise.all([a, b].map(u => request('/orders', 'POST', body, u.accessToken, key())));
  assert.deepEqual(results.map(x => x.status).sort(), [201, 409]);
  const buyer = results[0].status === 201 ? a : b, other = buyer === a ? b : a;
  const order = results.find(x => x.status === 201)!.body.data;
  assert.equal(order.amount, 20000);
  assert.equal((await request(`/orders/${order.id}`, 'GET', undefined, other.accessToken)).status, 404);
  const intent = await request('/payment-intents', 'POST', { orderId: order.id }, buyer.accessToken, key());
  assert.equal(intent.status, 201);
  const signed = { eventId: randomUUID(), intentId: intent.body.data.id, status: 'paid', amount: intent.body.data.amount, currency: 'VND' };
  assert.equal((await request('/webhooks/payments/sandbox', 'POST', signed)).status, 401);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payment = await request('/webhooks/payments/sandbox', 'POST', signed, undefined, {
    'X-Webhook-Timestamp': timestamp,
    'X-Webhook-Signature': signWebhook(Buffer.from(JSON.stringify(signed)), timestamp, process.env.SANDBOX_WEBHOOK_SECRET!)
  });
  assert.equal(payment.body.data.outcome, 'SUCCEEDED');
  assert.equal((await request(`/orders/${order.id}`, 'GET', undefined, buyer.accessToken)).body.data.status, 'CONFIRMED');
  // A paid order is refundable in full inside the refund window.
  const paidCancel = await request(`/orders/${order.id}/cancel`, 'POST', {}, buyer.accessToken, key());
  assert.deepEqual([paidCancel.status, paidCancel.body.data.status, paidCancel.body.data.refund?.percent], [201, 'CANCELLED', 100]);
});

test('chat invitation gates history and writes; send is idempotent and ordered', async () => {
  const [a, b, c] = chatUsers;
  const conv = await request('/conversation', 'POST', { title: 'Court group', memberIds: [b.user.id] }, a.accessToken);
  assert.equal(conv.status, 201);
  const id = conv.body.data.id;
  assert.equal((await request(`/conversation/${id}/messages`, 'GET', undefined, b.accessToken)).status, 404);
  assert.equal((await request(`/conversation/${id}/messages`, 'GET', undefined, c.accessToken)).status, 404);
  assert.equal((await request(`/conversation/${id}/message`, 'POST', { body: 'Nope' }, b.accessToken, key())).status, 404);
  assert.equal((await request(`/conversation/${id}/accept`, 'POST', {}, b.accessToken)).status, 201);
  const k = key();
  const first = await request(`/conversation/${id}/message`, 'POST', { body: 'Hello' }, a.accessToken, k);
  assert.equal(first.status, 201);
  const retry = await request(`/conversation/${id}/message`, 'POST', { body: 'Hello' }, a.accessToken, k);
  assert.equal(retry.body.data.id, first.body.data.id);
  const second = await request(`/conversation/${id}/message`, 'POST', { body: 'Hi' }, b.accessToken, key());
  assert.equal(second.status, 201);
  const messages = await request(`/conversation/${id}/messages?after=0`, 'GET', undefined, b.accessToken);
  assert.equal(messages.body.data.length, 2);
  assert.deepEqual(messages.body.data.map((m: any) => Number(m.seq)), [1, 2]);
  assert.equal((await request('/crypto/handshake', 'POST', {}, a.accessToken)).body.data.protocol, 'signal');
  assert.equal((await request('/media/presign', 'POST', { mimeType: 'image/png', size: 1024 }, a.accessToken)).status, 503);
});

test('booking add-ons are priced before payment, participants are scoped, and review requires completion', async () => {
  const [owner, invitee, stranger] = chatUsers;
  const start = new Date(); start.setUTCDate(start.getUTCDate() + 6); start.setUTCHours(2, 0, 0, 0);
  const end = new Date(start.getTime() + 3600000);
  const hold = await request('/booking-holds', 'POST', { yardId, startsAt: start.toISOString(), endsAt: end.toISOString() }, owner.accessToken, key());
  assert.equal(hold.status, 201);
  const booked = await request('/bookings', 'POST', { holdId: hold.body.data.holdId }, owner.accessToken, key());
  assert.equal(booked.status, 201);
  const bookingId = booked.body.data.id;
  assert.equal((await request(`/bookings/${bookingId}/participants`, 'POST', { userId: invitee.user.id }, stranger.accessToken)).status, 404);
  const added = await request(`/bookings/${bookingId}/services`, 'POST', { serviceId, quantity: 2 }, owner.accessToken, key());
  assert.equal(added.status, 201);
  assert.equal(added.body.data.amount, 240000);
  const participant = await request(`/bookings/${bookingId}/participants`, 'POST', { userId: invitee.user.id }, owner.accessToken);
  assert.equal(participant.status, 201);
  assert.equal((await request(`/bookings/${bookingId}/participants/accept`, 'POST', {}, invitee.accessToken)).status, 201);
  assert.equal((await request(`/bookings/${bookingId}/participants`, 'GET', undefined, owner.accessToken)).body.data[0].status, 'ACCEPTED');
  const intent = await request('/payment-intents', 'POST', { bookingId }, owner.accessToken, key());
  assert.equal(intent.status, 201);
  assert.equal(intent.body.data.amount, 240000);
  assert.equal((await request(`/bookings/${bookingId}/services`, 'POST', { serviceId, quantity: 1 }, owner.accessToken, key())).status, 409);
  assert.equal((await request(`/bookings/${bookingId}/reviews`, 'POST', { rating: 5, comment: 'Great' }, owner.accessToken)).status, 409);
  const webhook = { eventId: randomUUID(), intentId: intent.body.data.id, status: 'paid', amount: intent.body.data.amount, currency: 'VND' };
  const timestamp = String(Math.floor(Date.now() / 1000));
  assert.equal((await request('/webhooks/payments/sandbox', 'POST', webhook, undefined, {
    'X-Webhook-Timestamp': timestamp,
    'X-Webhook-Signature': signWebhook(Buffer.from(JSON.stringify(webhook)), timestamp, process.env.SANDBOX_WEBHOOK_SECRET!)
  })).body.data.outcome, 'SUCCEEDED');
  await pool.query("UPDATE booking.bookings SET starts_at=now()-interval '2 hours',ends_at=now()-interval '1 hour' WHERE id=$1", [bookingId]);
  const review = await request(`/bookings/${bookingId}/reviews`, 'POST', { rating: 5, comment: 'Great' }, owner.accessToken);
  assert.equal(review.status, 201);
  assert.equal((await request(`/bookings/${bookingId}/reviews`, 'POST', { rating: 1, comment: 'Different' }, owner.accessToken)).status, 409);
  assert.equal((await request(`/public/branches/${branchId}/reviews`)).body.data[0].rating, 5);
});

test('weekly series creates all weeks atomically and preserves idempotency', async () => {
  const [owner, other] = chatUsers;
  const start = new Date(); start.setUTCDate(start.getUTCDate() + 8); start.setUTCHours(3, 0, 0, 0);
  const payload = { yardId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600000).toISOString(), weeks: 2 };
  const k = key();
  const created = await request('/booking-series', 'POST', payload, owner.accessToken, k);
  assert.equal(created.status, 201);
  assert.equal(created.body.data.bookings.length, 2);
  const retry = await request('/booking-series', 'POST', payload, owner.accessToken, k);
  assert.equal(retry.body.data.seriesId, created.body.data.seriesId);
  const denied = await request('/booking-series', 'POST', payload, other.accessToken, key());
  assert.equal(denied.status, 409);
  const series = await request(`/booking-series/${created.body.data.seriesId}`, 'GET', undefined, owner.accessToken);
  assert.equal(series.body.data.bookings.length, 2);
  assert.equal((await request(`/booking-series/${created.body.data.seriesId}`, 'GET', undefined, other.accessToken)).status, 404);
});

test('court photo R2 signing is owner-only and signed reads follow branch/yard scope', async () => {
  const [owner, other] = chatUsers;
  const dto = { mimeType: 'image/png', size: 1024, yardId };
  assert.equal((await request(`/branches/${branchId}/images/presign`, 'POST', dto, other.accessToken)).status, 403);
  assert.equal((await request(`/branches/${branchId}/images/presign`, 'POST', dto, owner.accessToken)).status, 503);
  process.env.R2_ACCOUNT_ID = 'a'.repeat(32);
  process.env.R2_BUCKET = 'anta-court-images';
  process.env.R2_ACCESS_KEY_ID = 'test-access-key-id';
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret-access-key-not-real';
  try {
    const signed = await request(`/branches/${branchId}/images/presign`, 'POST', dto, owner.accessToken);
    assert.equal(signed.status, 201);
    assert.equal(signed.body.data.method, 'PUT');
    assert.equal(signed.body.data.headers['Content-Type'], 'image/png');
    assert.match(signed.body.data.url, /r2\.cloudflarestorage\.com/);
    assert.match(signed.body.data.url, /X-Amz-Signature=/);
    assert.match(new URL(signed.body.data.url).searchParams.get('X-Amz-SignedHeaders') || '', /content-type/);
    const id = signed.body.data.uploadId;
    const record = (await pool.query('SELECT purpose,branch_id,yard_id,status FROM media.uploads WHERE id=$1', [id])).rows[0];
    assert.equal(record.purpose, 'COURT');
    assert.equal(record.branch_id, branchId);
    assert.equal(record.yard_id, yardId);
    assert.equal(record.status, 'PENDING');
    // A separate storage test must validate actual PUT/HEAD/GET. Here we test catalog binding/signing only.
    await pool.query(`UPDATE media.uploads SET status='CLEAN',object_key=$2,mime_type='image/webp',width=2,height=2
      WHERE id=$1`, [id, `courts/${branchId}/${id}.webp`]);
    const detail = await request(`/public/branches/${branchId}`);
    assert.equal(detail.status, 200);
    const yard = detail.body.data.yards.find((item: any) => item.id === yardId);
    assert.equal(yard.images.length, 1);
    assert.match(yard.images[0], /X-Amz-Signature=/);
    assert.equal(detail.body.data.images.length, 0);
    assert.equal((await request(`/branches/${branchId}/images/${id}`, 'DELETE', undefined, other.accessToken)).status, 403);
    assert.equal((await request(`/branches/${branchId}/images/${id}`, 'DELETE', undefined, owner.accessToken)).status, 200);
    const hidden = await request(`/public/branches/${branchId}`);
    assert.equal(hidden.body.data.yards.find((item: any) => item.id === yardId).images.length, 0);
  } finally {
    for (const key of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) delete process.env[key];
  }
});

test('admin grants are audited and account deletion revokes all sessions', async () => {
  const [admin, member, other] = chatUsers;
  assert.equal((await request('/admin/audit-events', 'GET', undefined, member.accessToken)).status, 403);
  await pool.query("INSERT INTO identity.roles(user_id,role) VALUES($1,'admin')", [admin.user.id]);
  assert.equal((await request('/admin/roles', 'POST', { userId: member.user.id, role: 'branch_staff', branchId }, member.accessToken)).status, 403);
  const granted = await request('/admin/roles', 'POST', { userId: member.user.id, role: 'branch_staff', branchId }, admin.accessToken);
  assert.equal(granted.status, 201);
  const audit = await request('/admin/audit-events', 'GET', undefined, admin.accessToken);
  assert.equal(audit.status, 200);
  assert.ok(audit.body.data.some((event: any) => event.action === 'role.grant' && event.target_id === member.user.id));
  const revoked = await request('/admin/roles', 'DELETE', { userId: member.user.id, role: 'branch_staff', branchId }, admin.accessToken);
  assert.equal(revoked.status, 200);
  assert.equal((await request('/users/me/linked-accounts', 'POST', { idToken: 'x'.repeat(100), password: 'test-password-long-123' }, member.accessToken)).status, 503);
  assert.equal((await request('/users/me', 'DELETE', { password: 'wrong' }, other.accessToken)).status, 401);
  const deleted = await request('/users/me', 'DELETE', { password: 'test-password-long-123' }, other.accessToken);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.data.status, 'DELETION_REQUESTED');
  assert.equal((await request('/users/me', 'GET', undefined, other.accessToken)).status, 401);
  assert.equal((await request('/public/auth/refresh', 'POST', { refreshToken: other.refreshToken })).status, 401);
  const adminCount = (await pool.query(`SELECT count(*)::int AS n FROM identity.roles r
    JOIN identity.users u ON u.id=r.user_id WHERE r.role='admin' AND u.status='ACTIVE'`)).rows[0].n;
  const selfRevoke = await request('/admin/roles', 'DELETE', { userId: admin.user.id, role: 'admin' }, admin.accessToken);
  assert.equal(selfRevoke.status, adminCount === 1 ? 409 : 200);
});
