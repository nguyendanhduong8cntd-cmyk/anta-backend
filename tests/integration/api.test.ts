import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { createApplication } from '../../apps/api/bootstrap';
import { Database } from '../../packages/database';
import { BookingService } from '../../modules/booking/service';
import { PaymentService } from '../../modules/payment/service';
import { signWebhook } from '../../modules/payment/signature';
import { migrate } from '../../scripts/migrate';
import { demoIds as seedIds, seed } from '../../scripts/seed';
import { dispatchOutbox } from '../../apps/worker/outbox';
import { deliverNotification } from '../../apps/worker/notifications';
import { buildOpenApi } from '../../packages/contracts/openapi';
import SwaggerParser from '@apidevtools/swagger-parser';
import { createRealtime } from '../../apps/realtime/main';
import { AddressInfo } from 'node:net';
import { io } from 'socket.io-client';

// Never run integration fixtures in the application's database.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://alobo:alobo_local@127.0.0.1:55432/alobo_test';
assert.match(new URL(process.env.DATABASE_URL).pathname, /_test$/);
process.env.NODE_ENV = 'test';
process.env.DEV_OTP_ENABLED = 'true';
process.env.DEV_ADMIN_KEY = 'integration-tests-only-development-key-32';
process.env.FCM_ENABLED = 'false';
let app: INestApplication, base: string, db: Database;
const runId = randomUUID().slice(0, 8);
const demoIds = { ...seedIds, branch: randomUUID(), yard: randomUUID() };
process.env.REDIS_KEY_PREFIX = `alobo-tests-${runId}:`;
let anotherUser: any;
let slotIndex = 0;
function slot() {
  const date = new Date(); date.setUTCDate(date.getUTCDate() + 2 + slotIndex++);
  date.setUTCHours(2, 0, 0, 0); // 09:00 Vietnam, each test a different day
  return { yardId: demoIds.yard, startsAt: date.toISOString(), endsAt: new Date(date.getTime() + 3600000).toISOString() };
}
async function request(path: string, method = 'GET', body?: unknown, jwt?: string, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json',
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any, requestId: response.headers.get('x-request-id') };
}
async function account(suffix: string) {
  const identifier = `${runId}-${suffix}@example.com`;
  const send = await request('/public/auth/otp/send', 'POST', { identifier, purpose: 'register' });
  assert.equal(send.status, 201);
  const challengeId = send.body.data.challengeId;
  assert.equal(send.body.data.code, undefined);
  const code = await request(`/dev/otp/${challengeId}`, 'GET', undefined, undefined, { 'X-Dev-Key': process.env.DEV_ADMIN_KEY! });
  assert.equal(code.status, 200);
  const verified = await request('/public/auth/otp/verify', 'POST', { challengeId, code: code.body.data.code });
  assert.equal(verified.status, 201);
  const registration = await request('/public/auth/register', 'POST', { identifier, password: 'test-password-long-123',
    displayName: 'Integration Test', deviceId: 'test-device', verificationToken: verified.body.data.verificationToken });
  assert.equal(registration.status, 201);
  return { ...registration.body.data, identifier };
}
const key = () => ({ 'Idempotency-Key': randomUUID() });
async function booking(jwt: string, target = slot()) {
  const hold = await request('/booking-holds', 'POST', target, jwt, key()); assert.equal(hold.status, 201);
  const result = await request('/bookings', 'POST', { holdId: hold.body.data.holdId }, jwt, key()); assert.equal(result.status, 201);
  const intent = await request('/payment-intents', 'POST', { bookingId: result.body.data.id }, jwt, key()); assert.equal(intent.status, 201);
  return { hold: hold.body.data, booking: result.body.data, intent: intent.body.data, target };
}
async function pay(intent: any, eventId = randomUUID(), overrides: Record<string, unknown> = {}) {
  const body = { eventId, intentId: intent.id, status: 'paid', amount: intent.amount, currency: intent.currency, ...overrides };
  const timestamp = String(Math.floor(Date.now() / 1000));
  return request('/webhooks/payments/sandbox', 'POST', body, undefined, { 'X-Webhook-Timestamp': timestamp,
    'X-Webhook-Signature': signWebhook(Buffer.from(JSON.stringify(body)), timestamp, process.env.SANDBOX_WEBHOOK_SECRET!) });
}
before(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await migrate(pool); await seed(pool);
  await pool.query(`INSERT INTO catalog.branches(id,shop_id,name,address,description,location,timezone,opening_hour,closing_hour)
    SELECT $1,shop_id,name,address,description,location,timezone,opening_hour,closing_hour FROM catalog.branches WHERE id=$2`, [demoIds.branch, seedIds.branch]);
  await pool.query(`INSERT INTO catalog.yards(id,branch_id,sport_id,name,hourly_price,currency)
    SELECT $1,$2,sport_id,name,hourly_price,currency FROM catalog.yards WHERE id=$3`, [demoIds.yard, demoIds.branch, seedIds.yard]);
  await pool.end();
  app = await createApplication(); await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/api/v1`; db = app.get(Database);
});
after(async () => { await app?.close(); });

test('health, OpenAPI contract, envelope, validation and PostGIS search', async () => {
  assert.equal((await request('/health/ready')).status, 200);
  const sports = await request('/public/sports'); assert.equal(sports.status, 200);
  assert.equal(sports.body.meta.requestId, sports.requestId);
  assert.equal((await request('/users/me')).status, 401);
  const nearby = await request('/public/branches?lat=10.762622&lng=106.660172&radius=1000');
  assert.equal(nearby.status, 200); assert.ok(nearby.body.data.items.some((b: any) => b.id === demoIds.branch));
  const far = await request('/public/branches?lat=21&lng=105&radius=1000'); assert.equal(far.body.data.items.length, 0);
  assert.equal((await request('/public/branches?lat=10')).status, 400);
  assert.equal((await request('/public/branches?radius=-1')).status, 400);
  assert.equal((await request('/public/branches?unexpected=1')).status, 400);
  assert.equal((await request('/public/branches/not-a-uuid')).status, 400);
  const doc = buildOpenApi(app);
  assert.ok(doc.paths['/api/v1/bookings'].post?.requestBody);
  assert.ok(doc.components?.schemas?.Booking);
  assert.ok(doc.paths['/api/v1/bookings'].post?.responses['201']);
  await SwaggerParser.validate(doc as any);
});
test('OTP failure attempts persist, consume once and development endpoint is protected', async () => {
  const sent = await request('/public/auth/otp/send', 'POST', { identifier: `${runId}-otp@example.com`, purpose: 'register' });
  const challengeId = sent.body.data.challengeId;
  assert.equal((await request(`/dev/otp/${challengeId}`)).status, 403);
  const valid = (await request(`/dev/otp/${challengeId}`, 'GET', undefined, undefined, { 'X-Dev-Key': process.env.DEV_ADMIN_KEY! })).body.data.code;
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await request('/public/auth/otp/verify', 'POST', { challengeId, code: '000000' })).status, 400);
  assert.equal((await db.query('SELECT attempts FROM identity.otp_challenges WHERE id=$1', [challengeId])).rows[0].attempts, 5);
  assert.equal((await request('/public/auth/otp/verify', 'POST', { challengeId, code: valid })).status, 400);
});
test('registration/login/profile/logout/refresh rotation and reuse revoke the family', async () => {
  const user = await account('auth');
  assert.equal((await request('/users/me', 'GET', undefined, user.accessToken)).body.data.identifier, user.identifier);
  const patch = await request('/users/me', 'PATCH', { displayName: 'Updated' }, user.accessToken); assert.equal(patch.body.data.displayName, 'Updated');
  const bad = await request('/public/auth/login', 'POST', { identifier: user.identifier, password: 'wrong', deviceId: 'x' }); assert.equal(bad.status, 401);
  const rotated = await request('/public/auth/refresh', 'POST', { refreshToken: user.refreshToken }); assert.equal(rotated.status, 201);
  assert.equal((await request('/users/me', 'GET', undefined, user.accessToken)).status, 401);
  assert.equal((await request('/public/auth/refresh', 'POST', { refreshToken: user.refreshToken })).status, 401);
  assert.equal((await request('/users/me', 'GET', undefined, rotated.body.data.accessToken)).status, 401);
  const login = await request('/public/auth/login', 'POST', { identifier: user.identifier, password: 'test-password-long-123', deviceId: 'x' }); assert.equal(login.status, 201);
  assert.equal((await request('/auth/logout', 'POST', undefined, login.body.data.accessToken)).status, 201);
  assert.equal((await request('/users/me', 'GET', undefined, login.body.data.accessToken)).status, 401);
  assert.equal((await request('/public/auth/social', 'POST', { firebaseIdToken: 'x'.repeat(100), deviceId: 'test-device' })).status, 503);
});
test('parallel clients cannot hold the same slot; adjacent slots are allowed', async () => {
  const a = await account('race-a'), b = await account('race-b'), target = slot();
  anotherUser = b;
  const responses = await Promise.all([request('/booking-holds', 'POST', target, a.accessToken, key()), request('/booking-holds', 'POST', target, b.accessToken, key())]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  assert.equal(responses.find(r => r.status === 409)?.body.error.code, 'SLOT_UNAVAILABLE');
  const adjacent = { ...target, startsAt: target.endsAt, endsAt: new Date(Date.parse(target.endsAt) + 3600000).toISOString() };
  assert.equal((await request('/booking-holds', 'POST', adjacent, a.accessToken, key())).status, 201);
});
test('booking and payment retry return the same records; ownership and payload hash enforced', async () => {
  const a = await account('idem-a'), b = await account('idem-b'), target = slot(), holdKey = key();
  const holds = await Promise.all([request('/booking-holds', 'POST', target, a.accessToken, holdKey), request('/booking-holds', 'POST', target, a.accessToken, holdKey)]);
  assert.equal(holds[0].status, 201); assert.equal(holds[0].body.data.holdId, holds[1].body.data.holdId);
  const conflict = await request('/booking-holds', 'POST', { ...target, endsAt: new Date(Date.parse(target.endsAt) + 3600000).toISOString() }, a.accessToken, holdKey);
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  const bookingKey = key(), payload = { holdId: holds[0].body.data.holdId };
  const bookings = await Promise.all([request('/bookings', 'POST', payload, a.accessToken, bookingKey), request('/bookings', 'POST', payload, a.accessToken, bookingKey)]);
  assert.equal(bookings[0].status, 201); assert.equal(bookings[0].body.data.id, bookings[1].body.data.id);
  const id = bookings[0].body.data.id;
  assert.equal((await request(`/bookings/${id}`, 'GET', undefined, b.accessToken)).status, 404);
  const paymentKey = key();
  const payments = await Promise.all([request('/payment-intents', 'POST', { bookingId: id }, a.accessToken, paymentKey), request('/payment-intents', 'POST', { bookingId: id }, a.accessToken, paymentKey)]);
  assert.equal(payments[0].status, 201); assert.equal(payments[0].body.data.id, payments[1].body.data.id);
  assert.equal((await request(`/payment-intents/${payments[0].body.data.id}`, 'GET', undefined, b.accessToken)).status, 404);
  assert.equal((await request('/booking-holds', 'POST', slot(), a.accessToken)).status, 400);
});
test('only signed webhook confirms; replay dedupe and amount checks preserve state', async () => {
  const user = await account('payment'), created = await booking(user.accessToken);
  assert.equal((await request('/webhooks/payments/sandbox', 'POST', { eventId: randomUUID(), intentId: created.intent.id, status: 'paid', amount: created.intent.amount, currency: 'VND' })).status, 401);
  const mismatch = await pay(created.intent, randomUUID(), { amount: 1 }); assert.equal(mismatch.status, 409);
  assert.equal((await request(`/bookings/${created.booking.id}`, 'GET', undefined, user.accessToken)).body.data.status, 'PENDING_PAYMENT');
  const eventId = randomUUID(); const paid = await pay(created.intent, eventId); assert.equal(paid.body.data.outcome, 'SUCCEEDED');
  const duplicate = await pay(created.intent, eventId); assert.equal(duplicate.body.data.duplicate, true);
  assert.equal((await pay(created.intent, randomUUID())).body.data.outcome, 'SUCCEEDED');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM payment.transactions WHERE intent_id=$1', [created.intent.id])).rows[0].n, 1);
  assert.equal((await request(`/bookings/${created.booking.id}`, 'GET', undefined, user.accessToken)).body.data.status, 'CONFIRMED');
  assert.equal((await request(`/bookings/${created.booking.id}/cancel`, 'POST', undefined, user.accessToken, key())).status, 409);
  const q = new URLSearchParams({ from: created.target.startsAt, to: created.target.endsAt });
  const availability = await request(`/public/branches/${demoIds.branch}/availability?${q}`); assert.equal(availability.body.data[0].available, false);
});
test('cancel is idempotent and releases the slot without letting late payment resurrect it', async () => {
  const user = await account('cancel'), created = await booking(user.accessToken);
  const cancelKey = key();
  const first = await request(`/bookings/${created.booking.id}/cancel`, 'POST', undefined, user.accessToken, cancelKey);
  const second = await request(`/bookings/${created.booking.id}/cancel`, 'POST', undefined, user.accessToken, cancelKey);
  assert.equal(first.body.data.status, 'CANCELLED'); assert.equal(second.body.data.id, first.body.data.id);
  assert.equal((await pay(created.intent)).body.data.outcome, 'NEEDS_REVIEW');
  assert.equal((await request(`/bookings/${created.booking.id}`, 'GET', undefined, user.accessToken)).body.data.status, 'CANCELLED');
  assert.equal((await request('/booking-holds', 'POST', created.target, user.accessToken, key())).status, 201);
});
test('worker expires holds/bookings and late payment cannot take a replacement reservation', async () => {
  const user = await account('expiry'), created = await booking(user.accessToken);
  await db.transaction(async tx => {
    await tx.query("UPDATE booking.bookings SET payment_expires_at=now()-interval '1 second' WHERE id=$1", [created.booking.id]);
    await tx.query("UPDATE booking.reservations SET expires_at=now()-interval '1 second' WHERE booking_id=$1", [created.booking.id]);
    await tx.query("UPDATE payment.intents SET expires_at=now()-interval '1 second' WHERE id=$1", [created.intent.id]);
  });
  await app.get(BookingService).expireDue(); await app.get(PaymentService).expireDue();
  assert.equal((await request(`/bookings/${created.booking.id}`, 'GET', undefined, user.accessToken)).body.data.status, 'EXPIRED');
  const replacement = await request('/booking-holds', 'POST', created.target, user.accessToken, key()); assert.equal(replacement.status, 201);
  assert.equal((await pay(created.intent)).body.data.outcome, 'NEEDS_REVIEW');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM booking.reservations WHERE yard_id=$1 AND active AND starts_at=$2', [demoIds.yard, created.target.startsAt])).rows[0].n, 1);
});
test('outbox -> BullMQ -> durable notification is deduplicated and user-scoped', async () => {
  const user = await account('notifications'), created = await booking(user.accessToken); await pay(created.intent);
  const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const queueName = `alobo-integration-${runId}`, queue = new Queue(queueName, { connection });
  const worker = new Worker(queueName, job => deliverNotification(db, job.data.eventId), { connection });
  try {
    await dispatchOutbox(db, queue);
    for (let attempt = 0; attempt < 100; attempt++) {
      const counts = await queue.getJobCounts('wait', 'active', 'failed');
      assert.equal(counts.failed, 0);
      if (!counts.wait && !counts.active) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const list = await request('/notifications', 'GET', undefined, user.accessToken); assert.equal(list.status, 200); assert.ok(list.body.data.items.length >= 3);
    const item = list.body.data.items[0]; await deliverNotification(db, item.event_id); await deliverNotification(db, item.event_id);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM notification.notifications WHERE event_id=$1', [item.event_id])).rows[0].n, 1);
    assert.equal((await request(`/notifications/${item.id}/read`, 'POST', undefined, user.accessToken)).status, 201);
    assert.equal((await request(`/notifications/${item.id}/read`, 'POST', undefined, anotherUser.accessToken)).status, 404);
  } finally { await worker.close(); await queue.close(); await connection.quit(); }
});
test('database exclusion constraint protects reservations even without application locks', async () => {
  const user = anotherUser, target = slot();
  assert.equal((await request('/booking-holds', 'POST', target, user.accessToken, key())).status, 201);
  await assert.rejects(db.transaction(async tx => {
    const hold = (await tx.query(`INSERT INTO booking.holds(user_id,yard_id,starts_at,ends_at,amount,currency,expires_at)
      VALUES($1,$2,$3,$4,180000,'VND',now()+interval '5 minutes') RETURNING id`, [user.user.id, demoIds.yard, target.startsAt, target.endsAt])).rows[0];
    await tx.query('INSERT INTO booking.reservations(yard_id,hold_id,starts_at,ends_at,expires_at) VALUES($1,$2,$3,$4,now()+interval \'5 minutes\')',
      [demoIds.yard, hold.id, target.startsAt, target.endsAt]);
  }), (error: any) => error.code === '23P01');
});
test('SSE replay and Socket.IO resume use durable user-scoped cursors', async () => {
  const realtime = await createRealtime(0);
  const address = realtime.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const user = anotherUser, created = await booking(user.accessToken);
  const userId = user.user.id;
  const firstEvent = (await db.query('SELECT id FROM platform.outbox_events WHERE user_id=$1 AND payload->>\'bookingId\'=$2 ORDER BY id LIMIT 1', [userId, created.booking.id])).rows[0].id;
  await pay(created.intent);
  const afterFirst = (await db.query('SELECT * FROM platform.outbox_events WHERE user_id=$1 AND id>$2 ORDER BY id', [userId, firstEvent])).rows;
  assert.ok(afterFirst.length >= 2);
  const controller = new AbortController();
  let socket: ReturnType<typeof io> | undefined;
  try {
    assert.equal((await fetch(url + '/api/v1/events')).status, 401);
    assert.equal((await fetch(url + '/api/v1/events?after=wrong', { headers: { Authorization: `Bearer ${user.accessToken}` } })).status, 400);
    const stream = await fetch(url + '/api/v1/events', { signal: controller.signal,
      headers: { Authorization: `Bearer ${user.accessToken}`, 'Last-Event-ID': firstEvent } });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader(), decoder = new TextDecoder();
    let output = '';
    while (!output.includes(': heartbeat')) { const chunk = await reader.read(); if (chunk.done) break; output += decoder.decode(chunk.value); }
    assert.ok(output.includes(`id: ${afterFirst[0].id}\n`));
    assert.ok(!output.includes(`id: ${firstEvent}\n`));
    const data = output.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    assert.ok(data.every(event => afterFirst.some(e => e.id === event.id)));
    controller.abort(); await reader.cancel().catch(() => undefined);
    socket = io(url, { auth: { token: user.accessToken, after: firstEvent }, transports: ['websocket'], reconnection: false });
    const event = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket event timeout')), 8000);
      socket!.once('domain.event', e => { clearTimeout(timer); resolve(e); });
      socket!.once('connect_error', error => { clearTimeout(timer); reject(error); });
    });
    assert.equal(event.id, afterFirst[0].id);
    const invalid = io(url, { auth: { token: 'invalid' }, transports: ['websocket'], reconnection: false });
    try { await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Invalid socket did not fail')), 3000);
      invalid.once('connect_error', () => { clearTimeout(timer); resolve(); });
    }); } finally { invalid.disconnect(); }
  } finally { controller.abort(); socket?.disconnect(); await realtime.stop(); }
});
