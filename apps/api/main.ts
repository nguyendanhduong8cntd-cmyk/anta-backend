import { createApplication } from './bootstrap';
import { loadConfig } from '../../packages/config';
async function main() {
  const app = await createApplication();
  await app.listen(loadConfig().port, loadConfig().bindHost);
  console.log(JSON.stringify({ event: 'api.started', port: loadConfig().port }));
}
main().catch(() => { console.error(JSON.stringify({ event: 'api.start_failed', message: 'Check environment and dependency readiness' })); process.exitCode = 1; });
