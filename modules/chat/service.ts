import { Injectable } from '@nestjs/common';
import { Database, DbClient } from '../../packages/database';
import { Idempotency } from '../../packages/idempotency';
import { ApiError, invariant } from '../../packages/contracts/errors';
import { emitEvent } from '../../packages/events';
import { ConversationDto } from './dto';

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
      const row = (await tx.query('INSERT INTO chat.conversations(title,created_by,kind) VALUES($1,$2,$3) RETURNING *',
        [dto.title.trim(), userId, invitees.length === 1 ? 'DIRECT' : 'GROUP'])).rows[0];
      await tx.query("INSERT INTO chat.members(conversation_id,user_id,role,status) VALUES($1,$2,'OWNER','ACTIVE')", [row.id, userId]);
      for (const invitee of invitees) {
        await tx.query("INSERT INTO chat.members(conversation_id,user_id,role,status) VALUES($1,$2,'MEMBER','INVITED')", [row.id, invitee]);
        await emitEvent(tx, invitee, 'chat.invited', { conversationId: row.id, title: row.title });
      }
      return row;
    });
  }
  async list(userId: string) {
    return (await this.db.query(`SELECT c.id,c.title,c.kind,c.created_at,c.updated_at,m.role,m.status,m.last_read_seq,
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
  async messages(userId: string, conversationId: string, after: string) {
    invariant(/^\d{1,18}$/.test(after), 'INVALID_CURSOR', 'Invalid message cursor', 400);
    await this.member(this.db.pool, userId, conversationId);
    return (await this.db.query(`SELECT id,conversation_id,seq,sender_id,
      CASE WHEN deleted_at IS NULL THEN body ELSE NULL END AS body,deleted_at,created_at
      FROM chat.messages WHERE conversation_id=$1 AND seq>$2 ORDER BY seq LIMIT 100`, [conversationId, after])).rows;
  }
  async send(userId: string, conversationId: string, body: string, key: string | undefined, requestId?: string) {
    invariant(typeof body === 'string' && body.trim().length > 0 && body.length <= 4000,
      'VALIDATION_FAILED', 'Message must have 1-4000 characters', 400);
    return this.idem.run(userId, `chat-message:${conversationId}`, key, { body }, async tx => {
      const conversation = (await tx.query('SELECT * FROM chat.conversations WHERE id=$1 FOR UPDATE', [conversationId])).rows[0];
      invariant(conversation, 'NOT_FOUND', 'Conversation not found', 404);
      await this.member(tx, userId, conversationId);
      const seq = conversation.next_seq;
      await tx.query('UPDATE chat.conversations SET next_seq=next_seq+1,updated_at=now() WHERE id=$1', [conversationId]);
      const row = (await tx.query(`INSERT INTO chat.messages(conversation_id,seq,sender_id,body)
        VALUES($1,$2,$3,$4) RETURNING id,conversation_id,seq,sender_id,body,created_at`, [conversationId, seq, userId, body])).rows[0];
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
  handshake(): never { throw new ApiError('CRYPTO_NOT_CONFIGURED', 'End-to-end encryption is not implemented; no custom cryptography is offered', 503); }
}
