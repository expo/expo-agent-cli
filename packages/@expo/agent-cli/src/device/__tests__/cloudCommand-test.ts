import { spawnSync } from 'child_process';
import { CLOUD_SESSION_MISMATCH, guardedCloudArgs, guardRefusal } from '../cloudCommand';
vi.unmock('child_process');
vi.unmock('node:child_process');
vi.unmock('fs');
vi.unmock('node:fs');
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
it.each([
  [20, `${CLOUD_SESSION_MISMATCH} sess-2\n`, { loadedId: 'sess-2' }],
  [20, CLOUD_SESSION_MISMATCH, { loadedId: null }],
  [20, `x ${CLOUD_SESSION_MISMATCH}`, null],
  [1, `app said ${CLOUD_SESSION_MISMATCH}`, null],
])('reads a guard refusal from exit %s and stderr %j', (exitCode, stderr, expected) => {
  expect(guardRefusal({ exitCode, stderr })).toEqual(expected);
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
