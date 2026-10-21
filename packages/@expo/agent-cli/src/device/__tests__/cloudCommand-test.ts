import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CLOUD_SESSION_MISMATCH,
  guardedCloudArgs,
  guardRefusal,
  unwrapGuardedExec,
} from '../cloudCommand';
import { resolveSpawnTarget } from '../../utils/windowsShim';
vi.unmock('child_process');
vi.unmock('node:child_process');
vi.unmock('fs');
vi.unmock('node:fs');
it('refuses a mismatched connection before launching the controller', () => {
  const args = guardedCloudArgs(
    ['simulator:exec', process.execPath, '-e', 'console.log("DEVICE_WAS_TOUCHED")'],
    'A'
  );
  const result = spawnSync(args[1]!, args.slice(2), {
    encoding: 'utf8',
    env: { ...process.env, EAS_SIMULATOR_SESSION_ID: 'B' },
  });
  expect(result.status).toBe(20);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(new RegExp(`^${CLOUD_SESSION_MISMATCH} B$`, 'm'));
});
it('refuses a connection that names no session, and reports no loaded id', () => {
  const args = guardedCloudArgs(
    ['simulator:exec', process.execPath, '-e', 'console.log("DEVICE_WAS_TOUCHED")'],
    'A'
  );
  const env = { ...process.env };
  delete env.EAS_SIMULATOR_SESSION_ID;
  const result = spawnSync(args[1]!, args.slice(2), { encoding: 'utf8', env });
  expect(result.status).toBe(20);
  expect(result.stdout).toBe('');
  expect(guardRefusal({ exitCode: result.status, stderr: result.stderr })).toEqual({
    loadedId: null,
  });
});
it('passes the loaded connection environment to the controller', () => {
  const args = guardedCloudArgs(
    [
      'simulator:exec',
      process.execPath,
      '-e',
      'console.log(process.env.EAS_SIMULATOR_SESSION_ID + ":" + process.env.AGENT_DEVICE_DAEMON_BASE_URL)',
    ],
    'A'
  );
  const result = spawnSync(args[1]!, args.slice(2), {
    encoding: 'utf8',
    env: {
      ...process.env,
      EAS_SIMULATOR_SESSION_ID: 'A',
      AGENT_DEVICE_DAEMON_BASE_URL: 'fixture-A',
    },
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('A:fixture-A');
});

// e2e/stubs/eas.js cannot import this package, so it keeps a plain-JS copy of the unwrap rule.
// Both must treat the same argv the same way.
describe('the stub eas and unwrapGuardedExec agree on what a guarded argv is', () => {
  const stub = path.resolve(__dirname, '../../../e2e/stubs/eas.js');
  const runStub = (argv: string[]) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pin-'));
    fs.writeFileSync(path.join(cwd, '.env.eas-simulator'), 'EAS_SIMULATOR_SESSION_ID=B\n');
    try {
      return spawnSync(process.execPath, [stub, ...argv], { cwd, encoding: 'utf8' });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  };

  it('treats a guarded argv as guarded in both', () => {
    const argv = guardedCloudArgs(
      ['simulator:exec', 'npx', 'agent-device@latest', 'open', 'x'],
      'A'
    );
    expect(unwrapGuardedExec(argv)).toEqual(
      resolveSpawnTarget('npx', ['agent-device@latest', 'open', 'x'])
    );
    expect(unwrapGuardedExec(['eas-cli', ...argv])).not.toBeNull();
    expect(runStub(argv).status).toBe(20);
  });

  it('treats a plain simulator:exec argv as unguarded in both', () => {
    const argv = ['simulator:exec', 'npx', 'agent-device@latest', 'open', 'x'];
    expect(unwrapGuardedExec(argv)).toBeNull();
    expect(runStub(argv).status).not.toBe(20);
  });
});
