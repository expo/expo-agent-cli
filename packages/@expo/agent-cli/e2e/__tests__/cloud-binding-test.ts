// @ref llp/0035-one-device-per-worktree.rfc.md §EAS session binding
import fs from 'node:fs';
import path from 'node:path';
import { guardedCloudArgs } from '../../src/device/cloudCommand';
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
  readStubExpoInvocations,
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
  const kept = await executeAgentCliAsync(first, ['dev:stop', '--json'], { env: envFor(first) });
  expect(JSON.parse(kept.stdout).devices).toContainEqual(
    expect.objectContaining({
      id: 'own-0',
      released: null,
      reason: expect.stringContaining('recorded, not checked'),
    })
  );
  expect(fs.existsSync(bindingFile(first))).toBe(true);
  await executeAgentCliAsync(first, ['dev:stop', '--eas', '--json'], { env: envFor(first) });
  expect(fs.existsSync(bindingFile(first))).toBe(false);
  expect(readBinding(second).device).toMatchObject({ id: 'own-1' });
});
it.each(['ios', 'android'] as const)(
  'reconnects the preserved %s development-client session after Metro changes its tunnel',
  async (platform) => {
    const root = await project('dev-client-fresh-app');
    const configPath = path.join(root, 'app.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.expo.scheme = 'myapp';
    fs.writeFileSync(configPath, JSON.stringify(config));
    await writeCloudBindingAsync(expoHome, root, { id: 'preserved-session', platform });
    list([{ id: 'preserved-session', platform: platform.toUpperCase() }]);
    await writeCloudSessionFileAsync(root, 'preserved-session');
    const env = {
      ...envFor(root),
      STUB_SIM_START_ID: 'preserved-session',
      STUB_EXPO_DEV_SERVER_PORT: platform === 'ios' ? '8754' : '8755',
      STUB_EXPO_LISTEN: '1',
      STUB_EXPO_DELAY_MS: '90000',
      STUB_EXPO_TUNNEL_DELAY_MS: '100',
      STUB_EAS_BUILDS: JSON.stringify([
        {
          id: 'matching-build',
          platform: platform.toUpperCase(),
          status: 'FINISHED',
          fingerprintHash: '0f1e2d3c4b5a69788796a5b4c3d2e1f001234567',
          buildProfile: 'development-simulator',
        },
      ]),
    };
    const devArgs = [
      'dev',
      `--${platform}`,
      '--eas',
      '--dev-client',
      '--detach',
      '--wait-ready',
      '--json',
    ];
    const initial = await executeAgentCliAsync(root, devArgs, {
      env: { ...env, STUB_EXPO_TUNNEL_HOST: 'old.tunnel.example' },
      reject: false,
    });
    expect(initial.exitCode, initial.stderr).toBe(0);
    await waitForAsync(() => readStubEasInvocations(root).some((i) => i.executedSessionId), 15000);
    const initialOpens = readStubEasInvocations(root).filter((i) => i.executedSessionId);
    expect(initialOpens).toHaveLength(1);
    expect(initialOpens[0]!.args).toContain(
      'myapp://?__expo_url=https%3A%2F%2Fold.tunnel.example&__expo_disable_onboarding=1&__expo_disable_fab=1&__expo_disable_auto_launch=1'
    );
    const originalBinding = readBinding(root, platform);
    const stopped = await executeAgentCliAsync(root, ['dev:stop', '--json'], { env });
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    expect(readBinding(root, platform).device).toMatchObject({ id: 'preserved-session' });
    expect(JSON.parse(stopped.stdout).followups.map((f: { id: string }) => f.id)).toContain(
      'stop-session'
    );

    const restarted = await executeAgentCliAsync(root, devArgs, {
      env: { ...env, STUB_EXPO_TUNNEL_HOST: 'new.tunnel.example' },
      reject: false,
    });
    expect(restarted.exitCode, restarted.stderr).toBe(0);
    expect(JSON.parse(restarted.stdout).followups.at(-1).command).toContain('dev:stop --eas');
    await waitForAsync(
      () => readStubEasInvocations(root).filter((i) => i.executedSessionId).length === 2,
      15000
    );
    const opens = readStubEasInvocations(root).filter((i) => i.executedSessionId);
    expect(opens).toHaveLength(2);
    expect(opens.every((i) => i.executedSessionId === 'preserved-session')).toBe(true);
    expect(opens[1]!.args).toEqual([
      '__controller',
      'open',
      'myapp://?__expo_url=https%3A%2F%2Fnew.tunnel.example&__expo_disable_onboarding=1&__expo_disable_fab=1&__expo_disable_auto_launch=1',
      '--platform',
      platform,
    ]);
    expect(stubEasArgs(root).filter((args) => args[0] === 'simulator')).toHaveLength(0);
    expect(readBinding(root, platform)).toMatchObject({
      device: originalBinding.device,
      boundAt: originalBinding.boundAt,
    });
  }
);

it('reopens an ended session using the matching EAS build when the native project is fresh', async () => {
  const root = await project('dev-client-fresh-app');
  const started = await executeAgentCliAsync(
    root,
    ['dev', '--ios', '--eas', '--no-open', '--detach', '--wait-ready', '--json'],
    {
      env: {
        ...envFor(root),
        STUB_EXPO_DEV_SERVER_PORT: '8753',
        STUB_EXPO_LISTEN: '1',
        STUB_EXPO_DELAY_MS: '90000',
        STUB_EXPO_TUNNEL_HOST: 'cloud.tunnel.example',
        STUB_EXPO_TUNNEL_DELAY_MS: '100',
      },
      reject: false,
    }
  );
  expect(started.exitCode, started.stderr).toBe(0);
  await writeCloudBindingAsync(expoHome, root, { id: 'ended' });
  list([{ id: 'ended', status: 'STOPPED' }]);
  await writeCloudSessionFileAsync(root, 'ended');
  const reopened = await executeAgentCliAsync(
    root,
    ['dev', '--ios', '--eas', '--detach', '--json'],
    {
      env: {
        ...envFor(root),
        STUB_SIM_START_ID: 'replacement',
        STUB_EAS_BUILDS: JSON.stringify([
          {
            id: 'matching-build',
            platform: 'IOS',
            status: 'FINISHED',
            fingerprintHash: '0f1e2d3c4b5a69788796a5b4c3d2e1f001234567',
            buildProfile: 'development-simulator',
          },
        ]),
      },
      reject: false,
    }
  );
  expect(reopened.exitCode, reopened.stderr).toBe(0);
  expect(readBinding(root).device).toMatchObject({ id: 'replacement', origin: 'started' });
  const args = stubEasArgs(root);
  expect(args.find((a) => a[0] === 'simulator')).toEqual(
    expect.arrayContaining(['--build-id', 'matching-build'])
  );
  expect(args.some((a) => a[0] === 'build')).toBe(false);
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
it('a session the dotenv does not name is refused with dev:stop --eas, which ends both', async () => {
  const root = await project();
  await writeCloudBindingAsync(expoHome, root, { id: 'ios-A' });
  await writeCloudBindingAsync(expoHome, root, { id: 'android-B', platform: 'android' });
  list([{ id: 'ios-A' }, { id: 'android-B', platform: 'ANDROID' }]);
  await writeCloudSessionFileAsync(root, 'android-B');
  const refused = await navigate(root, ['--ios']);
  expect(refused.exitCode).not.toBe(0);
  const { error } = JSON.parse(refused.stdout);
  expect(error.code).toBe('CLOUD_SESSION_MISMATCH');
  expect(error.suggestedCommand).toContain('dev:stop --eas');
  expect(error.data).toEqual({ selectedSessionId: 'ios-A', loadedSessionId: 'android-B' });
  expect(readStubEasInvocations(root).filter((i) => i.executedSessionId)).toEqual([]);
  await executeAgentCliAsync(root, ['dev:stop', '--eas', '--json'], { env: envFor(root) });
  expect(fs.existsSync(bindingFile(root))).toBe(false);
  expect(fs.existsSync(bindingFile(root, 'android'))).toBe(false);
  const stops = stubEasArgs(root)
    .filter((args) => args[0] === 'simulator:stop')
    .flat();
  expect(stops).toEqual(expect.arrayContaining(['ios-A', 'android-B']));
  expect(fs.readFileSync(path.join(root, '.env.eas-simulator'), 'utf8')).not.toContain('=');
});
it('a start for the other platform beside a bound session refuses and spawns nothing', async () => {
  const root = await project();
  await writeCloudBindingAsync(expoHome, root, { id: 's-ios' });
  list([{ id: 's-ios' }]);
  const result = await executeAgentCliAsync(
    root,
    ['dev', '--android', '--eas', '--detach', '--json'],
    {
      env: envFor(root),
      reject: false,
    }
  );
  expect(result.exitCode).not.toBe(0);
  const { error } = JSON.parse(result.stdout);
  expect(error.code).toBe('CLOUD_SIMULATOR_PLATFORM_MISMATCH');
  expect(error.suggestedCommand).toContain('dev:stop --eas');
  expect(stubEasArgs(root).map((args) => args[0])).not.toContain('simulator');
  expect(readStubExpoInvocations(root).map((i) => i.args[0])).not.toContain('start');
});
it('round-trips guarded cloud target argv', async () => {
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
  const accepted = await spawnSubprocessAsync(
    easCli!.command,
    easCliArgs(easCli!, guardedCloudArgs(['simulator:exec', ...target], sessionId)),
    { cwd: root, env }
  );
  expect(accepted.exitCode, accepted.stderr).toBe(0);
  expect(JSON.parse(accepted.stdout)).toEqual(targetArgs);
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
it('an explicit stop failure keeps the binding for retry', async () => {
  const root = await project();
  await writeCloudBindingAsync(expoHome, root, { id: 'A' });
  list([{ id: 'A' }]);
  const result = await executeAgentCliAsync(root, ['dev:stop', '--eas', '--json'], {
    env: { ...envFor(root), STUB_SIM_STOP_EXIT: '1' },
    reject: false,
  });
  expect(result.exitCode).not.toBe(0);
  expect(readBinding(root).device).toMatchObject({ id: 'A' });
});
it('a failed start records the billed session, and dev:stop --eas stops it', async () => {
  const root = await project();
  const result = await executeAgentCliAsync(root, ['dev', '--ios', '--eas', '--detach', '--json'], {
    env: {
      ...envFor(root),
      STUB_SIM_START_EXIT: '1',
      STUB_SIM_START_ID: 'billed',
      STUB_EXPO_DEV_SERVER_PORT: '8761',
      STUB_EXPO_LISTEN: '1',
      STUB_EXPO_DELAY_MS: '90000',
      STUB_EXPO_TUNNEL_HOST: 'cloud.tunnel.example',
      STUB_EXPO_TUNNEL_DELAY_MS: '100',
    },
    reject: false,
  });
  expect(result.exitCode, result.stderr).toBe(0);
  await waitForAsync(() => fs.existsSync(bindingFile(root)), 15000);
  expect(readBinding(root).device).toMatchObject({ id: 'billed', origin: 'started' });
  expect(fs.readFileSync(path.join(root, '.env.eas-simulator'), 'utf8')).toContain(
    "EAS_SIMULATOR_SESSION_ID='billed'"
  );
  const stops = () => stubEasArgs(root).filter((args) => args[0] === 'simulator:stop');
  expect(stops()).toEqual([]);
  await executeAgentCliAsync(root, ['dev:stop', '--eas', '--json'], { env: envFor(root) });
  expect(stops()).toEqual([['simulator:stop', '--id', 'billed', '--non-interactive']]);
  expect(fs.existsSync(bindingFile(root))).toBe(false);
});
it('recovery restarts the server before rebinding its preserved EAS session', async () => {
  const root = await project();
  const run = () =>
    executeAgentCliAsync(root, ['dev', '--ios', '--eas', '--detach', '--wait-ready', '--json'], {
      env: {
        ...envFor(root),
        STUB_EXPO_DEV_SERVER_PORT: '8763',
        STUB_EXPO_LISTEN: '1',
        STUB_EXPO_DELAY_MS: '90000',
        STUB_EXPO_TUNNEL_HOST: 'cloud.tunnel.example',
        STUB_EXPO_TUNNEL_DELAY_MS: '100',
      },
      reject: false,
    });
  const opens = () =>
    readStubEasInvocations(root).filter((i) => i.executedSessionId && i.args.includes('open'));
  const first = await run();
  expect(first.exitCode, first.stderr).toBe(0);
  await waitForAsync(() => fs.existsSync(bindingFile(root)), 15000);
  const id = 'sess-e2e-started';
  expect(readBinding(root).device).toMatchObject({ id });
  // The start opened the app itself, through its launch URL.
  expect(opens()).toEqual([]);
  fs.rmSync(bindingFile(root));

  const status = await executeAgentCliAsync(root, ['status', '--json'], { env: envFor(root) });
  expect(JSON.parse(status.stdout).next.command).toContain('dev:stop &&');
  expect(JSON.parse(status.stdout).next.command).toContain('dev --ios --eas');
  await executeAgentCliAsync(root, ['dev:stop', '--json'], { env: envFor(root) });
  const second = await run();
  expect(second.exitCode, second.stderr).toBe(0);
  expect(second.stderr).not.toMatch(/Waiting up to .* for the EAS Simulator session/);
  expect(readBinding(root).device).toMatchObject({ id });
  expect(await waitForAsync(() => opens().length === 1, 15_000)).toBe(true);
  expect(opens().map((i) => i.executedSessionId)).toEqual([id]);
  expect(stubEasArgs(root).filter((args) => args[0] === 'simulator')).toHaveLength(1);
});
