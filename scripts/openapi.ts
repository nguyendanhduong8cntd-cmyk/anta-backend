import { mkdir, writeFile } from 'node:fs/promises';
import { createApplication } from '../apps/api/bootstrap';
import { buildOpenApi } from '../packages/contracts/openapi';
async function main() {
  const app = await createApplication();
  try { await mkdir('docs', { recursive: true }); await writeFile('docs/openapi.json', JSON.stringify(buildOpenApi(app), null, 2) + '\n'); }
  finally { await app.close(); }
}
main().catch(() => { console.error('OpenAPI export failed'); process.exitCode = 1; });
