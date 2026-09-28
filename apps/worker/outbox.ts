import { Queue } from 'bullmq';
import { Database } from '../../packages/database';
export async function dispatchOutbox(db: Database, queue: Queue) {
  return db.transaction(async tx => {
    const rows = (await tx.query('SELECT * FROM platform.outbox_events WHERE queued_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED')).rows;
    for (const row of rows) {
      // DB remains source of truth. A crash before COMMIT replays the same durable job id.
      await queue.add('notify', { eventId: row.id, requestId: row.request_id }, { jobId: `outbox-${row.id}`, attempts: 8,
        backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { age: 86400 }, removeOnFail: false });
      await tx.query('UPDATE platform.outbox_events SET queued_at=now() WHERE id=$1', [row.id]);
    }
    return rows.length;
  });
}
