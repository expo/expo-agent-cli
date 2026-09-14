import { expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

it('reports missing credentials as skipped before any installed dependencies are needed', () => {
  const root = mkdtempSync(join(tmpdir(), 'tier2-preflight-test-'));
  const target = join(root, 'evals/tier2');
  mkdirSync(target, { recursive: true });
  try {
    for (const file of ['preflight.mjs', 'settings.mjs', 'report.mjs', 'outcome.mjs'])
      cpSync(resolve(__dirname, '../../tier2', file), join(target, file));
    const env = { AGENT_CLI_TIER2: '1', PATH: process.env.PATH };
    const preflight = spawnSync(process.execPath, [join(target, 'preflight.mjs')], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    expect(preflight.status, preflight.stderr).toBe(0);
    expect(preflight.stdout).toContain('ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is missing');
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
    const output = JSON.parse(
      readFileSync(join(root, 'evals/artifacts/tier2/outcome.json'), 'utf8')
    );
    expect(output.status).toBe('skipped');
    const report = spawnSync(process.execPath, [join(target, 'report.mjs')], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    expect(report.status, report.stderr).toBe(0);
    expect(report.stdout).toContain(
      'skipped: Tier2 skipped: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is missing'
    );
    expect(
      JSON.parse(readFileSync(join(root, 'evals/artifacts/tier2/workflow-summary.json'), 'utf8'))
        .result
    ).toBe('skipped');
    // A later runner failure or missing status must still fail even with a skipped outcome.
    const exitFile = join(root, 'evals/artifacts/tier2/runner-exit-code');
    writeFileSync(exitFile, '1\n');
    const failed = spawnSync(process.execPath, [join(target, 'report.mjs')], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain('error: Vitest/pipeline exited 1');
    rmSync(exitFile);
    const missing = spawnSync(process.execPath, [join(target, 'report.mjs')], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    expect(missing.status).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
