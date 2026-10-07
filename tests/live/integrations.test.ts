// Live checks against real third-party accounts. Each test is skipped unless its credentials are present in the
// environment, so `npm run test:live` is safe to run anywhere and never touches production data: objects are written
// under a throwaway `live-test/` prefix and removed, Firebase test users are deleted, and OTP mail/SMS goes only to
// the recipient named in LIVE_TEST_EMAIL / LIVE_TEST_PHONE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import sharp from 'sharp';
import { verifiedGoogleIdentity } from '../../modules/identity/firebase';
import { deliverOtp, smtpTransport, twilioTransport } from '../../modules/identity/delivery';
import { sanitizeCourtImage } from '../../modules/media/processing';

const env = process.env;
const has = (...keys: string[]) => keys.every(key => Boolean(env[key]));
const missing = (...keys: string[]) => has(...keys) ? false : `set ${keys.filter(key => !env[key]).join(', ')} to run`;

test('R2: presigned PUT, HEAD, GET, WebP re-encode and delete on the real bucket', { skip: missing('R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY') }, async () => {
  const client = new S3Client({ region: 'auto', endpoint: env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, forcePathStyle: true,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! } });
  const bucket = env.R2_BUCKET!, key = `live-test/${randomUUID()}.png`;
  const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 120, b: 80 } } }).png().toBuffer();
  try {
    // The same path the app gives a branch owner: a short-lived PUT URL bound to the content type.
    const putUrl = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'image/png' }), { expiresIn: 120 });
    const uploaded = await fetch(putUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(png) });
    assert.equal(uploaded.status, 200, `presigned PUT failed: ${uploaded.status}`);
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    assert.equal(head.ContentLength, png.length);
    const getUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 60 });
    const fetched = Buffer.from(await (await fetch(getUrl)).arrayBuffer());
    assert.deepEqual(fetched, png);
    const processed = await sanitizeCourtImage(fetched);
    assert.deepEqual([processed.width, processed.height], [64, 48]);
    assert.equal((await sharp(processed.body).metadata()).format, 'webp');
    // The bucket must be private: the bare object URL is not readable without a signature.
    assert.notEqual((await fetch(getUrl.split('?')[0])).status, 200);
  } finally { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); }
});

test('Firebase: service account verifies a real ID token and the Google-only rule holds', { skip: missing('FIREBASE_PROJECT_ID', 'GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_WEB_API_KEY') }, async () => {
  const app = getApps().find(item => item.name === 'alobo-live-test') || initializeApp({ credential: applicationDefault(), projectId: env.FIREBASE_PROJECT_ID }, 'alobo-live-test');
  const uid = `live-test-${randomUUID()}`;
  try {
    // Mint a custom token, exchange it at Firebase Auth for a real ID token, then run it through the app's verifier.
    const custom = await getAuth(app).createCustomToken(uid);
    const exchanged = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY!)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
    assert.equal(exchanged.status, 200, 'custom token exchange failed: check FIREBASE_WEB_API_KEY belongs to FIREBASE_PROJECT_ID');
    const { idToken } = await exchanged.json() as { idToken: string };
    assert.equal((await getAuth(app).verifyIdToken(idToken, true)).uid, uid);
    // A genuine token that is not a verified Google sign-in must be refused by the login path.
    await assert.rejects(verifiedGoogleIdentity(idToken), (error: any) => error.code === 'UNSUPPORTED_SOCIAL_IDENTITY');
    await assert.rejects(verifiedGoogleIdentity(idToken.slice(0, -4) + 'AAAA'), (error: any) => error.code === 'INVALID_SOCIAL_TOKEN');
  } finally { await getAuth(app).deleteUser(uid).catch(() => undefined); }
});

test('Firebase: a real Google sign-in token is accepted', { skip: missing('FIREBASE_PROJECT_ID', 'GOOGLE_APPLICATION_CREDENTIALS', 'LIVE_TEST_GOOGLE_ID_TOKEN') }, async () => {
  const identity = await verifiedGoogleIdentity(env.LIVE_TEST_GOOGLE_ID_TOKEN!);
  assert.equal(identity.provider, 'google');
  assert.match(identity.email, /@/);
});

test('OTP email is delivered through the configured SMTP server', { skip: missing('SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'LIVE_TEST_EMAIL') }, async () => {
  const port = Number(env.SMTP_PORT || 587);
  const email = smtpTransport({ host: env.SMTP_HOST!, port, secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    user: env.SMTP_USER!, pass: env.SMTP_PASS!, from: env.SMTP_FROM! });
  assert.equal(await deliverOtp({ email }, { identifier: env.LIVE_TEST_EMAIL!, code: '000000', purpose: 'register' }), 'email');
});

test('OTP SMS is accepted by Twilio', { skip: missing('TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'LIVE_TEST_PHONE') }, async () => {
  const sms = twilioTransport({ accountSid: env.TWILIO_ACCOUNT_SID!, authToken: env.TWILIO_AUTH_TOKEN!, from: env.TWILIO_FROM! });
  assert.equal(await deliverOtp({ sms }, { identifier: env.LIVE_TEST_PHONE!, code: '000000', purpose: 'register' }), 'sms');
});
