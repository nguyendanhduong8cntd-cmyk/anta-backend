import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
export async function migrate(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('alobo-migrations',0))");
    await client.query('CREATE TABLE IF NOT EXISTS public.schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of (await readdir(resolve('migrations'))).filter(f => /^\d+.*\.sql$/.test(f)).sort()) {
      const sql = await readFile(resolve('migrations', name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = (await client.query('SELECT checksum FROM public.schema_migrations WHERE name=$1', [name])).rows[0];
      if (existing) { if (existing.checksum !== checksum) throw new Error(`Migration changed after applying: ${name}`); continue; }
      await client.query('BEGIN');
      try { await client.query(sql); await client.query('INSERT INTO public.schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum]); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      console.log(JSON.stringify({ event: 'migration.applied', name }));
    }
  } finally { await client.query("SELECT pg_advisory_unlock(hashtextextended('alobo-migrations',0))"); client.release(); }
}
if (require.main === module) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  migrate(pool).then(() => pool.end()).catch(async () => { console.error('Migration failed; check database configuration and migration checksums.'); await pool.end(); process.exitCode = 1; });
}
