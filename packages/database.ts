import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { loadConfig } from './config';

export type DbClient = Pick<PoolClient, 'query'>;
@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: loadConfig().databaseUrl, max: 20, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000, statement_timeout: 15000 });
  constructor() { this.pool.on('error', () => console.error(JSON.stringify({ event: 'database.connection_error' }))); }
  query<T extends QueryResultRow = any>(sql: string, params?: unknown[]) { return this.pool.query<T>(sql, params); }
  async transaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect();
    try { await tx.query('BEGIN'); const result = await work(tx); await tx.query('COMMIT'); return result; }
    catch (error) { await tx.query('ROLLBACK'); throw error; }
    finally { tx.release(); }
  }
  async onModuleDestroy() { await this.pool.end(); }
}
@Global()
@Module({ providers: [Database], exports: [Database] })
export class DatabaseModule {}
