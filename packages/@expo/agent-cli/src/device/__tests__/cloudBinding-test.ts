import { spawnSync } from 'child_process';
import { guardedCloudArgs } from '../cloudCommand';
import { selectCloudSession, buildSessionListArgs, type CloudSessionInfo } from '../cloudSimulator';
vi.unmock('child_process');
vi.unmock('node:child_process');
const session = (
  id: string,
  platform: 'ios' | 'android' = 'ios',
  status = 'IN_PROGRESS'
): CloudSessionInfo => ({
  id,
  platform,
  status,
  type: 'agent-device',
  name: id,
  createdAt: '2026-10-08T10:00:00Z',
});
it('selects no unbound session even when it is the only active one', () => {
  expect(selectCloudSession([session('foreign')])).toMatchObject({
    selected: null,
    candidates: [],
    unbound: [{ id: 'foreign' }],
  });
});
it('the requested platform binding beats the other platform dotenv', () => {
  expect(
    selectCloudSession([session('ios'), session('android', 'android')], {
      platform: 'ios',
      boundIds: ['ios', 'android'],
      preferredId: 'android',
    })
  ).toMatchObject({ selected: { id: 'ios' }, source: 'bound' });
});
it('a queued own session wins over an active dotenv session', () => {
  expect(
    selectCloudSession([session('queued', 'ios', 'NEW'), session('dotenv')], {
      boundIds: ['queued'],
      preferredId: 'dotenv',
    })
  ).toMatchObject({ selected: { id: 'queued', status: 'NEW' } });
  expect(buildSessionListArgs().filter((arg) => ['new', 'in-progress'].includes(arg))).toEqual([
    'in-progress',
    'new',
  ]);
});
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
