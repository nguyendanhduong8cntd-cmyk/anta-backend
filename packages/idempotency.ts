import { Global, Injectable, Module } from '@nestjs/common';
import { PoolClient } from 'pg';
import { Database, DatabaseModule } from './database';
import { digest } from './auth/crypto';
import { invariant } from './contracts/errors';
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const fingerprint = (payload: unknown) => digest(canonical(payload));
@Injectable()
export class Idempotency {
  constructor(private readonly db: Database) {}
  async run<T>(userId: string, scope: string, key: string | undefined, payload: unknown, work: (tx: PoolClient) => Promise<T>): Promise<T> {
    invariant(key && /^[a-zA-Z0-9_.-]{8,128}$/.test(key), 'IDEMPOTENCY_KEY_REQUIRED', 'Provide an Idempotency-Key (8-128 safe characters)', 400);
    const hash = fingerprint(payload);
    return this.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${userId}:${scope}:${key}`]);
      const existing = (await tx.query('SELECT * FROM platform.idempotency WHERE user_id=$1 AND scope=$2 AND key=$3', [userId, scope, key])).rows[0];
      if (existing) {
        invariant(existing.request_hash === hash, 'IDEMPOTENCY_CONFLICT', 'Key has already been used with another payload');
        return existing.response;
      }
      const response = await work(tx);
      await tx.query('INSERT INTO platform.idempotency(user_id,scope,key,request_hash,response) VALUES($1,$2,$3,$4,$5)', [userId, scope, key, hash, JSON.stringify(response)]);
      return response;
    });
  }
}
@Global()
@Module({ imports: [DatabaseModule], providers: [Idempotency], exports: [Idempotency] })
export class IdempotencyModule {}
