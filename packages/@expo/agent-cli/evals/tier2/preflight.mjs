// Node builtins only: this must run before any workspace, Claude or browser installation.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prerequisiteReason } from './settings.mjs';
const directory = fileURLToPath(new URL('../artifacts/tier2', import.meta.url));
await mkdir(directory, { recursive: true });
const reason = prerequisiteReason();
const output = reason
  ? { status: 'skipped', reason, checks: [] }
  : { status: 'error', reason: 'Tier2 enabled but setup or eval has not completed', checks: [] };
await writeFile(`${directory}/outcome.json`, JSON.stringify(output, null, 2) + '\n');
await writeFile(
  `${directory}/preflight.json`,
  JSON.stringify({ enabled: !reason, reason }, null, 2) + '\n'
);
await writeFile(`${directory}/runner-exit-code`, reason ? '0\n' : '1\n');
console.log(reason ?? 'Tier2 prerequisites present; setup may proceed');
if (process.argv.includes('--eas')) {
  for (const [name, value] of Object.entries({
    enabled: String(!reason),
    code: reason ? '0' : '1',
  })) {
    const result = spawnSync('set-output', [name, value], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`set-output ${name} failed`);
  }
}
