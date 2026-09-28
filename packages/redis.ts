import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { loadConfig } from './config';
import { ApiError } from './contracts/errors';
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client = new Redis(loadConfig().redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true, keyPrefix: loadConfig().redisKeyPrefix });
  constructor() { this.client.on('error', () => console.error(JSON.stringify({ event: 'redis.connection_error' }))); }
  async rateLimit(key: string, limit: number, windowMs: number) {
    const count = Number(await this.client.eval(
      'local n=redis.call("INCR",KEYS[1]); if n==1 then redis.call("PEXPIRE",KEYS[1],ARGV[1]) end; return n', 1, key, windowMs));
    if (count > limit) throw new ApiError('RATE_LIMITED', 'Too many requests. Try again later.', 429);
  }
  async onModuleDestroy() { this.client.disconnect(); }
}
@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}
