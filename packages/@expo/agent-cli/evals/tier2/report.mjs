import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workflowReport } from './outcome.mjs';

// Run after Vitest even if setup failed. A missing/stale success must never make CI green.
const rawCode = process.argv[2];
const runnerCode = /^\d+$/.test(rawCode ?? '') ? Number(rawCode) : 1;
const directory = fileURLToPath(new URL('../artifacts/tier2', import.meta.url));
await mkdir(directory, { recursive: true });
let outcome;
try {
  outcome = JSON.parse(await readFile(`${directory}/outcome.json`, 'utf8'));
} catch {}
const report = workflowReport(outcome, runnerCode);
await writeFile(`${directory}/workflow-summary.json`, JSON.stringify(report, null, 2) + '\n');
console.log(`${report.result}: ${report.summary}`);
if (process.argv.includes('--eas')) {
  for (const [name, value] of Object.entries({
    result: report.result,
    summary: report.summary.slice(0, 1500),
  })) {
    // Pass data as argv, never shell source (errors can contain untrusted text).
    const result = spawnSync('set-output', [name, value], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`set-output ${name} failed`);
  }
}
process.exitCode = report.exitCode;
