import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../packages/config';
import { signWebhook } from '../modules/payment/signature';
async function main() {
  const config = loadConfig(), intentId = process.argv[2];
  if (config.production || !/^[a-f0-9-]{36}$/i.test(intentId || '')) throw new Error('Use a local sandbox intent UUID');
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const intent = (await pool.query('SELECT amount,currency FROM payment.intents WHERE id=$1', [intentId])).rows[0];
    if (!intent) throw new Error('Intent not found');
    const raw = Buffer.from(JSON.stringify({ eventId: randomUUID(), intentId, status: 'paid', amount: intent.amount, currency: intent.currency }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(`http://127.0.0.1:${config.port}/api/v1/webhooks/payments/sandbox`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Timestamp': timestamp,
        'X-Webhook-Signature': signWebhook(raw, timestamp, config.webhookSecret) }, body: raw });
    console.log(JSON.stringify({ status: response.status, result: await response.json() }));
    if (!response.ok) process.exitCode = 1;
  } finally { await pool.end(); }
}
main().catch(() => { console.error('Sandbox confirmation failed. Check intent ID and local configuration.'); process.exitCode = 1; });
