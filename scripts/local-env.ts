import { copyFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
async function main() {
  try { await access('.env'); console.log('Existing .env preserved.'); }
  catch { await copyFile('.env.example', '.env', constants.COPYFILE_EXCL); console.log('Created local .env from example. Replace secrets for shared environments.'); }
}
main().catch(() => { console.error('Could not create local configuration.'); process.exitCode = 1; });
