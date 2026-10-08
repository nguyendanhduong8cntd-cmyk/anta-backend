import { createRemoteJWKSet, errors, jwtVerify, JWTVerifyGetKey } from 'jose';
import { googleClientIds } from '../../packages/config';
import { ApiError, invariant } from '../../packages/contracts/errors';

const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_KEYS = 'https://www.googleapis.com/oauth2/v3/certs';
/** A sign-in proves a moment: Google lets an ID token live for an hour, this backend takes it for ten minutes. */
const MAX_TOKEN_AGE_SECONDS = 600;
/** How far this server's clock and Google's may disagree. It is part of the ten minutes, not added to them. */
const CLOCK_TOLERANCE_SECONDS = 60;
let remote: { url: string; keys: JWTVerifyGetKey } | undefined;

function googleKeys() {
  // Whoever names the keys decides who can sign in, so GOOGLE_JWKS_URL counts in integration tests only;
  // loadConfig also refuses it anywhere else.
  const url = (process.env.NODE_ENV === 'test' && process.env.GOOGLE_JWKS_URL) || GOOGLE_KEYS;
  // Google rotates its keys every few days: an hour's cache rides out a short outage of its key server.
  if (remote?.url !== url) remote = { url, keys: createRemoteJWKSet(new URL(url), { cacheMaxAge: 3600000 }) };
  return remote.keys;
}
/** Google's keys could not be fetched, or came back unusable, which says nothing about the token. */
const keysUnavailable = (error: unknown) => !(error instanceof errors.JOSEError) || error instanceof errors.JWKSTimeout
  || error instanceof errors.JWKSInvalid || error.code === 'ERR_JOSE_GENERIC';

/**
 * Who a Google ID token says the caller is, once Google's signature on it, its issuer, its audience (one of this
 * backend's OAuth clients), its expiry and its age have been checked.
 */
export async function verifiedGoogleIdentity(idToken: string, keys?: JWTVerifyGetKey) {
  const audience = googleClientIds();
  if (!audience.length) throw new ApiError('INTEGRATION_NOT_CONFIGURED', 'Google sign-in is not configured', 503);
  let claims;
  try {
    // jose adds the tolerance to the age limit, so it is taken off here.
    claims = (await jwtVerify(idToken, keys ?? googleKeys(), { issuer: ISSUERS, audience, algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub'], maxTokenAge: MAX_TOKEN_AGE_SECONDS - CLOCK_TOLERANCE_SECONDS,
      clockTolerance: CLOCK_TOLERANCE_SECONDS })).payload;
  } catch (error) {
    if (keysUnavailable(error)) {
      console.error(JSON.stringify({ event: 'google.keys_unavailable', errorType: error instanceof Error ? error.name : typeof error }));
      throw new ApiError('DEPENDENCY_UNAVAILABLE', 'Google sign-in is temporarily unavailable', 503);
    }
    throw new ApiError('INVALID_SOCIAL_TOKEN', 'Google identity token is invalid or expired', 401);
  }
  const { sub, email, iat, name } = claims;
  invariant(typeof sub === 'string' && sub.length > 0 && sub.length <= 255 && typeof email === 'string' && email.length <= 254
    && claims.email_verified === true && typeof iat === 'number', 'UNSUPPORTED_SOCIAL_IDENTITY', 'A verified Google account is required', 400);
  return { provider: 'google' as const, subject: sub, email: email.toLowerCase(),
    name: typeof name === 'string' ? Array.from(name.trim()).slice(0, 100).join('') : '', issuedAt: iat };
}
