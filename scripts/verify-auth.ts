import 'dotenv/config';
import { getConfig } from '../src/config.js';
import { runStartupProbe } from '../src/okta/auth.js';
import { getOrgState } from '../src/okta/auth.js';

async function main() {
  try {
    getConfig();
  } catch (err) {
    process.stderr.write(`Config error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  await runStartupProbe();

  const state = getOrgState();
  process.stdout.write(JSON.stringify({ ok: true, ...state }, null, 2) + '\n');
  process.exit(0);
}

main();
