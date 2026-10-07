import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { ApiError, invariant } from '../../packages/contracts/errors';

export async function verifiedGoogleIdentity(idToken: string) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId || !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new ApiError('INTEGRATION_NOT_CONFIGURED', 'Firebase identity credentials are not configured', 503);
  }
  const app = getApps().find(x => x.name === 'alobo-identity') || initializeApp({ credential: applicationDefault(), projectId }, 'alobo-identity');
  let claims;
  try { claims = await getAuth(app).verifyIdToken(idToken, true); }
  catch { throw new ApiError('INVALID_SOCIAL_TOKEN', 'Social identity token is invalid or revoked', 401); }
  invariant(claims.firebase.sign_in_provider === 'google.com' && claims.email_verified === true && claims.email,
    'UNSUPPORTED_SOCIAL_IDENTITY', 'A verified Google account is required', 400);
  return { provider: 'google' as const, subject: claims.uid, email: claims.email.toLowerCase(), authTime: claims.auth_time };
}
