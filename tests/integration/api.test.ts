import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { createApplication } from '../../apps/api/bootstrap';
import { Database } from '../../packages/database';
import { RedisService } from '../../packages/redis';
import { BookingService } from '../../modules/booking/service';
import { PaymentService } from '../../modules/payment/service';
import { signWebhook } from '../../modules/payment/signature';
import { signAccess } from '../../packages/auth/tokens';
import { loadConfig } from '../../packages/config';
import { migrate } from '../../scripts/migrate';
import { demoIds as seedIds, seed } from '../../scripts/seed';
import { importVenues, Venue } from '../../scripts/import-venues';
import { dispatchOutbox } from '../../apps/worker/outbox';
import { deliverNotification } from '../../apps/worker/notifications';
import { buildOpenApi } from '../../packages/contracts/openapi';
import SwaggerParser from '@apidevtools/swagger-parser';
import { createRealtime } from '../../apps/realtime/main';
import { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { io } from 'socket.io-client';

// Never run integration fixtures in the application's database.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://anta:anta_local@127.0.0.1:55432/anta_test';
assert.match(new URL(process.env.DATABASE_URL).pathname, /_test$/);
process.env.NODE_ENV = 'test';
process.env.DEV_OTP_ENABLED = 'true';
process.env.DEV_ADMIN_KEY = 'integration-tests-only-development-key-32';
process.env.FCM_ENABLED = 'false';
// Google sign-in is off unless a test turns it on, whatever the developer's .env holds.
for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_JWKS_URL']) delete process.env[key];
let app: INestApplication, base: string, db: Database;
const runId = randomUUID().slice(0, 8);
const demoIds = { ...seedIds, branch: randomUUID(), yard: randomUUID() };
process.env.REDIS_KEY_PREFIX = `anta-tests-${runId}:`;
let anotherUser: any;
let ownerAccount: any;
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
/** Creates a fixture user with a live session directly in the database (a signed, session-bound access token,
 * identical in shape to one issued through login), bypassing the public OTP/register flow so test fixtures don't
 * compete with real registration traffic for the per-IP OTP-send rate limit. */
async function directAccount(pool: Pool, suffix: string) {
  const userId = randomUUID(), sessionId = randomUUID();
  await pool.query(`INSERT INTO identity.users(id,identifier,display_name,password_hash) VALUES($1,$2,$3,'unused-fixture-hash')`,
    [userId, `${runId}-${suffix}@example.com`, `Fixture ${suffix}`]);
  await pool.query(`INSERT INTO identity.refresh_sessions(id,user_id,family_id,refresh_hash,device_id,expires_at)
    VALUES($1,$2,$3,$4,'test-device',now()+interval '1 day')`, [sessionId, userId, randomUUID(), randomUUID()]);
  const accessToken = await signAccess(userId, sessionId, loadConfig().jwtSecret);
  return { user: { id: userId }, accessToken, identifier: `${runId}-${suffix}@example.com` };
}
/** The venue owner confirms a booking that is awaiting review after payment. */
async function confirmAsOwner(bookingId: string) {
  const result = await request(`/owner/bookings/${bookingId}/confirm`, 'POST', undefined, ownerAccount.accessToken);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.data;
}
before(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await migrate(pool); await seed(pool);
  await pool.query(`INSERT INTO catalog.branches(id,shop_id,name,address,description,location,timezone,opening_hour,closing_hour)
    SELECT $1,shop_id,name,address,description,location,timezone,opening_hour,closing_hour FROM catalog.branches WHERE id=$2`, [demoIds.branch, seedIds.branch]);
  await pool.query(`INSERT INTO catalog.yards(id,branch_id,sport_id,name,hourly_price,currency)
    SELECT $1,$2,sport_id,name,hourly_price,currency FROM catalog.yards WHERE id=$3`, [demoIds.yard, demoIds.branch, seedIds.yard]);
  app = await createApplication(); await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/api/v1`; db = app.get(Database);
  ownerAccount = await directAccount(pool, 'owner');
  await pool.query("INSERT INTO identity.roles(user_id,role,branch_id) VALUES($1,'branch_owner',$2)", [ownerAccount.user.id, demoIds.branch]);
  await pool.end();
});
after(async () => { await app?.close(); });

test('health, OpenAPI contract, envelope, validation and PostGIS search', async () => {
  assert.equal((await request('/health/ready')).status, 200);
  const sports = await request('/public/sports'); assert.equal(sports.status, 200);
  assert.equal(sports.body.meta.requestId, sports.requestId);
  assert.equal((await request('/users/me')).status, 401);
  const nearby = await request('/public/branches?lat=10.762622&lng=106.660172&radius=1000&pageSize=100');
  assert.equal(nearby.status, 200); assert.ok(nearby.body.data.items.some((b: any) => b.id === demoIds.branch));
  // List cards show opening hours, and the nearest venues can be asked for nationwide.
  const listed = nearby.body.data.items.find((b: any) => b.id === demoIds.branch);
  assert.ok(Number.isInteger(listed.opening_hour) && listed.closing_hour > listed.opening_hour);
  // A card also shows the sports on offer, the cheapest hourly price and the advertised rating (none for the demo venue).
  assert.deepEqual([listed.sports, listed.min_price, listed.rating, listed.review_count], [[{ slug: 'badminton', name: 'Cầu lông' }], 180000, null, 0]);
  assert.ok(sports.body.data.find((sport: any) => sport.slug === 'badminton').venue_count >= 2);
  assert.equal((await request('/public/branches?sort=newest')).status, 400);
  // Someone on the other side of the world still gets the nearest venues, however far those are.
  const abroad = await request('/public/branches?lat=37.42&lng=-122.08&radius=20100000&pageSize=1');
  assert.ok(abroad.body.data.items.length === 1 && abroad.body.data.items[0].distance_meters > 10000000);
  assert.equal((await request('/public/branches?lat=37.42&lng=-122.08&radius=3000000')).body.data.total, 0);
  assert.equal((await request('/public/branches?lat=21&lng=105&radius=20100001')).status, 400);
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
test('imported venues are found under every sport they advertise and re-import updates the same rows', async () => {
  const slug = 'sport_integration_fixture', name = `Import fixture ${runId}`;
  // Da Nang, away from the coordinates the PostGIS search test counts on.
  const venue: Venue = { slug, name, address: '1 Bạch Đằng, Đà Nẵng', hours: '05:30 - 22:00', sports: ['Đa năng', 'Bóng rổ'], location: { lat: 16.0712, lng: 108.2241 },
    rating: 4.96, reviewCount: 31, bookingUrl: 'https://example.test/san/sport_integration_fixture',
    priceTables: [{ group: 'Nguyên sân', name: 'Thuê 60 phút', rows: [{ days: 'T2 - CN', time: '6h - 22h', fixed: 300000, walkIn: 330000 }] },
      { group: 'Nguyên sân', name: 'Thuê 30 phút', rows: [{ days: 'T2 - CN', time: '6h - 22h', fixed: 200000, walkIn: 200000 }] }],
    services: [{ name: 'Nước suối', price: 10000, unit: 'chai' }, { name: 'Nước suối', price: 200000, unit: 'thùng' }] };
  const data = { venues: { [slug]: venue }, bySport: { 'Đa năng': { slugs: [slug] } } };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const stored = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM catalog.yards y WHERE y.branch_id=b.id AND y.active) AS yards,
    (SELECT count(*)::int FROM catalog.yards y WHERE y.branch_id=b.id) AS all_yards, (SELECT count(*)::int FROM catalog.services s WHERE s.branch_id=b.id) AS services,
    (SELECT count(*)::int FROM catalog.branch_sports s WHERE s.branch_id=b.id) AS sports FROM catalog.branches b WHERE b.name=$1`, [name])).rows;
  try {
    // A venue that lost a yard type, a service and a sport: the yard is hidden (bookings may reference it), the rest is removed.
    const before = { ...venue, sports: [...venue.sports, 'Golf'], services: [...venue.services!, { name: 'Thuê bóng', price: 5000, unit: null }],
      priceTables: [...venue.priceTables!, { group: 'Nửa sân', name: 'Thuê 60 phút', rows: [{ days: null, time: '6h - 22h', fixed: null, walkIn: 150000 }] }] };
    assert.deepEqual(await importVenues(pool, { ...data, venues: { [slug]: before } }), { branches: 1, yards: 2, services: 3, withoutYard: [], skipped: [] });
    assert.deepEqual(await stored(), [{ yards: 2, all_yards: 2, services: 3, sports: 3 }]);
    const first = await importVenues(pool, data);
    assert.deepEqual(first, { branches: 1, yards: 1, services: 2, withoutYard: [], skipped: [] });
    assert.deepEqual(await importVenues(pool, data), first);
    assert.deepEqual(await stored(), [{ yards: 1, all_yards: 2, services: 2, sports: 2 }]);
    // An incomplete record is reported and leaves what is already stored untouched.
    assert.deepEqual(await importVenues(pool, { venues: { [slug]: { ...venue, location: null } }, bySport: {} }),
      { branches: 0, yards: 0, services: 0, withoutYard: [], skipped: [slug] });
    assert.deepEqual(await stored(), [{ yards: 1, all_yards: 2, services: 2, sports: 2 }]);
  } finally { await pool.end(); }
  const sports = (await request('/public/sports')).body.data as { id: string; slug: string }[];
  const found = (sportSlug: string) => request(`/public/branches?sportId=${sports.find(sport => sport.slug === sportSlug)!.id}&q=${encodeURIComponent(name)}`);
  // "Đa năng" is only advertised: the venue has no yard for it, yet it is listed under it.
  for (const sportSlug of ['multi-sport', 'basketball']) assert.equal((await found(sportSlug)).body.data.total, 1, sportSlug);
  assert.equal((await found('golf')).body.data.total, 0);
  const detail = await request(`/public/branches/${(await found('multi-sport')).body.data.items[0].id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.opening_hour, 6);
  assert.deepEqual(detail.body.data.yards.map((yard: any) => [yard.name, yard.hourly_price]), [['Nguyên sân', 330000]]);
  assert.match(detail.body.data.description, /Nguyên sân - Thuê 30 phút/);
  assert.doesNotMatch(detail.body.data.description, /example\.test/);
  assert.deepEqual([detail.body.data.rating, detail.body.data.review_count, detail.body.data.min_price], [5, 31, 330000]);
  assert.deepEqual(detail.body.data.sports.map((sport: any) => sport.slug), ['basketball', 'multi-sport']);
  // Typed without accents, a venue is found by its address or by a sport it offers.
  const typed = async (text: string) => (await request(`/public/branches?q=${encodeURIComponent(text)}&pageSize=100`)).body.data.items.map((b: any) => b.name);
  assert.ok((await typed('bach dang, da nang')).includes(name));
  assert.ok((await typed('BONG RO')).includes(name));
  assert.ok(!(await typed('cau long')).includes(name));
  // LIKE's wildcards are ordinary characters when typed: "%" does not match every venue.
  assert.ok(!(await typed('%')).includes(name));
  assert.ok(!(await typed('B_ch Dang')).includes(name));
  // Under a sport filter the price shown is that sport's, not the cheapest hour of any sport.
  const fixtureId = detail.body.data.id, golfId = sports.find(sport => sport.slug === 'golf')!.id, cheapYard = randomUUID();
  const priceUnder = async (sportSlug?: string) => (await request(`/public/branches?q=${encodeURIComponent(name)}` +
    (sportSlug ? `&sportId=${sports.find(sport => sport.slug === sportSlug)!.id}` : ''))).body.data.items[0]?.min_price;
  await db.query("INSERT INTO catalog.yards(id,branch_id,sport_id,name,hourly_price) VALUES($1,$2,$3,'Putting green',50000)", [cheapYard, fixtureId, golfId]);
  try {
    assert.deepEqual([await priceUnder(), await priceUnder('basketball'), await priceUnder('golf'), await priceUnder('multi-sport')], [50000, 330000, 50000, 50000]);
  } finally { await db.query('DELETE FROM catalog.yards WHERE id=$1', [cheapYard]); }
  // Best rated first: rated venues lead in falling order and unrated ones follow. Cheapest first: prices only rise.
  const sorted = async (sort: string) => (await request(`/public/branches?sort=${sort}&pageSize=100`)).body.data.items as any[];
  const byRating = await sorted('rating'), unrated = byRating.findIndex(b => b.rating === null), rated = byRating.slice(0, unrated < 0 ? undefined : unrated);
  assert.ok(rated.some(b => b.id === detail.body.data.id));
  assert.ok(byRating.slice(rated.length).every(b => b.rating === null));
  assert.deepEqual(rated.map(b => b.rating), rated.map(b => b.rating).sort((a, b) => b - a));
  const prices = (await sorted('price')).map(b => b.min_price).filter(price => price !== null);
  assert.ok(prices.length > 1);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
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
  assert.equal((await request('/public/auth/social', 'POST', { idToken: 'x'.repeat(100), deviceId: 'test-device' })).status, 503);
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
  // A booking lists with the venue and yard it is for.
  const listed = (await request('/users/me/bookings', 'GET', undefined, a.accessToken)).body.data;
  assert.deepEqual([listed.total, listed.items[0].id, listed.items[0].branch_name, listed.items[0].yard_name, listed.items[0].branch_timezone, listed.items[0].total],
    [1, id, 'Sân cầu lông Demo', 'Sân 1', 'Asia/Ho_Chi_Minh', undefined]);
  // The development payment needs a session, the development key, the intent's owner and the sandbox provider.
  const devPay = `/dev/payment-intents/${payments[0].body.data.id}/pay`, devKey = { 'X-Dev-Key': process.env.DEV_ADMIN_KEY! };
  assert.equal((await request(devPay, 'POST', undefined, undefined, devKey)).status, 401);
  assert.equal((await request(devPay, 'POST', undefined, a.accessToken)).status, 403);
  assert.equal((await request(devPay, 'POST', undefined, a.accessToken, { 'X-Dev-Key': 'x'.repeat(40) })).status, 403);
  assert.equal((await request(devPay, 'POST', undefined, b.accessToken, devKey)).status, 404);
  const provider = process.env.PAYMENT_PROVIDER;
  try {
    Object.assign(process.env, { PAYMENT_PROVIDER: 'vnpay', VNPAY_TMN_CODE: 'TESTCODE', VNPAY_HASH_SECRET: 'integration-vnpay-hash-secret', PAYMENT_RETURN_URL: 'https://example.test/return' });
    assert.equal((await request(devPay, 'POST', undefined, a.accessToken, devKey)).status, 404);
  } finally {
    process.env.PAYMENT_PROVIDER = provider;
    for (const name of ['VNPAY_TMN_CODE', 'VNPAY_HASH_SECRET', 'PAYMENT_RETURN_URL']) delete process.env[name];
  }
  assert.equal((await request(`/bookings/${id}`, 'GET', undefined, a.accessToken)).body.data.status, 'PENDING_PAYMENT');
  const paid = await request(devPay, 'POST', undefined, a.accessToken, devKey);
  assert.deepEqual([paid.status, paid.body.data.outcome, paid.body.data.duplicate], [200, 'SUCCEEDED', false]);
  assert.equal((await request(devPay, 'POST', undefined, a.accessToken, devKey)).body.data.duplicate, true);
  const confirmed = (await request(`/bookings/${id}`, 'GET', undefined, a.accessToken)).body.data;
  // Payment success moves the booking to owner review, not straight to CONFIRMED.
  assert.deepEqual([confirmed.status, confirmed.branch_name, confirmed.yard_name], ['PENDING_OWNER_CONFIRMATION', 'Sân cầu lông Demo', 'Sân 1']);
  // An intent that is no longer waiting is refused instead of being filed as a late payment.
  await db.query("UPDATE payment.intents SET status='EXPIRED' WHERE id=$1", [payments[0].body.data.id]);
  const late = await request(devPay, 'POST', undefined, a.accessToken, devKey);
  assert.deepEqual([late.status, late.body.error.code], [409, 'TARGET_NOT_PAYABLE']);
  await db.query("UPDATE payment.intents SET status='SUCCEEDED' WHERE id=$1", [payments[0].body.data.id]);
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
  // Payment success moves the booking to owner review, not straight to CONFIRMED.
  assert.equal((await request(`/bookings/${created.booking.id}`, 'GET', undefined, user.accessToken)).body.data.status, 'PENDING_OWNER_CONFIRMATION');
  const q = new URLSearchParams({ from: created.target.startsAt, to: created.target.endsAt });
  const availability = await request(`/public/branches/${demoIds.branch}/availability?${q}`); assert.equal(availability.body.data[0].available, false);
  // A paid booking is cancellable under the refund policy; the refund is recorded against the settled intent.
  const paidCancel = await request(`/bookings/${created.booking.id}/cancel`, 'POST', undefined, user.accessToken, key());
  assert.deepEqual([paidCancel.status, paidCancel.body.data.status, paidCancel.body.data.refund?.status], [201, 'CANCELLED', 'SUCCEEDED']);
  assert.equal((await request(`/public/branches/${demoIds.branch}/availability?${q}`)).body.data[0].available, true);
});
test('owner portal: confirm and reject require branch ownership, and reject always refunds in full', async () => {
  const user = await account('owner-flow'), created = await booking(user.accessToken);
  assert.equal((await pay(created.intent)).body.data.outcome, 'SUCCEEDED');
  const bookingId = created.booking.id;
  // A customer (not an owner/staff of the branch) cannot confirm or reject.
  assert.equal((await request(`/owner/bookings/${bookingId}/confirm`, 'POST', undefined, user.accessToken)).status, 403);
  // Not yet staff of any branch.
  assert.equal((await request(`/owner/bookings/${bookingId}`, 'GET', undefined, anotherUser.accessToken)).status, 403);
  const confirmed = await confirmAsOwner(bookingId);
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal((await request(`/bookings/${bookingId}`, 'GET', undefined, user.accessToken)).body.data.status, 'CONFIRMED');
  // Already confirmed: a second confirm is refused, not silently repeated.
  const again = await request(`/owner/bookings/${bookingId}/confirm`, 'POST', undefined, ownerAccount.accessToken);
  assert.deepEqual([again.status, again.body.error.code], [409, 'BOOKING_NOT_CONFIRMABLE']);

  // A second booking, rejected instead: always a full refund, regardless of how close the slot is.
  const second = await booking(user.accessToken);
  assert.equal((await pay(second.intent)).body.data.outcome, 'SUCCEEDED');
  const emptyReason = await request(`/owner/bookings/${second.booking.id}/reject`, 'POST', { reason: '  ' }, ownerAccount.accessToken);
  assert.equal(emptyReason.status, 400);
  const rejected = await request(`/owner/bookings/${second.booking.id}/reject`, 'POST', { reason: 'Mưa to, sân ngập nước' }, ownerAccount.accessToken);
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.deepEqual([rejected.body.data.status, rejected.body.data.refund.percent, rejected.body.data.refund.status], ['CANCELLED', 100, 'SUCCEEDED']);
  assert.equal((await request(`/bookings/${second.booking.id}`, 'GET', undefined, user.accessToken)).body.data.status, 'CANCELLED');
  // A rejected/confirmed booking cannot be rejected again.
  assert.equal((await request(`/owner/bookings/${second.booking.id}/reject`, 'POST', { reason: 'again' }, ownerAccount.accessToken)).status, 409);
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
  const queueName = `anta-integration-${runId}`, queue = new Queue(queueName, { connection });
  const worker = new Worker(queueName, job => deliverNotification(db, job.data.eventId), { connection });
  try {
    // Earlier local runs can leave more pending events than one batch; drain them all.
    while (await dispatchOutbox(db, queue));
    for (let attempt = 0; attempt < 400; attempt++) {
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
test('Google sign-in opens a passwordless account, favourites list like any venue list, and deletion needs a fresh Google proof', async () => {
  // A stand-in for Google's key server: the backend fetches these keys exactly as it fetches Google's.
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const google = createServer((_req, res) => res.setHeader('Content-Type', 'application/json').end(JSON.stringify({ keys: [jwk] })));
  await new Promise<void>(resolve => google.listen(0, '127.0.0.1', resolve));
  const client = '1234567890-tests.apps.googleusercontent.com', email = `${runId}-google@example.com`;
  const now = () => Math.floor(Date.now() / 1000);
  const idToken = (claims: Record<string, unknown> = {}) => new SignJWT({ iss: 'https://accounts.google.com', aud: client, sub: `google-${runId}`,
    email, email_verified: true, name: 'Bình Google', iat: now(), exp: now() + 3600, ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
  const signIn = async (claims: Record<string, unknown> = {}) => request('/public/auth/social', 'POST', { idToken: await idToken(claims), deviceId: 'test-device' });
  // This test alone makes a quarter of the requests one address may make in a minute, at the end of a file that has
  // made the rest: it starts from a clean count rather than depend on how fast the tests before it ran.
  const redis = app.get(RedisService).client, prefix = process.env.REDIS_KEY_PREFIX!;
  for (const counter of await redis.keys(`${prefix}http:ip:*`)) await redis.del(counter.slice(prefix.length));
  process.env.GOOGLE_JWKS_URL = `http://127.0.0.1:${(google.address() as AddressInfo).port}/certs`;
  process.env.GOOGLE_CLIENT_ID = client;
  try {
    const config = (await request('/public/config')).body.data;
    assert.deepEqual([config.googleClientId, config.features.socialLogin], [client, true]);

    const first = await signIn();
    assert.equal(first.status, 201);
    assert.deepEqual([first.body.data.user.identifier, first.body.data.user.displayName, first.body.data.user.passwordLogin], [email, 'Bình Google', false]);
    const jwt = first.body.data.accessToken;
    assert.equal((await request('/users/me', 'GET', undefined, jwt)).body.data.passwordLogin, false);
    assert.equal((await request('/users/me', 'GET', undefined, anotherUser.accessToken)).body.data.passwordLogin, true);
    // The same Google account is the same account here, whatever Google now calls its owner.
    const again = await signIn({ name: 'Tên khác' });
    assert.deepEqual([again.body.data.user.id, again.body.data.user.displayName], [first.body.data.user.id, 'Bình Google']);
    // It has no password: the password door stays shut, and so does the Google door for anything Google did not sign for us.
    assert.equal((await request('/public/auth/login', 'POST', { identifier: email, password: 'any-password-1234', deviceId: 'x' })).status, 401);
    assert.equal((await signIn({ aud: 'someone-else.apps.googleusercontent.com' })).body.error.code, 'INVALID_SOCIAL_TOKEN');
    assert.equal((await signIn({ email_verified: false })).body.error.code, 'UNSUPPORTED_SOCIAL_IDENTITY');
    // An email that already has a password account is never taken over by a Google sign-in.
    const collision = await signIn({ sub: `google-other-${runId}`, email: anotherUser.identifier });
    assert.deepEqual([collision.status, collision.body.error.code], [409, 'ACCOUNT_LINK_REQUIRED']);

    // Adding a way into a password account takes the password again: a borrowed session cannot plant one.
    const linkedGoogle = { sub: `google-linked-${runId}`, email: `${runId}-linked@example.com` };
    const link = async (body: object) => request('/users/me/linked-accounts', 'POST', { idToken: await idToken(linkedGoogle), ...body }, anotherUser.accessToken);
    assert.equal((await link({})).status, 400);
    assert.equal((await link({ password: 'not-the-password-1' })).body.error.code, 'INVALID_CREDENTIALS');
    assert.deepEqual((await request('/users/me/linked-accounts', 'GET', undefined, anotherUser.accessToken)).body.data, []);
    const linked = await link({ password: 'test-password-long-123' });
    assert.equal(linked.status, 201);
    assert.equal((await signIn(linkedGoogle)).body.data.user.id, anotherUser.user.id);
    const unlink = async (body?: object) => request(`/users/me/linked-accounts/${linked.body.data.id}`, 'DELETE', body, anotherUser.accessToken);
    assert.equal((await unlink()).status, 400);
    assert.equal((await unlink({ password: 'not-the-password-1' })).body.error.code, 'INVALID_CREDENTIALS');
    assert.equal((await unlink({ password: 'test-password-long-123' })).status, 200);
    // Unlinked, that Google account is a stranger again and gets an account of its own.
    assert.notEqual((await signIn(linkedGoogle)).body.data.user.id, anotherUser.user.id);

    assert.equal((await request('/users/me/favorites')).status, 401);
    assert.deepEqual((await request('/users/me/favorites', 'GET', undefined, jwt)).body.data, []);
    assert.equal((await request(`/users/me/favorites/${demoIds.branch}`, 'POST', undefined, jwt)).status, 201);
    assert.equal((await request(`/users/me/favorites/${demoIds.branch}`, 'POST', undefined, jwt)).status, 201);
    assert.equal((await request(`/users/me/favorites/${randomUUID()}`, 'POST', undefined, jwt)).status, 404);
    const favorites = (await request('/users/me/favorites', 'GET', undefined, jwt)).body.data;
    const { name } = (await request(`/public/branches/${demoIds.branch}`)).body.data;
    const listed = (await request(`/public/branches?pageSize=100&q=${encodeURIComponent(name)}`)).body.data.items.find((item: any) => item.id === demoIds.branch);
    assert.ok(listed);
    // A favourite carries what a venue card shows: the same fields as the public list, minus the distance.
    const { distance_meters: _distance, ...card } = listed;
    assert.deepEqual(favorites, [card]);
    assert.deepEqual((await request('/users/me/favorites', 'GET', undefined, anotherUser.accessToken)).body.data, []);
    assert.equal((await request(`/users/me/favorites/${demoIds.branch}`, 'DELETE', undefined, jwt)).status, 200);
    assert.deepEqual((await request('/users/me/favorites', 'GET', undefined, jwt)).body.data, []);

    const remove = async (body: unknown) => request('/users/me', 'DELETE', body, jwt);
    assert.equal((await remove({ password: 'any-password-1234' })).body.error.code, 'INVALID_CREDENTIALS');
    // Proof of who signed in six minutes ago is not proof of who is asking now.
    assert.equal((await remove({ idToken: await idToken({ iat: now() - 360 }) })).body.error.code, 'REAUTH_REQUIRED');
    assert.equal((await remove({ idToken: await idToken({ sub: `google-other-${runId}`, email: `${runId}-other@example.com` }) })).body.error.code, 'INVALID_REAUTH');
    const removed = await remove({ idToken: await idToken() });
    assert.deepEqual([removed.status, removed.body.data.status], [200, 'DELETION_REQUESTED']);
    assert.equal((await request('/users/me', 'GET', undefined, jwt)).status, 401);
    assert.deepEqual([(await signIn()).status, (await signIn()).body.error.code], [403, 'ACCOUNT_UNAVAILABLE']);
  } finally {
    delete process.env.GOOGLE_JWKS_URL; delete process.env.GOOGLE_CLIENT_ID;
    await new Promise(resolve => google.close(resolve));
  }
  assert.equal((await request('/public/config')).body.data.googleClientId, null);
});
