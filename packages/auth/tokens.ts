import { SignJWT, jwtVerify } from 'jose';
export interface Principal { userId: string; sessionId: string }
const issuer = 'alobo-clone';
const audience = 'alobo-android';
export async function signAccess(userId: string, sessionId: string, secret: string) {
  return new SignJWT({ sid: sessionId }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId)
    .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('15m').sign(new TextEncoder().encode(secret));
}
export async function verifyAccess(jwt: string, secret: string): Promise<Principal> {
  const { payload } = await jwtVerify(jwt, new TextEncoder().encode(secret), { issuer, audience, algorithms: ['HS256'] });
  if (!payload.sub || typeof payload.sid !== 'string') throw new Error('Invalid principal');
  return { userId: payload.sub, sessionId: payload.sid };
}
