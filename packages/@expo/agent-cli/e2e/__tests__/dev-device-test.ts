// @ref llp/0026-dev-owns-the-open.rfc.md
// @ref llp/0035-one-device-per-worktree.rfc.md §How `dev` uses it
//
// `dev` with devices on: the open it performs once the dev server reports its port, on the device
// it bound, and the device `--plan` previews. The harness turns devices off; these cases turn them
// on with the stub `adb` of a fake Android SDK, so they run on every OS and never touch this
// machine's devices.
import fs from 'node:fs';
import path from 'node:path';

import {
  executeAgentCliAsync,
  installStubFingerprintAsync,
  killAsync,
  readStubExpoInvocations,
  setupFixtureAsync,
  spawnAgentCli,
  stubExpoEnv,
  waitForAsync,
  waitForDevLockAsync,
  startStubDevServerAsync,
} from '../utils';
import { appRuntime, runtimeTarget } from '../runtimeTargetFixtures';
import {
  androidBindingFixture,
  BOOTED_SIMULATOR,
  bindingFixture,
  EMULATOR_SERIAL,
  installStubAdbAsync,
  installStubXcrunAsync,
  stubEmulatorStatePath,
} from './installedAppStubs';

/** The second instance the stub `adb` lists, and the one each fixture binds. */
const BOUND_SERIAL = 'emulator-5556';

/** Copy a fixture with two emulator instances up, bound to the second one, and devices on. */
async function setupAsync(fixtureName: string) {
  const projectRoot = await setupFixtureAsync(fixtureName);
  await installStubFingerprintAsync(projectRoot);
  const adb = await installStubAdbAsync(projectRoot, 'host.exp.exponent', { bound: false });
  await fs.promises.writeFile(stubEmulatorStatePath(projectRoot), `${BOUND_SERIAL}\n`);
  await androidBindingFixture(projectRoot, BOUND_SERIAL);
  // No simulator, so nothing this run probes reaches the iOS devices of this machine.
  await installStubXcrunAsync(projectRoot);
  const env = { ...stubExpoEnv(projectRoot), ...adb.env, AGENT_CLI_NO_DEVICE: '0' };
  return { projectRoot, adb, env };
}

describe('@expo/agent-cli dev, with devices on', () => {
  // The open is armed when the dev server reports its port, so the stub serves for a while. The
  // first row is the control: the same window is long enough for an open that does happen.
  it.each([
    ['opens Expo Go on the bound device', ['--android'], {}, true],
    ['opens nothing under --no-open', ['--android', '--no-open'], {}, false],
    ['opens nothing for the web target, which is served rather than opened', ['--web'], {}, false],
    ['opens nothing with devices off', ['--android'], { AGENT_CLI_NO_DEVICE: '1' }, false],
  ])('%s once the dev server reports its port', async (_case, flags, devices, opened) => {
    const { projectRoot, adb, env } = await setupAsync('go-app');

    const result = await executeAgentCliAsync(projectRoot, ['dev', ...flags], {
      env: {
        ...env,
        ...devices,
        RCT_METRO_PORT: '8613',
        STUB_EXPO_LISTEN: '1',
        STUB_EXPO_DELAY_MS: '2000',
      },
    });

    expect(result.exitCode).toBe(0);
    const port = readStubExpoInvocations(projectRoot)[0]!.args.at(-1);
    const opens = adb
      .calls()
      .filter((args) => args.includes('am') && args.includes('start'))
      .map((args) => [args[1], args.at(-1)!.replace(/^'|'$/g, '')]);
    expect(opens).toEqual(opened ? [[BOUND_SERIAL, `exp://127.0.0.1:${port}/--/?`]] : []);
    // A run that opens nothing says nothing about an open, not even that one failed.
    const said = result.all
      .split(/\r?\n/)
      .filter((line) => /Opened the app|app was not opened/.test(line));
    expect(said).toEqual(opened ? ['Opened the app on the Android device.'] : []);
  });

  describe('--plan --device', () => {
    it(`offers the run of a plan that binds, with the caller's --device and --port`, async () => {
      const { projectRoot, env } = await setupAsync('dev-client-app');

      const result = await executeAgentCliAsync(
        projectRoot,
        [
          'dev',
          '--android',
          '--local',
          '--plan',
          '--device',
          EMULATOR_SERIAL,
          '--port',
          '8091',
          '--json',
        ],
        { env }
      );

      const plan = JSON.parse(result.stdout);
      expect(plan.explicitDevice).toMatchObject({ refuses: false });
      expect(plan.steps.find((step: { id: string }) => step.id === 'run').argv).toEqual([
        'expo',
        'run:android',
        '--port',
        '8091',
        '--device',
        EMULATOR_SERIAL,
      ]);
      expect(plan.followups.find((followup: { id: string }) => followup.id === 'dev').command).toBe(
        `npx @expo/agent-cli dev --android --local --device ${EMULATOR_SERIAL} --port 8091 --json --detach --wait-ready`
      );
    });

    // The plan stops on the running server, so it previews no device and asks no device tool.
    it("previews no device while this project's dev server runs", async () => {
      const { projectRoot, adb, env } = await setupAsync('dev-client-app');
      const server = spawnAgentCli(projectRoot, ['start', '--port', '8614'], {
        env: { ...env, STUB_EXPO_LISTEN: '1', STUB_EXPO_DELAY_MS: '30000' },
      });

      try {
        expect(await waitForDevLockAsync(projectRoot)).toMatchObject({ port: 8614 });
        // The server's own start reads its binding; the plan's calls are the ones after it.
        const before = adb.calls().length;
        const result = await executeAgentCliAsync(
          projectRoot,
          [
            'dev',
            '--android',
            '--local',
            '--plan',
            '--device',
            EMULATOR_SERIAL,
            '--port',
            '8091',
            '--json',
          ],
          { env }
        );

        const plan = JSON.parse(result.stdout);
        expect(plan.steps).toEqual([]);
        expect(plan.explicitDevice).toBeUndefined();
        expect(plan.reasons).not.toContainEqual(expect.stringContaining('reuse or start'));
        expect(plan.followups.map((followup: { id: string }) => followup.id)).toEqual([
          'dev-server-running',
        ]);
        expect(adb.calls().slice(before)).toEqual([]);
      } finally {
        await killAsync(server);
      }
    });
  });
});

// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — ready includes the app.
describe('@expo/agent-cli dev --detach --wait-ready, with devices on', () => {
  const DEV_CLIENT_ID = 'dev.e2e.devclient';

  /** A development build with a scheme, installed on the bound stub emulator. */
  async function setupDevClientAsync() {
    const projectRoot = await setupFixtureAsync('dev-client-fresh-app');
    await installStubFingerprintAsync(projectRoot);
    const file = path.join(projectRoot, 'app.json');
    const appJson = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    appJson.expo.scheme = 'devclient';
    appJson.expo.android = { package: DEV_CLIENT_ID };
    await fs.promises.writeFile(file, JSON.stringify(appJson, null, 2));
    const adb = await installStubAdbAsync(projectRoot, DEV_CLIENT_ID, { bound: false });
    await fs.promises.writeFile(stubEmulatorStatePath(projectRoot), `${BOUND_SERIAL}\n`);
    await androidBindingFixture(projectRoot, BOUND_SERIAL);
    await installStubXcrunAsync(projectRoot);
    const env = { ...stubExpoEnv(projectRoot), ...adb.env, AGENT_CLI_NO_DEVICE: '0' };
    return { projectRoot, adb, env };
  }

  /** Every URL the stub `adb` was asked to open, in order. */
  function openedUrls(adb: { calls: () => string[][] }): string[] {
    return adb
      .calls()
      .filter((args) => args.includes('am') && args.includes('start'))
      .map((args) => args.at(-1)!.replace(/^'|'$/g, ''));
  }

  async function stopAsync(projectRoot: string, env: Record<string, string>) {
    await executeAgentCliAsync(projectRoot, ['dev:stop', '--json'], { env, reject: false });
  }

  it('opens a development build with the launcher URL, and --wait-ready exits 22 when it does not attach', async () => {
    const { projectRoot, adb, env } = await setupDevClientAsync();
    const runEnv = {
      ...env,
      STUB_EXPO_LISTEN: '1',
      STUB_EXPO_DELAY_MS: '30000',
      AGENT_CLI_DEV_APP_WAIT_MS: '1500',
    };
    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--android', '--detach', '--wait-ready', '--port', '8623', '--json'],
        { env: runEnv, reject: false }
      );

      // The app the stub dev server lists is none, so the run is not ready.
      expect(result.exitCode).toBe(22);
      const { error } = JSON.parse(result.stdout);
      expect(error.code).toBe('DEV_DETACH_APP_NOT_ATTACHED');
      expect(error.suggestedCommand).toBe('npx @expo/agent-cli navigate / --android');
      // The dev server runs on after the failed wait.
      expect((await fetch('http://127.0.0.1:8623/status')).ok).toBe(true);
      // A development build with no app attached gets the URL that loads it, not the bare route.
      expect(await waitForAsync(() => openedUrls(adb).length > 0, 10_000)).toBe(true);
      expect(openedUrls(adb)[0]).toMatch(/^devclient:\/\/\?__expo_url=/);
    } finally {
      await stopAsync(projectRoot, env);
    }
  }, 60_000);

  it('--wait-ready waits for no app when the run opens none', async () => {
    const { projectRoot, env } = await setupAsync('go-app');
    const startedAt = Date.now();
    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--android', '--no-open', '--detach', '--wait-ready', '--port', '8624', '--json'],
        {
          env: {
            ...env,
            STUB_EXPO_LISTEN: '1',
            STUB_EXPO_DELAY_MS: '30000',
            AGENT_CLI_DEV_APP_WAIT_MS: '60000',
          },
        }
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).app).toBeNull();
      // No app wait ran: an empty target list would have held the run for the whole budget.
      expect(Date.now() - startedAt).toBeLessThan(30_000);
    } finally {
      await stopAsync(projectRoot, env);
    }
  }, 60_000);

  // `dev` binds an iOS simulator on macOS only.
  it.skipIf(process.platform !== 'darwin')(
    'opens an iOS development build with the launcher URL, and --wait-ready exits 22 when it does not attach',
    async () => {
      const projectRoot = await setupFixtureAsync('dev-client-fresh-app');
      await installStubFingerprintAsync(projectRoot);
      const file = path.join(projectRoot, 'app.json');
      const appJson = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      appJson.expo.scheme = 'devclient';
      appJson.expo.ios = { bundleIdentifier: DEV_CLIENT_ID };
      await fs.promises.writeFile(file, JSON.stringify(appJson, null, 2));
      const xcrun = await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR] });
      await bindingFixture(projectRoot, BOOTED_SIMULATOR.udid);
      const env = { ...stubExpoEnv(projectRoot), AGENT_CLI_NO_DEVICE: '0' };
      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['dev', '--ios', '--detach', '--wait-ready', '--port', '8625', '--json'],
          {
            env: {
              ...env,
              STUB_EXPO_LISTEN: '1',
              STUB_EXPO_DELAY_MS: '30000',
              AGENT_CLI_DEV_APP_WAIT_MS: '1500',
            },
            reject: false,
          }
        );

        expect(result.exitCode).toBe(22);
        expect(JSON.parse(result.stdout).error.code).toBe('DEV_DETACH_APP_NOT_ATTACHED');
        const opened = xcrun
          .calls()
          .filter((args) => args[0] === 'simctl' && args[1] === 'openurl');
        expect(opened.map((args) => args.at(-1))).toEqual([
          expect.stringMatching(/^devclient:\/\/\?__expo_url=/),
        ]);
      } finally {
        await stopAsync(projectRoot, env);
      }
    },
    60_000
  );

  // The runtime of the app on the bound simulator answers the bundle question.
  it.skipIf(process.platform !== 'darwin').each([
    ['exits 0 for an app that ran its bundle', { __r() {} }, 8626],
    ['exits 22 APP_NOT_LOADED for an app that ran no bundle', {}, 8627],
  ])(
    '--wait-ready on iOS %s',
    async (_case, globals, port) => {
      const projectRoot = await setupFixtureAsync('go-app');
      await installStubFingerprintAsync(projectRoot);
      await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR] });
      await bindingFixture(projectRoot, BOOTED_SIMULATOR.udid);
      const runtime = await startStubDevServerAsync({
        projectRoot,
        targets: [],
        inspectorEvaluate: appRuntime(globals).evaluate,
      });
      const target = runtimeTarget('sim', {
        appId: 'host.exp.Exponent',
        deviceName: BOOTED_SIMULATOR.name,
        webSocketDebuggerUrl: `ws://127.0.0.1:${new URL(runtime.url).port}/inspector/debug?device=sim&page=1`,
      });
      const env = { ...stubExpoEnv(projectRoot), AGENT_CLI_NO_DEVICE: '0' };
      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['dev', '--ios', '--detach', '--wait-ready', '--port', String(port), '--json'],
          {
            env: {
              ...env,
              STUB_EXPO_LISTEN: '1',
              STUB_EXPO_DELAY_MS: '30000',
              STUB_EXPO_TARGETS: JSON.stringify([target]),
              AGENT_CLI_DEV_APP_WAIT_MS: '1500',
            },
            reject: false,
          }
        );

        const report = JSON.parse(result.stdout);
        if ('__r' in globals) {
          expect(result.exitCode).toBe(0);
          expect(report.app).toMatchObject({ attached: true, loaded: true });
          return;
        }
        expect(result.exitCode).toBe(22);
        expect(report.error.code).toBe('APP_NOT_LOADED');
        expect(report.error.suggestedCommand).toBe('npx @expo/agent-cli navigate / --ios');
        // A second `dev` would stop on the running server, so the text sends the caller elsewhere.
        expect(report.error.message).toContain('The dev server is still running');
        expect((await fetch(`http://127.0.0.1:${port}/status`)).ok).toBe(true);
      } finally {
        await stopAsync(projectRoot, env);
        await runtime.close();
      }
    },
    60_000
  );
});
