// @ref llp/0034-eas-session-binding.plan.md §PR 5
import fs from 'node:fs';
import path from 'node:path';
import { digestForRoot } from '../../src/deviceBinding/registry';
import type { Binding } from '../../src/deviceBinding/types';
import {
  installStubEasAsync,
  readStubEasInvocations,
  stubEasArgs,
  writeCloudSessionFileAsync,
} from '../stubEas';
import {
  executeAgentCliAsync,
  getTemporaryPath,
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
async function project() {
  const root = fs.realpathSync(await setupFixtureAsync('go-app'));
  await installStubEasAsync(root);
  projects.push(root);
  return root;
}
function bindingFile(root: string, platform = 'ios') {
  return path.join(
    expoHome,
    'agent-cli',
    'bindings',
    `${digestForRoot(root)}-${platform}-cloud.json`
  );
}
function readBinding(root: string, platform = 'ios'): Binding {
  return JSON.parse(fs.readFileSync(bindingFile(root, platform), 'utf8'));
}
function bind(root: string, id: string, platform: 'ios' | 'android' = 'ios') {
  const file = bindingFile(root, platform);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      projectRoot: root,
      device: { backend: 'cloud', platform, id, origin: 'started' },
      boundAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    })
  );
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
it('two worktrees start and drive their own sessions; plain stop keeps a binding and EAS stop removes it', async () => {
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
  // With Metro still running, replace an ended session through the same detach command.
  const sessions = JSON.parse(fs.readFileSync(path.join(machine, 'sessions.json'), 'utf8'));
  fs.writeFileSync(
    path.join(machine, 'sessions.json'),
    JSON.stringify(
      sessions.map((session: { id: string }) =>
        session.id === 'own-1' ? { ...session, status: 'STOPPED' } : session
      )
    )
  );
  const reopened = await executeAgentCliAsync(
    second,
    ['dev', '--ios', '--eas', '--detach', '--json'],
    { env: { ...envFor(second), STUB_SIM_START_ID: 'replacement-1' }, reject: false }
  );
  expect(reopened.exitCode, reopened.stderr).toBe(0);
  expect(readBinding(second).device).toMatchObject({ id: 'replacement-1' });
  const kept = await executeAgentCliAsync(first, ['dev:stop', '--json'], { env: envFor(first) });
  expect(JSON.parse(kept.stdout).devices).toContainEqual(
    expect.objectContaining({
      id: 'own-0',
      released: false,
      reason: expect.stringContaining('recorded, not checked'),
    })
  );
  expect(fs.existsSync(bindingFile(first))).toBe(true);
  await executeAgentCliAsync(first, ['dev:stop', '--eas', '--json'], { env: envFor(first) });
  expect(fs.existsSync(bindingFile(first))).toBe(false);
  expect(readBinding(second).device).toMatchObject({ id: 'replacement-1' });
});
it('requested iOS binding wins over Android dotenv and refuses to drive that different connection', async () => {
  const root = await project();
  bind(root, 'ios-A');
  bind(root, 'android-B', 'android');
  list([{ id: 'ios-A' }, { id: 'android-B', platform: 'ANDROID' }]);
  await writeCloudSessionFileAsync(root, 'android-B');
  const refused = await navigate(root, ['--ios']);
  expect(refused.exitCode).not.toBe(0);
  expect(JSON.parse(refused.stdout).error.code).toBe('CLOUD_SESSION_MISMATCH');
  expect(readStubEasInvocations(root).filter((i) => i.executedSessionId)).toEqual([]);
  await writeCloudSessionFileAsync(root, 'ios-A');
  expect((await navigate(root, ['--ios'])).exitCode).toBe(0);
  expect(
    readStubEasInvocations(root)
      .filter((i) => i.executedSessionId)
      .map((i) => i.executedSessionId)
  ).toEqual(['ios-A']);
});
it.each(['NEW', 'STOPPED'])(
  'a %s bound session refuses without rewriting its binding',
  async (status) => {
    const root = await project();
    bind(root, 'A');
    list([{ id: 'A', status }, { id: 'foreign' }]);
    await writeCloudSessionFileAsync(root, 'A');
    const before = fs.readFileSync(bindingFile(root), 'utf8');
    const result = await navigate(root, ['--ios']);
    expect(result.exitCode, result.stderr + result.stdout).toBe(20);
    expect(JSON.parse(result.stdout).error.code).toBe('NO_BOUND_DEVICE');
    expect(fs.readFileSync(bindingFile(root), 'utf8')).toBe(before);
    expect(stubEasArgs(root).map((a) => a[0])).toEqual(['simulator:list']);
  }
);
it('an explicit stop failure keeps the binding for retry', async () => {
  const root = await project();
  bind(root, 'A');
  list([{ id: 'A' }]);
  const result = await executeAgentCliAsync(root, ['dev:stop', '--eas', '--json'], {
    env: { ...envFor(root), STUB_SIM_STOP_EXIT: '1' },
    reject: false,
  });
  expect(result.exitCode).not.toBe(0);
  expect(readBinding(root).device).toMatchObject({ id: 'A' });
});
