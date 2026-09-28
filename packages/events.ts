import { DbClient } from './database';
export async function emitEvent(tx: DbClient, userId: string, type: string, payload: unknown, requestId?: string) {
  await tx.query('INSERT INTO platform.outbox_events(user_id,type,payload,request_id) VALUES($1,$2,$3,$4)', [userId, type, JSON.stringify(payload), requestId || null]);
}
