// The first admin of a database that has none, given to an account that already signed up in the app, so no password is
// ever made up here. It is the operator-run bootstrap the README describes, for a host without database access
// (Render's free plan): render-start runs it while BOOTSTRAP_ADMIN_IDENTIFIER is set. Later roles go through the admin API.
// Usage: node dist/scripts/bootstrap-admin.js <email or E.164 phone>
import { Pool } from 'pg';
import { normalizeIdentifier } from '../modules/identity/service';

export type BootstrapOutcome = 'granted' | 'admin-exists' | 'no-account';

export async function bootstrapAdmin(pool: Pool, value: string): Promise<BootstrapOutcome> {
  const identifier = normalizeIdentifier(value);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The lock the admin API takes to grant and revoke roles, so the two never race.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['admin-role-changes']);
    const admins = (await client.query(`SELECT count(*)::int AS n FROM identity.roles r JOIN identity.users u ON u.id=r.user_id
      WHERE r.role='admin' AND u.status='ACTIVE'`)).rows[0].n;
    const user = admins ? undefined : (await client.query("SELECT id FROM identity.users WHERE identifier=$1 AND status='ACTIVE'", [identifier])).rows[0];
    if (!user) { await client.query('ROLLBACK'); return admins ? 'admin-exists' : 'no-account'; }
    await client.query("INSERT INTO identity.roles(user_id,role) VALUES($1,'admin')", [user.id]);
    await client.query(`INSERT INTO platform.audit_events(actor_id,action,target_type,target_id,details)
      VALUES(NULL,'admin.bootstrap','user',$1,'{"by":"scripts/bootstrap-admin"}')`, [user.id]);
    await client.query('COMMIT');
    return 'granted';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (require.main === module) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  bootstrapAdmin(pool, process.argv[2] || '')
    .then(outcome => { console.log(JSON.stringify({ event: 'admin.bootstrap', outcome })); return pool.end(); })
    .catch(async error => { console.error(`Admin bootstrap failed: ${error instanceof Error ? error.message : 'unknown error'}`); await pool.end(); process.exitCode = 1; });
}
