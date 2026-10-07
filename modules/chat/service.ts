import { Injectable } from '@nestjs/common';
import { Database, DbClient } from '../../packages/database';
import { Idempotency } from '../../packages/idempotency';
import { invariant } from '../../packages/contracts/errors';
import { emitEvent } from '../../packages/events';
import { ConversationDto, EnvelopeDto, KeyBundleDto } from './dto';
export interface EncryptedPayload { senderDeviceId?: string; envelopes?: EnvelopeDto[] }

@Injectable()
export class ChatService {
  constructor(private readonly db: Database, private readonly idem: Idempotency) {}
  private async member(tx: DbClient, userId: string, conversationId: string, active = true) {
    const row = (await tx.query('SELECT * FROM chat.members WHERE conversation_id=$1 AND user_id=$2', [conversationId, userId])).rows[0];
    invariant(row && (!active || row.status === 'ACTIVE'), 'NOT_FOUND', 'Conversation not found', 404);
    return row;
  }
  async create(userId: string, dto: ConversationDto) {
    invariant(dto.title.trim().length >= 2, 'VALIDATION_FAILED', 'Conversation title is required', 400);
    const invitees = [...new Set(dto.memberIds.filter(id => id !== userId))];
    return this.db.transaction(async tx => {
      if (invitees.length) {
        const valid = (await tx.query("SELECT count(*)::int AS n FROM identity.users WHERE id=ANY($1::uuid[]) AND status='ACTIVE'", [invitees])).rows[0].n;
        invariant(valid === invitees.length, 'USER_UNAVAILABLE', 'One or more invitees are unavailable', 400);
      }
      const row = (await tx.query('INSERT INTO chat.conversations(title,created_by,kind,encryption) VALUES($1,$2,$3,$4) RETURNING *',
        [dto.title.trim(), userId, invitees.length === 1 ? 'DIRECT' : 'GROUP', dto.encrypted ? 'E2E' : 'NONE'])).rows[0];
      await tx.query("INSERT INTO chat.members(conversation_id,user_id,role,status) VALUES($1,$2,'OWNER','ACTIVE')", [row.id, userId]);
      for (const invitee of invitees) {
        await tx.query("INSERT INTO chat.members(conversation_id,user_id,role,status) VALUES($1,$2,'MEMBER','INVITED')", [row.id, invitee]);
        await emitEvent(tx, invitee, 'chat.invited', { conversationId: row.id, title: row.title });
      }
      return row;
    });
  }
  async list(userId: string) {
    return (await this.db.query(`SELECT c.id,c.title,c.kind,c.encryption,c.created_at,c.updated_at,m.role,m.status,m.last_read_seq,
      CASE WHEN m.status='ACTIVE' THEN greatest(0,c.next_seq-m.last_read_seq-1)::int ELSE 0 END AS unread_count
      FROM chat.conversations c JOIN chat.members m ON m.conversation_id=c.id WHERE m.user_id=$1 AND m.status<>'LEFT'
      ORDER BY c.updated_at DESC,c.id LIMIT 100`, [userId])).rows;
  }
  async accept(userId: string, conversationId: string) {
    return this.db.transaction(async tx => {
      const member = await this.member(tx, userId, conversationId, false);
      invariant(member.status !== 'LEFT', 'INVITATION_CLOSED', 'Invitation is closed');
      return (await tx.query("UPDATE chat.members SET status='ACTIVE' WHERE conversation_id=$1 AND user_id=$2 RETURNING *", [conversationId, userId])).rows[0];
    });
  }
  async invite(userId: string, conversationId: string, inviteeId: string) {
    return this.db.transaction(async tx => {
      const caller = await this.member(tx, userId, conversationId);
      invariant(caller.role === 'OWNER', 'FORBIDDEN', 'Conversation owner permission required', 403);
      const count = (await tx.query("SELECT count(*)::int AS n FROM chat.members WHERE conversation_id=$1 AND status<>'LEFT'", [conversationId])).rows[0].n;
      invariant(count < 50, 'CONVERSATION_FULL', 'Conversation has reached member limit');
      const target = await tx.query("SELECT 1 FROM identity.users WHERE id=$1 AND status='ACTIVE'", [inviteeId]);
      invariant(target.rowCount && inviteeId !== userId, 'USER_UNAVAILABLE', 'Invitee is unavailable', 400);
      const row = (await tx.query(`INSERT INTO chat.members(conversation_id,user_id,role,status)
        VALUES($1,$2,'MEMBER','INVITED') ON CONFLICT(conversation_id,user_id) DO UPDATE SET status='INVITED'
        WHERE chat.members.status='LEFT' RETURNING *`, [conversationId, inviteeId])).rows[0];
      invariant(row, 'ALREADY_INVITED', 'User already belongs to conversation');
      await emitEvent(tx, inviteeId, 'chat.invited', { conversationId });
      return row;
    });
  }
  /** For an encrypted conversation each message carries only the envelope addressed to the caller's device. */
  async messages(userId: string, conversationId: string, after: string, deviceId?: string) {
    invariant(/^\d{1,18}$/.test(after), 'INVALID_CURSOR', 'Invalid message cursor', 400);
    await this.member(this.db.pool, userId, conversationId);
    return (await this.db.query(`SELECT m.id,m.conversation_id,m.seq,m.sender_id,m.sender_device_id,
      CASE WHEN m.deleted_at IS NULL AND c.encryption='NONE' THEN m.body ELSE NULL END AS body,
      CASE WHEN m.deleted_at IS NULL AND e.message_id IS NOT NULL THEN jsonb_build_object('kind',e.kind,'ciphertext',e.ciphertext) END AS envelope,
      m.deleted_at,m.created_at
      FROM chat.messages m JOIN chat.conversations c ON c.id=m.conversation_id
      LEFT JOIN chat.message_envelopes e ON e.message_id=m.id AND e.recipient_id=$3 AND e.device_id=$4
      WHERE m.conversation_id=$1 AND m.seq>$2 ORDER BY m.seq LIMIT 100`, [conversationId, after, userId, deviceId || ''])).rows;
  }
  async send(userId: string, conversationId: string, body: string | undefined, key: string | undefined, requestId?: string, encrypted: EncryptedPayload = {}) {
    const envelopes = encrypted.envelopes || [];
    invariant(envelopes.length || (typeof body === 'string' && body.trim().length > 0 && body.length <= 4000),
      'VALIDATION_FAILED', 'Message must have 1-4000 characters', 400);
    return this.idem.run(userId, `chat-message:${conversationId}`, key, { body, encrypted }, async tx => {
      const conversation = (await tx.query('SELECT * FROM chat.conversations WHERE id=$1 FOR UPDATE', [conversationId])).rows[0];
      invariant(conversation, 'NOT_FOUND', 'Conversation not found', 404);
      await this.member(tx, userId, conversationId);
      const e2e = conversation.encryption === 'E2E';
      // Fail closed in both directions: no plaintext in an encrypted conversation, no ciphertext in a plaintext one.
      invariant(e2e ? envelopes.length > 0 && body === undefined && encrypted.senderDeviceId : envelopes.length === 0,
        e2e ? 'ENCRYPTION_REQUIRED' : 'ENCRYPTION_NOT_ENABLED', e2e ? 'This conversation accepts encrypted envelopes only' : 'This conversation is not encrypted', 400);
      if (e2e) {
        const targets = new Set(envelopes.map(item => `${item.recipientId}:${item.deviceId}`));
        invariant(targets.size === envelopes.length, 'VALIDATION_FAILED', 'Duplicate envelope recipient device', 400);
        const known = (await tx.query(`SELECT k.user_id,k.device_id FROM chat.device_keys k JOIN chat.members m ON m.user_id=k.user_id
          WHERE m.conversation_id=$1 AND m.status='ACTIVE'`, [conversationId])).rows.map(row => `${row.user_id}:${row.device_id}`);
        invariant(known.includes(`${userId}:${encrypted.senderDeviceId}`), 'DEVICE_NOT_REGISTERED', 'Register this device key bundle first', 409);
        invariant([...targets].every(target => known.includes(target)), 'UNKNOWN_RECIPIENT_DEVICE', 'An envelope targets a device that is not an active member device', 409);
      }
      const seq = conversation.next_seq;
      await tx.query('UPDATE chat.conversations SET next_seq=next_seq+1,updated_at=now() WHERE id=$1', [conversationId]);
      const row = (await tx.query(`INSERT INTO chat.messages(conversation_id,seq,sender_id,body,sender_device_id)
        VALUES($1,$2,$3,$4,$5) RETURNING id,conversation_id,seq,sender_id,sender_device_id,body,created_at`,
        [conversationId, seq, userId, e2e ? '' : body, e2e ? encrypted.senderDeviceId : null])).rows[0];
      for (const item of envelopes) await tx.query(`INSERT INTO chat.message_envelopes(message_id,recipient_id,device_id,kind,ciphertext)
        VALUES($1,$2,$3,$4,$5)`, [row.id, item.recipientId, item.deviceId, item.kind, item.ciphertext]);
      if (e2e) row.body = null;
      await tx.query('UPDATE chat.members SET last_read_seq=$3 WHERE conversation_id=$1 AND user_id=$2', [conversationId, userId, seq]);
      const recipients = (await tx.query("SELECT user_id FROM chat.members WHERE conversation_id=$1 AND status='ACTIVE'", [conversationId])).rows;
      for (const recipient of recipients) await emitEvent(tx, recipient.user_id, 'chat.message',
        { conversationId, messageId: row.id, seq: String(seq) }, requestId);
      return row;
    });
  }
  async read(userId: string, conversationId: string, seq: number) {
    return this.db.transaction(async tx => {
      const conversation = (await tx.query('SELECT next_seq FROM chat.conversations WHERE id=$1', [conversationId])).rows[0];
      invariant(conversation, 'NOT_FOUND', 'Conversation not found', 404);
      await this.member(tx, userId, conversationId);
      return (await tx.query(`UPDATE chat.members SET last_read_seq=greatest(last_read_seq,least($3,next_seq-1))
        FROM chat.conversations WHERE chat.members.conversation_id=$1 AND chat.members.user_id=$2
        AND chat.conversations.id=$1 RETURNING chat.members.last_read_seq`, [conversationId, userId, seq])).rows[0];
    });
  }
  async deleteMessage(userId: string, id: string) {
    return this.db.transaction(async tx => {
      const row = (await tx.query('SELECT * FROM chat.messages WHERE id=$1 FOR UPDATE', [id])).rows[0];
      invariant(row, 'NOT_FOUND', 'Message not found', 404);
      const member = await this.member(tx, userId, row.conversation_id);
      invariant(row.sender_id === userId || member.role === 'OWNER', 'FORBIDDEN', 'Cannot delete this message', 403);
      await tx.query('UPDATE chat.messages SET deleted_at=coalesce(deleted_at,now()) WHERE id=$1', [id]);
      await tx.query('DELETE FROM chat.message_envelopes WHERE message_id=$1', [id]);
      return { messageId: id, deleted: true };
    });
  }
  async pin(userId: string, messageId: string) {
    return this.db.transaction(async tx => {
      const row = (await tx.query('SELECT conversation_id FROM chat.messages WHERE id=$1 AND deleted_at IS NULL', [messageId])).rows[0];
      invariant(row, 'NOT_FOUND', 'Message not found', 404);
      const member = await this.member(tx, userId, row.conversation_id);
      invariant(member.role === 'OWNER', 'FORBIDDEN', 'Owner permission required', 403);
      await tx.query('INSERT INTO chat.pins(conversation_id,message_id,pinned_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [row.conversation_id, messageId, userId]);
      return { pinned: true };
    });
  }
  // ---- End-to-end encryption: Signal protocol key directory. The server holds public keys only. ----
  /** Publishes or replaces a device's key bundle and tops up its one-time prekeys. */
  async registerKeys(userId: string, dto: KeyBundleDto) {
    return this.db.transaction(async tx => {
      const devices = (await tx.query('SELECT device_id,identity_key FROM chat.device_keys WHERE user_id=$1 FOR UPDATE', [userId])).rows;
      const current = devices.find(row => row.device_id === dto.deviceId);
      invariant(current || devices.length < 5, 'DEVICE_LIMIT', 'At most five encrypted devices per account');
      // A new identity key invalidates every prekey issued under the old one.
      if (current && current.identity_key !== dto.identityKey) await tx.query('DELETE FROM chat.one_time_prekeys WHERE user_id=$1 AND device_id=$2', [userId, dto.deviceId]);
      await tx.query(`INSERT INTO chat.device_keys(user_id,device_id,registration_id,identity_key,signed_prekey_id,signed_prekey,signed_prekey_signature)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,device_id) DO UPDATE SET registration_id=excluded.registration_id,
        identity_key=excluded.identity_key,signed_prekey_id=excluded.signed_prekey_id,signed_prekey=excluded.signed_prekey,
        signed_prekey_signature=excluded.signed_prekey_signature,updated_at=now()`,
        [userId, dto.deviceId, dto.registrationId, dto.identityKey, dto.signedPreKey.keyId, dto.signedPreKey.publicKey, dto.signedPreKey.signature]);
      for (const prekey of dto.oneTimePreKeys) await tx.query(`INSERT INTO chat.one_time_prekeys(user_id,device_id,key_id,public_key)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [userId, dto.deviceId, prekey.keyId, prekey.publicKey]);
      const excess = (await tx.query('SELECT count(*)::int AS n FROM chat.one_time_prekeys WHERE user_id=$1 AND device_id=$2', [userId, dto.deviceId])).rows[0].n;
      invariant(excess <= 200, 'PREKEY_LIMIT', 'Too many unused one-time prekeys for this device');
      return { deviceId: dto.deviceId, oneTimePreKeys: excess, identityChanged: Boolean(current && current.identity_key !== dto.identityKey) };
    });
  }
  async removeKeys(userId: string, deviceId: string) {
    const result = await this.db.query('DELETE FROM chat.device_keys WHERE user_id=$1 AND device_id=$2', [userId, deviceId]);
    return { removed: Boolean(result.rowCount) };
  }
  /**
   * Returns one prekey bundle per device of the target and consumes a one-time prekey for each.
   * Only people who share a conversation may fetch, which bounds prekey-draining by strangers.
   */
  async keyBundles(userId: string, targetId: string) {
    return this.db.transaction(async tx => {
      if (userId !== targetId) {
        const shared = await tx.query(`SELECT 1 FROM chat.members a JOIN chat.members b ON b.conversation_id=a.conversation_id
          WHERE a.user_id=$1 AND a.status='ACTIVE' AND b.user_id=$2 AND b.status<>'LEFT' LIMIT 1`, [userId, targetId]);
        invariant(shared.rowCount, 'NOT_FOUND', 'No key bundle available', 404);
      }
      const devices = (await tx.query('SELECT * FROM chat.device_keys WHERE user_id=$1 ORDER BY device_id', [targetId])).rows;
      const bundles = [];
      for (const row of devices) {
        const prekey = (await tx.query(`DELETE FROM chat.one_time_prekeys WHERE (user_id,device_id,key_id) IN
          (SELECT user_id,device_id,key_id FROM chat.one_time_prekeys WHERE user_id=$1 AND device_id=$2 ORDER BY key_id LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING key_id,public_key`, [targetId, row.device_id])).rows[0];
        bundles.push({ deviceId: row.device_id, registrationId: row.registration_id, identityKey: row.identity_key,
          signedPreKey: { keyId: row.signed_prekey_id, publicKey: row.signed_prekey, signature: row.signed_prekey_signature },
          // Absent when the device ran out: X3DH then proceeds without the one-time prekey, as the protocol allows.
          oneTimePreKey: prekey ? { keyId: prekey.key_id, publicKey: prekey.public_key } : null });
      }
      return { userId: targetId, devices: bundles };
    });
  }
  /** Describes the protocol the client must run and whether this device still has prekeys on the server. */
  async handshake(userId: string, deviceId?: string) {
    const row = deviceId ? (await this.db.query(`SELECT k.updated_at,(SELECT count(*)::int FROM chat.one_time_prekeys p
      WHERE p.user_id=k.user_id AND p.device_id=k.device_id) AS prekeys FROM chat.device_keys k WHERE k.user_id=$1 AND k.device_id=$2`, [userId, deviceId])).rows[0] : null;
    return { protocol: 'signal', keyAgreement: 'X3DH', ratchet: 'Double Ratchet', curve: 'Curve25519', cipher: 'AES-256-CBC + HMAC-SHA256',
      serverRole: 'public key directory and opaque ciphertext relay; the server cannot decrypt', registered: Boolean(row),
      oneTimePreKeys: row?.prekeys ?? 0, replenishBelow: 10, signedPreKeyUpdatedAt: row?.updated_at ?? null };
  }
}
