import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { ApiModule } from '../api/module';
import { Database } from '../../packages/database';
import { loadConfig } from '../../packages/config';
import { BookingService } from '../../modules/booking/service';
import { PaymentService } from '../../modules/payment/service';
import { CommerceService } from '../../modules/commerce/service';
import { RefundService } from '../../modules/payment/refunds';
import { IdentityService } from '../../modules/identity/service';
import { dispatchOutbox } from './outbox';
import { deliverNotification } from './notifications';
async function main() {
  const app = await NestFactory.createApplicationContext(ApiModule, { logger: ['warn', 'error'] });
  const config = loadConfig(), db = app.get(Database);
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  connection.on('error', () => console.error(JSON.stringify({ event: 'worker.redis_error' })));
  const queue = new Queue('anta-notifications', { connection });
  const worker = new Worker('anta-notifications', job => deliverNotification(db, job.data.eventId), { connection, concurrency: 5 });
  worker.on('failed', job => console.error(JSON.stringify({ event: 'worker.job_failed', jobId: job?.id })));
  worker.on('error', () => console.error(JSON.stringify({ event: 'worker.queue_error' })));
  let stopping = false, busy = false;
  const tick = async () => {
    if (stopping || busy) return;
    busy = true;
    try { await app.get(BookingService).expireDue(); await app.get(CommerceService).expireDue();
      await app.get(PaymentService).expireDue(); await app.get(RefundService).processPending();
      await app.get(IdentityService).purgeDue(); await dispatchOutbox(db, queue); }
    catch { console.error(JSON.stringify({ event: 'worker.tick_failed' })); }
    finally { busy = false; }
  };
  await tick();
  const timer = setInterval(tick, 5000);
  const stop = async () => { if (stopping) return; stopping = true; clearInterval(timer);
    await worker.close(); await queue.close(); await connection.quit(); await app.close(); };
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  console.log(JSON.stringify({ event: 'worker.started', fcmEnabled: config.fcmEnabled }));
}
main().catch(() => { console.error(JSON.stringify({ event: 'worker.start_failed' })); process.exitCode = 1; });
