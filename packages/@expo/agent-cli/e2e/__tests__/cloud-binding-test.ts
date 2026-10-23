// @ref llp/0035-one-device-per-worktree.rfc.md §EAS session binding
import fs from 'node:fs';
import path from 'node:path';
import { CLOUD_SESSION_MISMATCH, guardedCloudArgs } from '../../src/device/cloudCommand';
import type { Binding } from '../../src/deviceBinding/types';
import { easCliArgs, resolveEasCli } from '../../src/utils/easCli';
import { spawnSubprocessAsync } from '../../src/utils/subprocess';
import {
  cloudBindingFile,
  installStubEasAsync,
  readStubEasInvocations,
  stubEasArgs,
  writeCloudBindingAsync,
  writeCloudSessionFileAsync,
} from '../stubEas';
import {
  executeAgentCliAsync,
  getTemporaryPath,
  installStubFingerprintAsync,
  setupFixtureAsync,
  stubExpoEnv,
  waitForAsync,
} from '../utils';

let machine: string;
let expoHome: string;
const projects: string[] = [];
beforeEach(async () => {
  machine = getTemporaryPath();
  expoHome = path.join(machine, 'expo-home');
  fs.mkdirSync(expoHome, { recursive: true });
});
afterEach(async () => {
  for (const root of projects.splice(0)) {
    await executeAgentCliAsync(root, ['dev:stop', '--eas', '--json'], {
      env: envFor(root),
      reject: false,
    });
  }
});
function envFor(root: string) {
  return {
    ...stubExpoEnv(root),
    AGENT_CLI_NO_DEVICE: '0',
    __UNSAFE_EXPO_HOME_DIRECTORY: expoHome,
    STUB_SIM_STORE: path.join(machine, 'sessions.json'),
    STUB_SIM_SESSIONS: '0',
  };
}
async function project(fixture = 'go-app') {
  const root = fs.realpathSync(await setupFixtureAsync(fixture));
  await installStubFingerprintAsync(root);
  await installStubEasAsync(root);
  projects.push(root);
  return root;
}
function bindingFile(root: string, platform = 'ios') {
  return cloudBindingFile(expoHome, root, platform);
}
function readBinding(root: string, platform = 'ios'): Binding {
  return JSON.parse(fs.readFileSync(bindingFile(root, platform), 'utf8'));
}
function list(sessions: { id: string; platform?: string; status?: string }[]) {
  fs.writeFileSync(
    path.join(machine, 'sessions.json'),
    JSON.stringify(
      sessions.map((s) => ({
        type: 'agent-device',
        platform: 'IOS',
        status: 'IN_PROGRESS',
        createdAt: new Date().toISOString(),
        ...s,
      }))
    )
  );
}
function navigate(root: string, args: string[] = []) {
  return executeAgentCliAsync(
    root,
    ['navigate', '/notes', '--eas', '--scheme', 'myapp', '--no-wait-attach', '--json', ...args],
    { env: envFor(root), reject: false }
  );
}
it('two worktrees start and drive their own sessions; EAS stop removes only its own binding', async () => {
  const first = await project();
  const second = await project();
  for (const [index, root] of [first, second].entries()) {
    const result = await executeAgentCliAsync(
      root,
      ['dev', '--ios', '--eas', '--detach', '--wait-ready', '--json'],
      {
        env: {
          ...envFor(root),
          STUB_SIM_START_ID: `own-${index}`,
          STUB_EXPO_DEV_SERVER_PORT: String(8751 + index),
          STUB_EXPO_LISTEN: '1',
          STUB_EXPO_DELAY_MS: '90000',
          STUB_EXPO_TUNNEL_HOST: 'cloud.tunnel.example',
          STUB_EXPO_TUNNEL_DELAY_MS: '100',
        },
        reject: false,
      }
    );
    expect(result.exitCode, result.stderr).toBe(0);
    await waitForAsync(() => fs.existsSync(bindingFile(root)), 15000);
    expect(readBinding(root).device).toMatchObject({ id: `own-${index}`, origin: 'started' });
    const opened = await navigate(root);
    expect(opened.exitCode, opened.stderr).toBe(0);
    expect(JSON.parse(opened.stdout).deviceId).toBe(`own-${index}`);
    expect(
      readStubEasInvocations(root)
        .filter((i) => i.executedSessionId)
        .every((i) => i.executedSessionId === `own-${index}`)
    ).toBe(true);
  }
  expect(stubEasArgs(second).filter((args) => args[0] === 'simulator')).toHaveLength(1);
  const beforeStatus = stubEasArgs(first).length;
  const status = await executeAgentCliAsync(first, ['status', '--json'], { env: envFor(first) });
  expect(JSON.parse(status.stdout).binding).toContainEqual(
    expect.objectContaining({ id: 'own-0', state: 'recorded' })
  );
  expect(stubEasArgs(first)).toHaveLength(beforeStatus);
  await executeAgentCliAsync(first, ['dev:stop', '--eas', '--json'], { env: envFor(first) });
  expect(fs.existsSync(bindingFile(first))).toBe(false);
  expect(readBinding(second).device).toMatchObject({ id: 'own-1' });
});
it('an expired binding only permits a fresh dotenv session', async () => {
  const root = await project();
  await writeCloudBindingAsync(expoHome, root, { id: 'A' });
  const expired = { ...readBinding(root), expiresAt: '2000-01-01T00:00:00.000Z' };
  const before = JSON.stringify(expired);
  fs.writeFileSync(bindingFile(root), before);
  list([{ id: 'A' }, { id: 'B' }]);
  await writeCloudSessionFileAsync(root, 'B');
  const result = await navigate(root, ['--ios']);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).deviceId).toBe('B');
  expect(
    readStubEasInvocations(root)
      .filter((i) => i.executedSessionId)
      .map((i) => i.executedSessionId)
  ).toEqual(['B']);
  expect(fs.readFileSync(bindingFile(root), 'utf8')).toBe(before);
});
it('round-trips guarded cloud target argv and refuses before running on a session mismatch', async () => {
  const root = await project();
  const sessionId = 'argv-session';
  await writeCloudSessionFileAsync(root, sessionId);
  const env = envFor(root);
  const easCli = resolveEasCli(root, { env });
  expect(easCli).not.toBeNull();

  const targetArgs = [
    'space value',
    'double"quote',
    'caret^value',
    '%PATH% value',
    'ampersand&value',
    'Unicode café 雪',
    'two\nlines',
  ];
  const target = [
    process.execPath,
    '-e',
    'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
    ...targetArgs,
  ];
  const runGuarded = (expectedSessionId: string) =>
    spawnSubprocessAsync(
      easCli!.command,
      easCliArgs(easCli!, guardedCloudArgs(['simulator:exec', ...target], expectedSessionId)),
      { cwd: root, env }
    );

  const accepted = await runGuarded(sessionId);
  expect(accepted.exitCode, accepted.stderr).toBe(0);
  expect(JSON.parse(accepted.stdout)).toEqual(targetArgs);

  const refused = await runGuarded('another-session');
  expect(refused.exitCode).toBe(20);
  expect(refused.stderr).toContain(`${CLOUD_SESSION_MISMATCH} ${sessionId}`);
  expect(refused.stdout).toBe('');
});
// A STOPPED session is no longer listed as usable, so the probe asks for availability before it
// calls the session ended. Both calls are reads.
it.each([
  ['NEW', ['simulator:list']],
  ['STOPPED', ['simulator:list', 'simulator:availability']],
])('a %s bound session refuses without rewriting its binding', async (status, easCalls) => {
  const root = await project();
  await writeCloudBindingAsync(expoHome, root, { id: 'A' });
  list([{ id: 'A', status }, { id: 'foreign' }]);
  await writeCloudSessionFileAsync(root, 'A');
  const before = fs.readFileSync(bindingFile(root), 'utf8');
  const result = await navigate(root, ['--ios']);
  expect(result.exitCode, result.stderr + result.stdout).toBe(20);
  expect(JSON.parse(result.stdout).error.code).toBe('NO_BOUND_DEVICE');
  expect(fs.readFileSync(bindingFile(root), 'utf8')).toBe(before);
  expect(stubEasArgs(root).map((a) => a[0])).toEqual(easCalls);
});
