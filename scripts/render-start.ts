import { spawn, type ChildProcess } from 'node:child_process';
import { Pool } from 'pg';
// Render's free plan gives one process per service and no one-off jobs or background workers, so this one container
// migrates, optionally imports the venues, and runs the worker beside the API. When either stops, the other is stopped
// too: the container exits and Render starts it again, instead of serving with a dead worker.
const node = (script: string, args: string[] = []) => spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
const finished = (child: ChildProcess) => new Promise<void>((resolve, reject) =>
  child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${child.spawnargs[1]} exited with ${code}`)))));
/** A catalog with no venue at all: the first start, or a database that replaced an expired free one. */
async function catalogEmpty() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try { return (await pool.query('SELECT NOT EXISTS (SELECT 1 FROM catalog.branches) AS empty')).rows[0].empty as boolean; }
  finally { await pool.end(); }
}
async function main() {
  await finished(node('dist/scripts/migrate.js'));
  // Only into an empty catalog: re-importing would reset courts and prices edited since.
  const venues = process.env.SEED_VENUES_FILE;
  if (venues && await catalogEmpty()) {
    await finished(node('dist/scripts/seed.js'));
    await finished(node('dist/scripts/import-venues.js', [venues]));
  }
  const children = [node('dist/apps/api/main.js'), node('dist/apps/worker/main.js')];
  let stopping = false;
  for (const child of children) child.on('exit', code => {
    if (!stopping) process.exitCode = code || 1;
    stopping = true;
    for (const other of children) if (other !== child && other.exitCode === null) other.kill('SIGTERM');
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
    stopping = true;
    children.forEach(child => child.kill(signal));
  });
}
if (require.main === module) {
  main().catch(error => { console.error(JSON.stringify({ event: 'render.start_failed', message: String(error.message) })); process.exitCode = 1; });
}
