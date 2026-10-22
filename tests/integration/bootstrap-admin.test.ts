import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../../scripts/migrate';
import { bootstrapAdmin } from '../../scripts/bootstrap-admin';

// A database of its own: the shared test database already holds admins made by the other tests.
const shared = new URL(process.env.TEST_DATABASE_URL || 'postgresql://anta:anta_local@127.0.0.1:55432/anta_test');
assert.match(shared.pathname, /_test$/);
const name = `anta_test_bootstrap_${randomUUID().slice(0, 8)}`;
const own = new URL(shared); own.pathname = `/${name}`;
let server: Pool, pool: Pool;

const account = async (identifier: string, status = 'ACTIVE') => (await pool.query(
  `INSERT INTO identity.users(identifier,display_name,password_hash,status) VALUES($1,'Quản trị Anta','not-a-real-hash',$2) RETURNING id`,
  [identifier, status])).rows[0].id as string;
const admins = async () => (await pool.query(`SELECT u.identifier FROM identity.roles r JOIN identity.users u ON u.id=r.user_id
  WHERE r.role='admin' ORDER BY 1`)).rows.map(row => row.identifier);

before(async () => {
  server = new Pool({ connectionString: shared.toString() });
  await server.query(`CREATE DATABASE ${name}`);
  pool = new Pool({ connectionString: own.toString() });
  await migrate(pool);
});
after(async () => {
  await pool?.end();
  await server.query(`DROP DATABASE IF EXISTS ${name}`);
  await server.end();
});

test('the first admin goes to an active account that signed up, and only while there is no admin', async () => {
  assert.equal(await bootstrapAdmin(pool, '+84900000000'), 'no-account');
  await account('+84900000009', 'DISABLED');
  assert.equal(await bootstrapAdmin(pool, '+84900000009'), 'no-account');
  const first = await account('+84900000000');
  assert.equal(await bootstrapAdmin(pool, ' +84900000000 '), 'granted');
  assert.deepEqual(await admins(), ['+84900000000']);
  assert.deepEqual((await pool.query("SELECT actor_id, target_id FROM platform.audit_events WHERE action='admin.bootstrap'")).rows,
    [{ actor_id: null, target_id: first }]);
  await account('someone@example.com');
  assert.equal(await bootstrapAdmin(pool, 'Someone@Example.com'), 'admin-exists');
  assert.equal(await bootstrapAdmin(pool, '+84900000000'), 'admin-exists');
  assert.deepEqual(await admins(), ['+84900000000']);
  await assert.rejects(bootstrapAdmin(pool, 'not an identifier'));
});
