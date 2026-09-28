import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { Database } from '../../packages/database';
import { loadConfig } from '../../packages/config';
export async function deliverNotification(db: Database, eventId: string) {
  const event = (await db.query('SELECT * FROM platform.outbox_events WHERE id=$1', [eventId])).rows[0];
  if (!event) return;
  const row = (await db.query(`INSERT INTO notification.notifications(user_id,event_id,type,payload) VALUES($1,$2,$3,$4)
    ON CONFLICT(event_id) DO UPDATE SET event_id=excluded.event_id RETURNING *`, [event.user_id, event.id, event.type, event.payload])).rows[0];
  const config = loadConfig();
  if (row.delivered_at || !config.fcmEnabled) return;
  const preference = (await db.query('SELECT push_enabled FROM notification.preferences WHERE user_id=$1', [event.user_id])).rows[0];
  if (preference?.push_enabled === false) return;
  const devices = (await db.query('SELECT fcm_token FROM identity.devices WHERE user_id=$1', [event.user_id])).rows;
  if (!devices.length) return;
  if (!getApps().length) initializeApp({ credential: applicationDefault() });
  // FCM is at-least-once if a crash occurs after sending. Android deduplicates on eventId.
  for (let offset = 0; offset < devices.length; offset += 500) {
    const batch = devices.slice(offset, offset + 500);
    const result = await getMessaging().sendEachForMulticast({ tokens: batch.map(d => d.fcm_token),
      data: { eventId: String(event.id), type: event.type, payload: JSON.stringify(event.payload) } });
    let retry = false;
    for (let i = 0; i < result.responses.length; i++) {
      const response = result.responses[i];
      if (!response.success) {
        if (['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'].includes(response.error?.code || ''))
          await db.query('DELETE FROM identity.devices WHERE user_id=$1 AND fcm_token=$2', [event.user_id, batch[i].fcm_token]);
        else retry = true;
      }
    }
    if (retry) throw new Error('FCM delivery requires retry');
  }
  await db.query('UPDATE notification.notifications SET delivered_at=now() WHERE id=$1', [row.id]);
}
