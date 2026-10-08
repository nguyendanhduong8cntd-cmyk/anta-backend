import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { googleClientIds, loadConfig } from '../../packages/config';
import { verifiedGoogleIdentity } from '../../modules/identity/google';

const CLIENT = '1234567890-anta.apps.googleusercontent.com';
const now = () => Math.floor(Date.now() / 1000);
const code = (expected: string) => (error: any) => error.code === expected;

async function google() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'k1', alg: 'RS256', use: 'sig' }] });
  /** An ID token as Google issues it; `claims` and `header` override single parts to make it wrong. */
  const token = (claims: Record<string, unknown> = {}, key: CryptoKey = privateKey) => new SignJWT({ iss: 'https://accounts.google.com',
    aud: CLIENT, sub: '108000000000000000001', email: 'An.Nguyen@Gmail.com', email_verified: true, name: ' An Nguyễn ',
    iat: now(), exp: now() + 3600, ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(key);
  return { keys, token };
}

test('Google ID token: a token Google signed for this backend names the account', async () => {
  process.env.GOOGLE_CLIENT_ID = `${CLIENT}, 999-web.apps.googleusercontent.com`;
  const { keys, token } = await google();
  const issuedAt = now() - 5;
  assert.deepEqual(await verifiedGoogleIdentity(await token({ iat: issuedAt }), keys),
    { provider: 'google', subject: '108000000000000000001', email: 'an.nguyen@gmail.com', name: 'An Nguyễn', issuedAt });
  // Google issues tokens under two spellings of its name, and any configured client may be the audience.
  const other = await verifiedGoogleIdentity(await token({ iss: 'accounts.google.com', aud: '999-web.apps.googleusercontent.com', name: undefined }), keys);
  assert.equal(other.name, '');
});

test('Google ID token: anything not signed by Google for this backend, or no longer fresh, is refused', async () => {
  process.env.GOOGLE_CLIENT_ID = CLIENT;
  const { keys, token } = await google();
  const stranger = (await generateKeyPair('RS256')).privateKey;
  const refused = code('INVALID_SOCIAL_TOKEN');
  await assert.rejects(verifiedGoogleIdentity(await token({ aud: 'someone-else.apps.googleusercontent.com' }), keys), refused);
  await assert.rejects(verifiedGoogleIdentity(await token({ iss: 'https://accounts.example.com' }), keys), refused);
  await assert.rejects(verifiedGoogleIdentity(await token({ iat: now() - 7200, exp: now() - 3600 }), keys), refused);
  // Still within Google's hour, but older than the ten minutes a sign-in is taken for; just inside them it passes.
  await assert.rejects(verifiedGoogleIdentity(await token({ iat: now() - 630 }), keys), refused);
  assert.equal((await verifiedGoogleIdentity(await token({ iat: now() - 570 }), keys)).provider, 'google');
  await assert.rejects(verifiedGoogleIdentity(await token({ iat: now() + 600 }), keys), refused);
  await assert.rejects(verifiedGoogleIdentity(await token({ exp: undefined }), keys), refused);
  await assert.rejects(verifiedGoogleIdentity(await token({}, stranger), keys), refused);
  await assert.rejects(verifiedGoogleIdentity('x'.repeat(120), keys), refused);
  const [header, payload, signature] = (await token()).split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: 'someone-else' })).toString('base64url');
  await assert.rejects(verifiedGoogleIdentity(`${header}.${forged}.${signature}`, keys), refused);
  const unsigned = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  await assert.rejects(verifiedGoogleIdentity(`${unsigned}.${payload}.`, keys), refused);
});

test('Google ID token: an account without a verified email is not an identity', async () => {
  process.env.GOOGLE_CLIENT_ID = CLIENT;
  const { keys, token } = await google();
  const unsupported = code('UNSUPPORTED_SOCIAL_IDENTITY');
  await assert.rejects(verifiedGoogleIdentity(await token({ email_verified: false }), keys), unsupported);
  await assert.rejects(verifiedGoogleIdentity(await token({ email_verified: 'true' }), keys), unsupported);
  await assert.rejects(verifiedGoogleIdentity(await token({ email: undefined }), keys), unsupported);
  await assert.rejects(verifiedGoogleIdentity(await token({ sub: '' }), keys), unsupported);
});

test('Google sign-in is off until a client ID is configured, and keys that cannot be read are not the caller\'s fault', async () => {
  const { keys, token } = await google();
  delete process.env.GOOGLE_CLIENT_ID;
  assert.deepEqual(googleClientIds(), []);
  await assert.rejects(verifiedGoogleIdentity(await token(), keys), (error: any) => error.code === 'INTEGRATION_NOT_CONFIGURED' && error.status === 503);
  process.env.GOOGLE_CLIENT_ID = CLIENT;
  const unavailable = (error: any) => error.code === 'DEPENDENCY_UNAVAILABLE' && error.status === 503;
  // The network failed, Google answered with an error page, or its key set came back malformed.
  for (const failure of [new TypeError('fetch failed'), new errors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response'),
    new errors.JWKSInvalid('JSON Web Key Set malformed'), new errors.JWKSTimeout()]) {
    await assert.rejects(verifiedGoogleIdentity(await token(), async () => { throw failure; }), unavailable);
  }
  // A key Google does not publish is a forged token, not an outage.
  await assert.rejects(verifiedGoogleIdentity(await token(), async () => { throw new errors.JWKSNoMatchingKey(); }), code('INVALID_SOCIAL_TOKEN'));
});

test('configuration: Google client IDs are checked, the key-source hook is for local tests only, proxy hops are a small whole number', () => {
  const env = { DATABASE_URL: 'postgresql://x', REDIS_URL: 'redis://x', JWT_SECRET: 'j'.repeat(32), OTP_HASH_SECRET: 'o'.repeat(32),
    SANDBOX_WEBHOOK_SECRET: 'w'.repeat(32), PAYMENT_PROVIDER: 'sandbox', OTP_DELIVERY: 'development' };
  assert.doesNotThrow(() => loadConfig({ ...env, GOOGLE_CLIENT_ID: CLIENT }));
  assert.throws(() => loadConfig({ ...env, GOOGLE_CLIENT_ID: 'not-a-client-id' }), /GOOGLE_CLIENT_ID/);
  // Whoever names the key server decides who can sign in.
  const hook = 'http://127.0.0.1:9/certs';
  assert.doesNotThrow(() => loadConfig({ ...env, NODE_ENV: 'test', GOOGLE_JWKS_URL: hook }));
  for (const NODE_ENV of [undefined, 'development', 'staging']) assert.throws(() => loadConfig({ ...env, NODE_ENV, GOOGLE_JWKS_URL: hook }), /GOOGLE_JWKS_URL/);
  assert.throws(() => loadConfig({ ...env, NODE_ENV: 'production', PAYMENT_PROVIDER: 'payos', OTP_DELIVERY: 'provider', GOOGLE_JWKS_URL: hook }), /GOOGLE_JWKS_URL/);
  for (const url of ['https://keys.example.com/certs', 'http://10.0.0.5/certs', 'not a url']) {
    assert.throws(() => loadConfig({ ...env, NODE_ENV: 'test', GOOGLE_JWKS_URL: url }), /GOOGLE_JWKS_URL/);
  }
  assert.deepEqual([loadConfig(env).trustedProxyHops, loadConfig({ ...env, TRUSTED_PROXY_HOPS: '2' }).trustedProxyHops], [0, 2]);
  for (const hops of ['-1', '1.5', 'true', '11']) assert.throws(() => loadConfig({ ...env, TRUSTED_PROXY_HOPS: hops }), /TRUSTED_PROXY_HOPS/);
});
