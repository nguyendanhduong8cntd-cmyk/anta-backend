import { Injectable } from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { Database } from '../../packages/database';
import { RedisService } from '../../packages/redis';
import { loadConfig } from '../../packages/config';
import { ApiError, invariant } from '../../packages/contracts/errors';
import { checkPassword, digest, hashPassword, keyedDigest, secureEqual, token } from '../../packages/auth/crypto';
import { signAccess, Principal } from '../../packages/auth/tokens';
import { DeleteAccountDto, LoginDto, OtpSendDto, RegisterDto, ResetDto } from './dto';
import { verifiedGoogleIdentity } from './firebase';
export function normalizeIdentifier(value: string) {
  const identifier = value.trim().toLowerCase();
  invariant(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier) || /^\+[1-9]\d{7,14}$/.test(identifier),
    'INVALID_IDENTIFIER', 'Use a valid email or an E.164 phone number', 400);
  return identifier;
}
@Injectable()
export class IdentityService {
  private readonly config = loadConfig();
  private readonly dummyHash = hashPassword(token());
  constructor(private readonly db: Database, private readonly redis: RedisService) {}
  async sendOtp(dto: OtpSendDto, ip: string) {
    const identifier = normalizeIdentifier(dto.identifier);
    await this.redis.rateLimit(`otp:ip:${digest(ip)}`, 10, 3600000);
    await this.redis.rateLimit(`otp:account:${keyedDigest(identifier, this.config.otpSecret)}`, 1, 60000);
    const id = randomUUID(), code = String(randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + 300000);
    await this.db.transaction(async tx => {
      // Serialize challenges for the identifier: at most one unconsumed OTP per purpose.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`otp:${identifier}`]);
      await tx.query('UPDATE identity.otp_challenges SET consumed_at=now() WHERE identifier=$1 AND purpose=$2 AND consumed_at IS NULL', [identifier, dto.purpose]);
      await tx.query('INSERT INTO identity.otp_challenges(id,identifier,purpose,code_hash,expires_at) VALUES($1,$2,$3,$4,$5)',
        [id, identifier, dto.purpose, keyedDigest(`${id}:${code}`, this.config.otpSecret), expiresAt]);
    });
    // Development delivery is explicit, gated and never logged or returned by public auth endpoints.
    if (this.config.devOtp) await this.redis.client.set(`dev:otp:${id}`, code, 'EX', 300);
    return { challengeId: id, expiresAt, delivery: 'development-only' };
  }
  async developmentCode(challengeId: string, key: string | undefined) {
    invariant(this.config.devOtp && !this.config.production, 'NOT_FOUND', 'Not found', 404);
    invariant(key && secureEqual(key, this.config.devKey), 'FORBIDDEN', 'Invalid development key', 403);
    const code = await this.redis.client.get(`dev:otp:${challengeId}`);
    invariant(code, 'NOT_FOUND', 'Challenge is unavailable', 404);
    return { code };
  }
  async verifyOtp(challengeId: string, code: string) {
    const outcome = await this.db.transaction(async tx => {
      const challenge = (await tx.query('SELECT * FROM identity.otp_challenges WHERE id=$1 FOR UPDATE', [challengeId])).rows[0];
      if (!challenge || challenge.consumed_at || challenge.attempts >= 5 || challenge.expires_at.getTime() <= Date.now()) return null;
      await tx.query('UPDATE identity.otp_challenges SET attempts=attempts+1 WHERE id=$1', [challengeId]);
      if (!secureEqual(challenge.code_hash, keyedDigest(`${challengeId}:${code}`, this.config.otpSecret))) return null;
      await tx.query('UPDATE identity.otp_challenges SET consumed_at=now() WHERE id=$1', [challengeId]);
      return challenge;
    });
    // Throw OUTSIDE transaction so the attempt counter is committed even on failed attempts.
    invariant(outcome, 'INVALID_OTP', 'Invalid or expired verification code', 400);
    const verificationToken = token();
    await this.redis.client.set(`verification:${digest(verificationToken)}`,
      JSON.stringify({ identifier: outcome.identifier, purpose: outcome.purpose }), 'EX', 300);
    await this.redis.client.del(`dev:otp:${challengeId}`);
    return { verificationToken, expiresIn: 300 };
  }
  private async consumeVerification(value: string, identifier: string, purpose: string) {
    const raw = await this.redis.client.getdel(`verification:${digest(value)}`);
    const proof = raw ? JSON.parse(raw) : null;
    invariant(proof?.identifier === identifier && proof?.purpose === purpose, 'INVALID_VERIFICATION', 'Valid verification is required', 400);
  }
  private async newSession(tx: PoolClient, userId: string, deviceId: string, familyId = randomUUID()) {
    const refreshToken = token(), sessionId = randomUUID();
    await tx.query('INSERT INTO identity.refresh_sessions(id,user_id,family_id,refresh_hash,device_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval \'30 days\')',
      [sessionId, userId, familyId, digest(refreshToken), deviceId]);
    return { accessToken: await signAccess(userId, sessionId, this.config.jwtSecret), refreshToken, expiresIn: 900, tokenType: 'Bearer' };
  }
  async register(dto: RegisterDto) {
    const identifier = normalizeIdentifier(dto.identifier);
    invariant(dto.displayName.trim(), 'VALIDATION_FAILED', 'Display name cannot be blank', 400);
    await this.consumeVerification(dto.verificationToken, identifier, 'register');
    const passwordHash = await hashPassword(dto.password);
    return this.db.transaction(async tx => {
      const user = (await tx.query('INSERT INTO identity.users(identifier,display_name,password_hash) VALUES($1,$2,$3) RETURNING id,display_name',
        [identifier, dto.displayName.trim(), passwordHash])).rows[0];
      return { user: { id: user.id, displayName: user.display_name }, ...await this.newSession(tx, user.id, dto.deviceId) };
    });
  }
  async login(dto: LoginDto, ip: string) {
    const identifier = normalizeIdentifier(dto.identifier);
    await this.redis.rateLimit(`login:ip:${digest(ip)}`, 30, 60000);
    await this.redis.rateLimit(`login:account:${keyedDigest(identifier, this.config.otpSecret)}`, 10, 60000);
    const user = (await this.db.query('SELECT * FROM identity.users WHERE identifier=$1', [identifier])).rows[0];
    const valid = await checkPassword(dto.password, user?.password_hash || await this.dummyHash);
    invariant(valid && user?.status === 'ACTIVE' && user?.password_login_enabled, 'INVALID_CREDENTIALS', 'Invalid credentials', 401);
    return this.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`identity-user:${user.id}`]);
      const current = (await tx.query('SELECT password_hash,status,password_login_enabled FROM identity.users WHERE id=$1', [user.id])).rows[0];
      invariant(current?.password_hash === user.password_hash && current?.status === 'ACTIVE' && current?.password_login_enabled,
        'INVALID_CREDENTIALS', 'Invalid credentials', 401);
      return this.newSession(tx, user.id, dto.deviceId);
    });
  }
  async refresh(refreshToken: string) {
    const outcome = await this.db.transaction(async tx => {
      const ref = (await tx.query('SELECT user_id,family_id FROM identity.refresh_sessions WHERE refresh_hash=$1', [digest(refreshToken)])).rows[0];
      if (!ref) return null;
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`identity-user:${ref.user_id}`]);
      // Family-wide advisory lock prevents rotation/reuse races involving different session rows.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`session-family:${ref.family_id}`]);
      const session = (await tx.query('SELECT * FROM identity.refresh_sessions WHERE refresh_hash=$1 FOR UPDATE', [digest(refreshToken)])).rows[0];
      if (session.rotated_at) {
        await tx.query('UPDATE identity.refresh_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE family_id=$1', [session.family_id]);
        return null;
      }
      if (session.revoked_at || session.expires_at.getTime() <= Date.now()) return null;
      const active = await tx.query("SELECT 1 FROM identity.users WHERE id=$1 AND status='ACTIVE'", [session.user_id]);
      if (!active.rowCount) return null;
      await tx.query('UPDATE identity.refresh_sessions SET rotated_at=now(),revoked_at=now() WHERE id=$1', [session.id]);
      return this.newSession(tx, session.user_id, session.device_id, session.family_id);
    });
    invariant(outcome, 'INVALID_REFRESH_TOKEN', 'Invalid refresh token', 401);
    return outcome;
  }
  async logout(principal: Principal) {
    await this.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`identity-user:${principal.userId}`]);
      await tx.query('UPDATE identity.refresh_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND user_id=$2', [principal.sessionId, principal.userId]);
    });
    return { loggedOut: true };
  }
  async resetPassword(dto: ResetDto) {
    const identifier = normalizeIdentifier(dto.identifier);
    await this.consumeVerification(dto.verificationToken, identifier, 'reset-password');
    const hash = await hashPassword(dto.password);
    await this.db.transaction(async tx => {
      const user = (await tx.query('SELECT id FROM identity.users WHERE identifier=$1', [identifier])).rows[0];
      if (user) {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`identity-user:${user.id}`]);
        await tx.query('UPDATE identity.users SET password_hash=$2,password_login_enabled=true,updated_at=now(),version=version+1 WHERE id=$1', [user.id, hash]);
        await tx.query('UPDATE identity.refresh_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1', [user.id]);
      }
    });
    return { accepted: true };
  }
  async profile(userId: string) {
    const row = (await this.db.query('SELECT id,identifier,display_name,created_at,version FROM identity.users WHERE id=$1', [userId])).rows[0];
    invariant(row, 'NOT_FOUND', 'User not found', 404);
    return { id: row.id, identifier: row.identifier, displayName: row.display_name, createdAt: row.created_at, version: row.version };
  }
  async updateProfile(userId: string, displayName?: string) {
    if (displayName !== undefined) {
      invariant(displayName.trim(), 'VALIDATION_FAILED', 'Display name cannot be blank', 400);
      await this.db.query('UPDATE identity.users SET display_name=$2,updated_at=now(),version=version+1 WHERE id=$1', [userId, displayName.trim()]);
    }
    return this.profile(userId);
  }
  async device(userId: string, deviceId: string, fcmToken: string) {
    // Never steal another user's device/token without explicit removal by that owner.
    await this.db.query('INSERT INTO identity.devices(user_id,device_id,fcm_token) VALUES($1,$2,$3) ON CONFLICT(user_id,device_id) DO UPDATE SET fcm_token=excluded.fcm_token,updated_at=now()', [userId, deviceId, fcmToken]);
    return { registered: true };
  }
  async removeDevice(userId: string, deviceId: string) {
    await this.db.query('DELETE FROM identity.devices WHERE user_id=$1 AND device_id=$2', [userId, deviceId]);
    return { removed: true };
  }
  async social(idToken: string, deviceId: string) {
    const identity = await verifiedGoogleIdentity(idToken);
    return this.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`social:${identity.provider}:${identity.subject}`]);
      const linked = (await tx.query(`SELECT u.id,u.status FROM identity.linked_accounts a
        JOIN identity.users u ON u.id=a.user_id WHERE a.provider=$1 AND a.provider_subject=$2`,
        [identity.provider, identity.subject])).rows[0];
      let userId = linked?.id;
      if (linked) invariant(linked.status === 'ACTIVE', 'ACCOUNT_UNAVAILABLE', 'Account is unavailable', 403);
      else {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`identity-identifier:${identity.email}`]);
        const collision = await tx.query('SELECT 1 FROM identity.users WHERE identifier=$1', [identity.email]);
        invariant(!collision.rowCount, 'ACCOUNT_LINK_REQUIRED', 'Sign in to the existing account before linking Google', 409);
        const passwordHash = await hashPassword(token());
        userId = (await tx.query(`INSERT INTO identity.users(identifier,display_name,password_hash,password_login_enabled)
          VALUES($1,$2,$3,false) RETURNING id`, [identity.email, identity.email.split('@')[0], passwordHash])).rows[0].id;
        await tx.query('INSERT INTO identity.linked_accounts(user_id,provider,provider_subject) VALUES($1,$2,$3)',
          [userId, identity.provider, identity.subject]);
      }
      const user = (await tx.query('SELECT id,identifier,display_name,created_at,version FROM identity.users WHERE id=$1', [userId])).rows[0];
      return { user: { id: user.id, identifier: user.identifier, displayName: user.display_name,
        createdAt: user.created_at, version: user.version }, ...await this.newSession(tx, userId, deviceId) };
    });
  }
  async linkedAccounts(userId: string) {
    return (await this.db.query('SELECT id,provider,created_at FROM identity.linked_accounts WHERE user_id=$1 ORDER BY created_at', [userId])).rows;
  }
  async linkAccount(userId: string, idToken: string) {
    const identity = await verifiedGoogleIdentity(idToken);
    return this.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`social:${identity.provider}:${identity.subject}`]);
      const linked = (await tx.query('SELECT id,user_id FROM identity.linked_accounts WHERE provider=$1 AND provider_subject=$2',
        [identity.provider, identity.subject])).rows[0];
      invariant(!linked || linked.user_id === userId, 'SOCIAL_ACCOUNT_IN_USE', 'Google account is already linked elsewhere', 409);
      if (linked) return { id: linked.id, provider: identity.provider, linked: true };
      const sameProvider = await tx.query('SELECT 1 FROM identity.linked_accounts WHERE user_id=$1 AND provider=$2', [userId, identity.provider]);
      invariant(!sameProvider.rowCount, 'PROVIDER_ALREADY_LINKED', 'Another Google account is already linked', 409);
      const row = (await tx.query('INSERT INTO identity.linked_accounts(user_id,provider,provider_subject) VALUES($1,$2,$3) RETURNING id',
        [userId, identity.provider, identity.subject])).rows[0];
      return { id: row.id, provider: identity.provider, linked: true };
    });
  }
  async unlinkAccount(userId: string, id: string) {
    return this.db.transaction(async tx => {
      const user = (await tx.query('SELECT password_login_enabled FROM identity.users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
      const linked = (await tx.query('SELECT id FROM identity.linked_accounts WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
      invariant(linked, 'NOT_FOUND', 'Linked account not found', 404);
      const count = (await tx.query('SELECT count(*)::int AS n FROM identity.linked_accounts WHERE user_id=$1', [userId])).rows[0].n;
      invariant(user.password_login_enabled || count > 1, 'LAST_LOGIN_METHOD', 'Set a password before removing the last login method', 409);
      await tx.query('DELETE FROM identity.linked_accounts WHERE id=$1', [id]);
      return { removed: true };
    });
  }
  async requestDeletion(userId: string, proof: DeleteAccountDto, requestId?: string) {
    await this.redis.rateLimit(`delete:account:${userId}`, 5, 3600000);
    invariant(Boolean(proof.password) !== Boolean(proof.firebaseIdToken), 'INVALID_REAUTH', 'Provide exactly one re-authentication method', 400);
    const user = (await this.db.query('SELECT password_hash,password_login_enabled FROM identity.users WHERE id=$1', [userId])).rows[0];
    let socialIdentity: Awaited<ReturnType<typeof verifiedGoogleIdentity>> | undefined;
    if (proof.password) {
      const valid = await checkPassword(proof.password, user?.password_hash || await this.dummyHash);
      invariant(user?.password_login_enabled && valid, 'INVALID_CREDENTIALS', 'Password re-authentication is required', 401);
    } else {
      socialIdentity = await verifiedGoogleIdentity(proof.firebaseIdToken!);
      const age = Date.now() / 1000 - socialIdentity.authTime;
      invariant(Number.isFinite(age) && age >= -60 && age <= 300,
        'REAUTH_REQUIRED', 'Sign in to Google again before deleting the account', 401);
      const linked = await this.db.query('SELECT 1 FROM identity.linked_accounts WHERE user_id=$1 AND provider=$2 AND provider_subject=$3',
        [userId, socialIdentity.provider, socialIdentity.subject]);
      invariant(linked.rowCount, 'INVALID_REAUTH', 'Google account is not linked to this user', 401);
    }
    return this.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`identity-user:${userId}`]);
      const current = (await tx.query('SELECT status,password_hash FROM identity.users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
      invariant(current?.status === 'ACTIVE' && current.password_hash === user.password_hash,
        'ACCOUNT_UNAVAILABLE', 'Account is unavailable', 409);
      if (socialIdentity) {
        const linked = await tx.query('SELECT 1 FROM identity.linked_accounts WHERE user_id=$1 AND provider=$2 AND provider_subject=$3',
          [userId, socialIdentity.provider, socialIdentity.subject]);
        invariant(linked.rowCount, 'INVALID_REAUTH', 'Google account is not linked to this user', 401);
      }
      const isAdmin = await tx.query("SELECT 1 FROM identity.roles WHERE user_id=$1 AND role='admin'", [userId]);
      if (isAdmin.rowCount) {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['admin-role-changes']);
        const activeAdmins = (await tx.query(`SELECT count(*)::int AS n FROM identity.roles r
          JOIN identity.users u ON u.id=r.user_id WHERE r.role='admin' AND u.status='ACTIVE'`)).rows[0].n;
        invariant(activeAdmins > 1, 'LAST_ADMIN', 'Transfer administrator access before deleting this account', 409);
      }
      const row = (await tx.query(`INSERT INTO identity.deletion_requests(user_id,purge_after)
        VALUES($1,now()+interval '30 days') ON CONFLICT(user_id) DO UPDATE SET requested_at=now(),purge_after=excluded.purge_after
        RETURNING requested_at,purge_after`, [userId])).rows[0];
      await tx.query("UPDATE identity.users SET status='DELETION_REQUESTED',updated_at=now(),version=version+1 WHERE id=$1", [userId]);
      await tx.query('UPDATE identity.refresh_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1', [userId]);
      await tx.query('DELETE FROM identity.devices WHERE user_id=$1', [userId]);
      await tx.query(`INSERT INTO platform.audit_events(actor_id,action,target_type,target_id,request_id)
        VALUES($1,'account.deletion_requested','user',$2,$3)`, [userId, userId, requestId || null]);
      return { status: 'DELETION_REQUESTED', requestedAt: row.requested_at, earliestPurgeAt: row.purge_after,
        note: 'Personal-data purge requires a retention and legal review; no automatic purge is enabled' };
    });
  }
}
