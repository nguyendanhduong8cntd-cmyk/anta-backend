import { createHmac } from 'node:crypto';
import { secureEqual } from '../../packages/auth/crypto';
import { invariant } from '../../packages/contracts/errors';
export function signWebhook(raw: Buffer, timestamp: string, secret: string) {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
}
export function verifyWebhook(raw: Buffer | undefined, timestamp: string | undefined, signature: string | undefined, secret: string, now = Date.now()) {
  invariant(raw && timestamp && signature && /^\d{10}$/.test(timestamp) && /^[a-f0-9]{64}$/.test(signature),
    'INVALID_WEBHOOK_SIGNATURE', 'Valid signature and timestamp required', 401);
  invariant(Math.abs(now - Number(timestamp) * 1000) <= 300000 && secureEqual(signWebhook(raw, timestamp, secret), signature),
    'INVALID_WEBHOOK_SIGNATURE', 'Invalid signature or expired timestamp', 401);
}
