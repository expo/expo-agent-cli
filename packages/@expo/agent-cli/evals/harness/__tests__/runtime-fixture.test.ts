// @ref llp/0002-testing-and-evals.plan.md
import fs from 'node:fs';
import { expect, it } from 'vitest';
import { readDevServerLockAsync } from '../../../src/devLock';
import { startRuntimeFixture } from '../runtime-fixture';
import { runProcess } from '../process';
import { cliBin, copyWorkspace as copyFixture } from '../workspace';

// An absolute Node executable and an empty PATH prove these calls need no platform binaries.
function exec(root: string, args: string[]) {
  return runProcess(process.execPath, [cliBin, ...args, '--json'], {
    cwd: root,
    env: { ...process.env, PATH: '', CI: '1', NO_COLOR: '1' },
    signal: AbortSignal.timeout(15_000),
  });
}

it('requires a real reload call, discovers the lock, and releases both listeners', async () => {
  const root = copyFixture('e2e/fixtures/go-app');
  let fixture: Awaited<ReturnType<typeof startRuntimeFixture>> | undefined;
  try {
    fixture = await startRuntimeFixture(root, 'reload');
    expect(fixture.evidence()).toMatchObject({ reloaded: false, reloadCount: 0 });
    const untouched = await exec(root, ['dev:logs']);
    expect(untouched.exitCode, untouched.stderr).toBe(0);
    expect(fixture.evidence()).toMatchObject({ reloaded: false, reloadCount: 0 });
    const lock = await readDevServerLockAsync(root);
    expect(lock).not.toBeNull();
    const before = await (await fetch(`${lock!.url}/json/list`)).json();
    const result = await exec(root, ['runtime:reload']);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reloaded: true,
      method: 'dev-server',
      devServerSource: 'lock',
      bundle: { checked: true, ok: true },
    });
    expect(fixture.evidence()).toMatchObject({ reloaded: true, reloadCount: 1 });
    const after = await (await fetch(`${lock!.url}/json/list`)).json();
    expect(after[0].id).not.toBe(before[0].id);
    await fixture.close();
    await fixture.close();
    expect(await readDevServerLockAsync(root)).toBeNull();
    await expect(
      fetch(`${lock!.url}/status`, { signal: AbortSignal.timeout(1000) })
    ).rejects.toThrow();
    expect(fixture.evidence()).toMatchObject({ reloaded: true, reloadCount: 1 });
  } finally {
    try {
      await fixture?.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}, 25_000);

it('exposes a captured bundler diagnostic and refuses to reload a broken bundle', async () => {
  const root = copyFixture('e2e/fixtures/go-app');
  let fixture: Awaited<ReturnType<typeof startRuntimeFixture>> | undefined;
  try {
    fixture = await startRuntimeFixture(root, 'bundler-error');
    const unavailable = await exec(root, ['runtime:errors']);
    expect(unavailable.exitCode).toBe(1);
    expect(JSON.parse(unavailable.stdout).error.suggestedCommand).toBe(
      'npx @expo/agent-cli dev:logs'
    );
    const logs = await exec(root, ['dev:logs']);
    expect(logs.exitCode, logs.stderr).toBe(0);
    const report = JSON.parse(logs.stdout);
    expect(report.devServer).not.toBeNull();
    expect(report.lines.join('\n')).toContain("Unexpected keyword 'const'. (101:2)");
    expect(report.lines.join('\n')).toContain('src/app/index.tsx');
    const reload = await exec(root, ['runtime:reload']);
    expect(reload.timedOut).toBe(false);
    expect(reload.exitCode, reload.stdout + reload.stderr).toBe(20);
    expect(JSON.parse(reload.stdout)).toMatchObject({
      reloaded: false,
      attempts: [],
      devServerSource: 'lock',
      bundle: { checked: true, ok: false, error: { type: 'TransformError', lineNumber: 101 } },
    });
    expect(fixture.evidence()).toMatchObject({ reloaded: false, reloadCount: 0 });
  } finally {
    try {
      await fixture?.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}, 25_000);
