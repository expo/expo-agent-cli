// @ref llp/0035-one-device-per-worktree.rfc.md §Lifecycle smoke
//
// `smoke` on macOS, with a stub `xcrun` that keeps simulator state: which simulator the run counts
// as its own, which one it boots, and the registry it leaves behind. Helpers are in
// `smokeFixtures.ts`; the rest of the `smoke` e2e cases are in `smoke-test.ts`.
import fs from 'node:fs';
import path from 'node:path';

import { appRuntime, bindOtherWorktreeAsync, expoGoRuntimeTarget } from '../runtimeTargetFixtures';
import {
  executeAgentCliAsync,
  setupFixtureAsync,
  startStubDevServerAsync,
  stubExpoEnv,
  type StubDevServer,
  expoHomeOf,
  holdLockForAsync,
  readEvents,
} from '../utils';
import { createdSimulatorName } from '../../src/deviceBinding/choose';
import { digestForRoot } from '../../src/deviceBinding/registry';
import {
  appStartedMarkerPath,
  bindingFixture,
  installStubXcrunAsync as installStatefulXcrunAsync,
} from './installedAppStubs';
import {
  EXPO_GO_TARGET,
  DEV_BUILD_TARGET,
  writeRoutesAsync,
  installStubNpxAsync,
} from './smokeFixtures';

describe('@expo/agent-cli smoke', () => {
  // @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
  //
  // Another worktree's clone simulator loads from this dev server and is the only app on it. The
  // gate does not count that app as its own, whether the list held it from the first poll or only
  // after the gate opened the app.
  describe.skipIf(process.platform !== 'darwin')("an app on another worktree's simulator", () => {
    it.each([
      { name: 'listed from the first poll', appearsAfterOpen: false },
      { name: 'listed only after the app was opened', appearsAfterOpen: true },
    ])('is not counted as the app, $name', async ({ appearsAfterOpen }) => {
      const projectRoot = await fs.promises.realpath(await setupFixtureAsync('go-app'));
      await installStatefulXcrunAsync(projectRoot, {
        simulators: [
          { udid: 'SIM-OWN', name: 'iPhone 17 Pro', state: 'Booted' },
          { udid: 'SIM-LEGEND', name: 'agent-cli c4ed0a60', state: 'Booted' },
        ],
      });
      const otherRoot = await bindOtherWorktreeAsync(
        projectRoot,
        'SIM-LEGEND',
        'agent-cli c4ed0a60'
      );
      const stub = await startStubDevServerAsync({
        projectRoot,
        targets: [{ ...EXPO_GO_TARGET, deviceName: 'agent-cli c4ed0a60' }],
        ...(appearsAfterOpen ? { targetsAppearWithFile: appStartedMarkerPath(projectRoot) } : {}),
      });
      const release = await holdLockForAsync(projectRoot, stub);

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['smoke', '--ios', '--json', '--no-screenshot', '--timeout', '4s'],
          { env: stubExpoEnv(projectRoot), reject: false }
        );

        expect(result.exitCode).toBe(22);
        const report = JSON.parse(result.stdout);
        expect(report.phases.find((phase: any) => phase.id === 'app')).toMatchObject({
          status: 'inconclusive',
        });
        expect(report.appsConnected).toBe(0);
        const skipped = {
          deviceName: 'agent-cli c4ed0a60',
          group: 'other-worktree',
          projectRoots: [otherRoot],
        };
        expect(report.skippedApps).toEqual([skipped]);
        const reason: string = report.phases.find((phase: any) => phase.id === 'app').reason;
        expect(reason).toContain('agent-cli c4ed0a60');
        expect(reason).toContain(otherRoot);
        expect(reason.match(/Skipped 1 app/g)).toHaveLength(1);
      } finally {
        release();
        await stub.close();
      }
    });
  });

  describe.skipIf(process.platform !== 'darwin')("an app beside another worktree's app", () => {
    it('is read, and the skipped app is named on stderr and in the report', async () => {
      const projectRoot = await fs.promises.realpath(await setupFixtureAsync('go-app'));
      await installStatefulXcrunAsync(projectRoot, {
        simulators: [
          { udid: 'SIM-OWN', name: 'iPhone 17 Pro', state: 'Booted' },
          { udid: 'SIM-LEGEND', name: 'agent-cli c4ed0a60', state: 'Booted' },
        ],
      });
      const otherRoot = await bindOtherWorktreeAsync(
        projectRoot,
        'SIM-LEGEND',
        'agent-cli c4ed0a60'
      );
      const stub = await startStubDevServerAsync({
        projectRoot,
        targets: [
          { ...EXPO_GO_TARGET, deviceName: 'iPhone 17 Pro' },
          {
            ...EXPO_GO_TARGET,
            id: '2',
            webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=2&page=1',
            deviceName: 'agent-cli c4ed0a60',
          },
        ],
      });
      const release = await holdLockForAsync(projectRoot, stub);

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['smoke', '--ios', '--json', '--no-screenshot', '--timeout', '4s'],
          { env: stubExpoEnv(projectRoot), reject: false }
        );

        const report = JSON.parse(result.stdout);
        expect(report.appsConnected).toBe(1);
        expect(report.skippedApps).toEqual([
          { deviceName: 'agent-cli c4ed0a60', group: 'other-worktree', projectRoots: [otherRoot] },
        ]);
        expect(result.stderr.match(/Skipped 1 app: "agent-cli c4ed0a60"/g)).toHaveLength(1);
        expect(result.stderr).toContain(otherRoot);
      } finally {
        release();
        await stub.close();
      }
    });
  });

  // @ref llp/0035-one-device-per-worktree.rfc.md §Lifecycle smoke
  //
  // The device a bootstrapping run boots is this worktree's own simulator, taken from the registry
  // or created there, and is released after the run. The stub `xcrun` keeps simulator state the
  // way `simctl` does, so what is asserted is the registry file and the calls that put the device up.
  describe.skipIf(process.platform !== 'darwin')('binding the device to boot', () => {
    const DEV_CLIENT_ID = 'com.example.dcapp';

    /** A dev-client project whose `app.json` names a bundle identifier. */
    async function devClientFixtureAsync(): Promise<string> {
      const projectRoot = await setupFixtureAsync('dev-client-fresh-app');
      const configPath = path.join(projectRoot, 'app.json');
      const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      config.expo.ios = { ...config.expo.ios, bundleIdentifier: DEV_CLIENT_ID };
      await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
      return projectRoot;
    }

    /** The registry file of the fixture, as `dev` or `smoke` wrote it. */
    function readBinding(projectRoot: string): Record<string, any> | null {
      const dir = path.join(expoHomeOf(projectRoot), 'agent-cli', 'bindings');
      const file = fs.existsSync(dir)
        ? fs.readdirSync(dir).find((name) => name.endsWith('-ios-local-ios.json'))
        : null;
      return file ? JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) : null;
    }

    async function runAsync(
      projectRoot: string,
      stub: StubDevServer,
      args: string[] = [],
      env: Record<string, string> = {}
    ): Promise<Record<string, any>> {
      const release = await holdLockForAsync(projectRoot, stub);
      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['smoke', '--ios', '--json', '--no-screenshot', '--timeout', '4s', ...args],
          { env: { ...stubExpoEnv(projectRoot), AGENT_CLI_NO_DEVICE: '0', ...env }, reject: false }
        );
        return JSON.parse(result.stdout);
      } finally {
        release();
      }
    }

    it('creates and binds a simulator, boots it with bootstatus -b, and installs the development build onto it', async () => {
      const projectRoot = await devClientFixtureAsync();
      const opened = appStartedMarkerPath(projectRoot);
      const { calls: readXcrun } = await installStatefulXcrunAsync(projectRoot);
      const readNpx = await installStubNpxAsync(projectRoot);
      const stub = await startStubDevServerAsync({
        projectRoot,
        // The development build, on the simulator this run is about to create: a target whose
        // device name is not a booted simulator's is never counted as an iOS app, and a run that
        // counts none waits out the whole cold attach budget.
        targets: [
          {
            ...DEV_BUILD_TARGET,
            appId: DEV_CLIENT_ID,
            deviceName: createdSimulatorName(digestForRoot(projectRoot)),
          },
        ],
        targetsAppearWithFile: opened,
      });

      try {
        const report = await runAsync(projectRoot, stub);

        const binding = readBinding(projectRoot);
        expect(binding).toMatchObject({
          version: 1,
          device: { backend: 'local-ios', udid: 'E2E-CREATED-1', origin: 'created' },
        });
        expect(binding!.device.name).toMatch(/^agent-cli [0-9a-f]{8}$/);
        expect(readXcrun()).toContainEqual(['simctl', 'bootstatus', 'E2E-CREATED-1', '-b']);
        expect(readXcrun().some((argv) => argv[1] === 'boot')).toBe(false);
        expect(readXcrun()).toContainEqual(['simctl', 'shutdown', 'E2E-CREATED-1']);
        expect(Date.parse(binding!.expiresAt)).toBeLessThanOrEqual(Date.now());

        const boot = report.phases.find((phase: any) => phase.id === 'boot-device');
        expect(boot).toMatchObject({ status: 'ok' });
        expect(boot.reason).not.toContain('shut it down');
        expect(report.environment.cleanup).toContainEqual(
          expect.objectContaining({ resource: 'device', ok: true })
        );
        expect(report.environment.boundDevice).toEqual({
          id: 'E2E-CREATED-1',
          name: binding!.device.name,
          action: 'created',
          released: true,
          shutDown: true,
        });

        // A created simulator has no app, so the install is a native build pinned to it.
        const install = report.phases.find((phase: any) => phase.id === 'install-app');
        expect(install).toMatchObject({ status: 'ok' });
        const run = readNpx().find((argv) => argv.includes('run:ios'));
        expect(run).toEqual(['expo', 'run:ios', '--no-bundler', '--device', 'E2E-CREATED-1']);
        expect(readNpx().some((argv) => argv.includes('start'))).toBe(false);
        // The build it installed is the app it then read: the open attached it.
        expect(report.phases.find((phase: any) => phase.id === 'app')).toMatchObject({
          status: 'ok',
        });
        expect(report.appsConnected).toBe(1);
      } finally {
        await stub.close();
      }
    });

    it('downloads and installs missing Expo Go onto the bound simulator before opening and attaching', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      const opened = appStartedMarkerPath(projectRoot);
      const { calls: readXcrun } = await installStatefulXcrunAsync(projectRoot, {
        expoGoMissing: true,
      });
      const readNpx = await installStubNpxAsync(projectRoot);
      await writeRoutesAsync(projectRoot, ['index.tsx']);
      const eventsPath = path.join(projectRoot, 'events.jsonl');
      const runtime = appRuntime({ __r() {} });
      const bundleProbes: { answer: unknown; opens: number }[] = [];
      const stub = await startStubDevServerAsync({
        projectRoot,
        targets: () => {
          if (!readXcrun().some((argv) => argv[1] === 'install')) return [];
          return [
            expoGoRuntimeTarget('ios', { deviceName: readBinding(projectRoot)?.device.name ?? '' }),
          ];
        },
        inspectorEvaluate(expression) {
          const answer = runtime.evaluate(expression);
          if (answer !== 'bundle:ran') return answer;
          // A relaunched process can register under the same debugger page ID.
          const loaded = fs.existsSync(opened) && bundleProbes.length > 0 ? answer : null;
          bundleProbes.push({
            answer: loaded,
            opens: readXcrun().filter((argv) => argv[1] === 'openurl').length,
          });
          return loaded;
        },
      });

      try {
        expect(fs.existsSync(opened)).toBe(false);
        const report = await runAsync(projectRoot, stub, ['--route', '/', '--timeout', '20s'], {
          LOG_EVENTS: eventsPath,
          EXPO_NO_DEV_MENU: '0',
        });
        expect(bundleProbes.slice(0, 2)).toEqual([
          { answer: null, opens: 1 },
          { answer: 'bundle:ran', opens: 1 },
        ]);
        expect(report.phases).toContainEqual(
          expect.objectContaining({ id: 'route', status: 'ok' })
        );
        const binding = readBinding(projectRoot);
        expect(binding).toMatchObject({ device: { udid: 'E2E-CREATED-1', origin: 'created' } });
        const udid = binding!.device.udid;
        expect(readNpx()).toContainEqual([
          '--yes',
          'expo-go',
          'download',
          'ios',
          '54.0.0',
          '--json',
        ]);
        const calls = readXcrun();
        const installAt = calls.findIndex((argv) => argv[1] === 'install');
        expect(installAt).toBeGreaterThan(-1);
        expect(calls[installAt]).toEqual([
          'simctl',
          'install',
          udid,
          expect.stringMatching(/Expo-Go-57\.0\.9\.tar\.app$/),
        ]);
        const openAt = calls.findIndex((argv) => argv[1] === 'openurl');
        expect(openAt).toBeGreaterThan(installAt);
        const origin = `exp://127.0.0.1:${stub.port}`;
        expect(calls.filter((argv) => argv[1] === 'openurl')).toEqual([
          ['simctl', 'openurl', udid, origin],
          ['simctl', 'openurl', udid, origin + '/--/?'],
        ]);
        expect(readEvents(eventsPath).filter((event) => event._e === 'cli:navigate')).toMatchObject(
          [
            { route: null, url: origin },
            { route: '/', url: origin + '/--/?' },
          ]
        );
        for (const scheme of ['exp', 'exps']) {
          const approval = [
            'simctl',
            'spawn',
            udid,
            'defaults',
            'write',
            'com.apple.launchservices.schemeapproval',
            `com.apple.CoreSimulator.CoreSimulatorBridge-->${scheme}`,
            '-string',
            'host.exp.Exponent',
          ];
          expect(calls.slice(installAt + 1, openAt)).toContainEqual(approval);
        }
        expect(report.phases.find((phase: any) => phase.id === 'install-app')).toMatchObject({
          status: 'ok',
        });
        expect(report.phases.find((phase: any) => phase.id === 'app')).toMatchObject({
          status: 'ok',
        });
        expect(report.appsConnected).toBe(1);
        expect(fs.existsSync(opened)).toBe(true);
        expect(calls.slice(openAt)).toContainEqual(['simctl', 'shutdown', udid]);
        expect(report.environment.cleanup).toContainEqual(
          expect.objectContaining({ resource: 'device', ok: true })
        );
        expect(Date.parse(binding!.expiresAt)).toBeLessThanOrEqual(Date.now());
      } finally {
        await stub.close();
      }
    });

    it('reuses the parked simulator the worktree already has', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      const opened = appStartedMarkerPath(projectRoot);
      const { calls: readXcrun } = await installStatefulXcrunAsync(projectRoot, {
        simulators: [{ udid: 'E2E-PARKED', name: 'agent-cli deadbeef', state: 'Shutdown' }],
      });
      await bindingFixture(projectRoot, 'E2E-PARKED', 'agent-cli deadbeef');
      await installStubNpxAsync(projectRoot);
      const stub = await startStubDevServerAsync({
        projectRoot,
        targets: [EXPO_GO_TARGET],
        targetsAppearWithFile: opened,
      });

      try {
        const report = await runAsync(projectRoot, stub);

        expect(readXcrun().some((argv) => argv[1] === 'create')).toBe(false);
        expect(readXcrun()).toContainEqual(['simctl', 'bootstatus', 'E2E-PARKED', '-b']);
        expect(readBinding(projectRoot)).toMatchObject({ device: { udid: 'E2E-PARKED' } });
        expect(readXcrun()).toContainEqual(['simctl', 'shutdown', 'E2E-PARKED']);
        expect(report.environment.boundDevice).toMatchObject({
          id: 'E2E-PARKED',
          action: 'reused',
          released: true,
          shutDown: true,
        });
        expect(report.phases.find((phase: any) => phase.id === 'boot-device')).toMatchObject({
          status: 'ok',
        });
      } finally {
        await stub.close();
      }
    });

    it('suggests a restart for the parked simulator when no app connected', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      await installStatefulXcrunAsync(projectRoot, {
        simulators: [{ udid: 'E2E-PARKED', name: 'agent-cli deadbeef', state: 'Shutdown' }],
      });
      await bindingFixture(projectRoot, 'E2E-PARKED', 'agent-cli deadbeef');
      await installStubNpxAsync(projectRoot);
      const stub = await startStubDevServerAsync({ projectRoot, targets: [] });

      try {
        const report = await runAsync(projectRoot, stub, [], { AGENT_CLI_COLD_ATTACH_MS: '2000' });

        expect(report.appsConnected).toBe(0);
        // The wait for the app that never came was the harness budget, not the two-minute one.
        expect(report.phases.find((phase: any) => phase.id === 'app').ms).toBeLessThan(10_000);
        expect(report.environment).toMatchObject({ devServer: 'reused', device: 'booted' });
        expect(report.environment.boundDevice).toMatchObject({ id: 'E2E-PARKED', released: true });
        expect(report.followups[0].command).toBe(
          'npx @expo/agent-cli dev:stop && npx @expo/agent-cli dev --ios --detach --wait-ready --local'
        );
      } finally {
        await stub.close();
      }
    });

    it('names the bound device it found the app on, and keeps it', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      const { calls: readXcrun } = await installStatefulXcrunAsync(projectRoot, {
        simulators: [{ udid: 'E2E-BOOTED', name: 'dogfood-explicit', state: 'Booted' }],
      });
      await bindingFixture(projectRoot, 'E2E-BOOTED', 'dogfood-explicit');
      const before = readBinding(projectRoot);
      const stub = await startStubDevServerAsync({ projectRoot, targets: [EXPO_GO_TARGET] });
      const release = await holdLockForAsync(projectRoot, stub);

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['smoke', '--ios', '--json', '--timeout', '4s'],
          { env: { ...stubExpoEnv(projectRoot), AGENT_CLI_NO_DEVICE: '0' }, reject: false }
        );
        const report = JSON.parse(result.stdout);

        expect(report.environment).toMatchObject({ devServer: 'reused', device: 'reused' });
        expect(report.environment.boundDevice).toEqual({
          id: 'E2E-BOOTED',
          name: 'dogfood-explicit',
          action: 'existing',
          released: null,
          shutDown: false,
        });
        expect(report.environment.cleanup).toEqual([]);
        expect(readXcrun().some((argv) => argv[1] === 'shutdown')).toBe(false);
        expect(readBinding(projectRoot)?.device).toEqual(before?.device);
      } finally {
        release();
        await stub.close();
      }
    });

    it('names the device its started dev server bound, and the release dev:stop did', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      const { calls: readXcrun } = await installStatefulXcrunAsync(projectRoot, {
        simulators: [{ udid: 'E2E-PARKED', name: 'agent-cli deadbeef', state: 'Shutdown' }],
      });
      await bindingFixture(projectRoot, 'E2E-PARKED', 'agent-cli deadbeef');
      await installStubNpxAsync(projectRoot);

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['smoke', '--ios', '--json', '--no-screenshot', '--port', '9353', '--timeout', '4s'],
          {
            env: {
              ...stubExpoEnv(projectRoot),
              AGENT_CLI_NO_DEVICE: '0',
              STUB_EXPO_DELAY_MS: '30000',
              STUB_EXPO_DEV_SERVER_PORT: '9353',
              STUB_EXPO_LISTEN: '1',
              AGENT_CLI_COLD_ATTACH_MS: '2000',
            },
            reject: false,
          }
        );

        const report = JSON.parse(result.stdout);
        expect(report.environment.devServer).toBe('started');
        // The wait for the app that never came was the harness budget, not the two-minute one.
        expect(report.phases.find((phase: any) => phase.id === 'app').ms).toBeLessThan(10_000);
        expect(report.environment.boundDevice).toEqual({
          id: 'E2E-PARKED',
          name: 'agent-cli deadbeef',
          action: 'reused',
          released: true,
          shutDown: true,
        });
        expect(report.environment.cleanup).toContainEqual(
          expect.objectContaining({ resource: 'device', target: 'E2E-PARKED', ok: true })
        );
        expect(readXcrun()).toContainEqual(['simctl', 'shutdown', 'E2E-PARKED']);
        // The run put back both the dev server and the device, so `navigate` alone has neither.
        expect(report.outcome).toBe('inconclusive');
        expect(report.followups.map((followup: any) => followup.command)).toEqual([
          'npx @expo/agent-cli dev --ios --detach --wait-ready --port 9353',
          'npx @expo/agent-cli navigate / --ios',
          'npx @expo/agent-cli smoke --ios --port 9353',
        ]);
      } finally {
        await executeAgentCliAsync(projectRoot, ['dev:stop', '--release', '--json'], {
          env: { ...stubExpoEnv(projectRoot), AGENT_CLI_NO_DEVICE: '0' },
          reject: false,
        });
      }
    });

    it('keeps the device that was bound and booted before its started dev server', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      const { calls: readXcrun } = await installStatefulXcrunAsync(projectRoot, {
        simulators: [{ udid: 'E2E-BOOTED', name: 'agent-cli f5ce27a6', state: 'Booted' }],
      });
      await bindingFixture(projectRoot, 'E2E-BOOTED', 'agent-cli f5ce27a6');
      const before = readBinding(projectRoot);
      await installStubNpxAsync(projectRoot);

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['smoke', '--ios', '--json', '--no-screenshot', '--port', '9354', '--timeout', '4s'],
          {
            env: {
              ...stubExpoEnv(projectRoot),
              AGENT_CLI_NO_DEVICE: '0',
              STUB_EXPO_DELAY_MS: '30000',
              STUB_EXPO_DEV_SERVER_PORT: '9354',
              STUB_EXPO_LISTEN: '1',
              // The app runs on the bound simulator, so its target carries that simulator's name.
              STUB_EXPO_TARGETS: JSON.stringify([
                { ...EXPO_GO_TARGET, deviceName: 'agent-cli f5ce27a6' },
              ]),
            },
            reject: false,
          }
        );

        const report = JSON.parse(result.stdout);
        expect(report.environment.devServer).toBe('started');
        expect(report.appsConnected).toBe(1);
        expect(report.environment.boundDevice).toEqual({
          id: 'E2E-BOOTED',
          name: 'agent-cli f5ce27a6',
          action: 'existing',
          released: null,
          shutDown: false,
        });
        expect(report.environment.cleanup.map((entry: any) => entry.resource)).toEqual([
          'dev-server',
        ]);
        expect(readXcrun().some((argv) => argv[1] === 'shutdown')).toBe(false);
        expect(readBinding(projectRoot)?.device).toEqual(before?.device);
      } finally {
        await executeAgentCliAsync(projectRoot, ['dev:stop', '--release', '--json'], {
          env: { ...stubExpoEnv(projectRoot), AGENT_CLI_NO_DEVICE: '0' },
          reject: false,
        });
      }
    });

    // The boundary that remains: `--no-start` says change nothing, so nothing is bound and nothing
    // is built, and the report names the run that would.
    it('binds nothing and installs nothing under --no-start', async () => {
      const projectRoot = await devClientFixtureAsync();
      const { calls: readXcrun } = await installStatefulXcrunAsync(projectRoot);
      const readNpx = await installStubNpxAsync(projectRoot);
      const stub = await startStubDevServerAsync({ projectRoot, targets: [] });

      try {
        const report = await runAsync(projectRoot, stub, ['--no-start']);

        expect(readBinding(projectRoot)).toBeNull();
        expect(readXcrun().some((argv) => argv[1] === 'create' || argv[1] === 'bootstatus')).toBe(
          false
        );
        expect(readNpx().some((argv) => argv.includes('run:ios'))).toBe(false);
        expect(report.phases.some((phase: any) => phase.id === 'install-app')).toBe(false);
      } finally {
        await stub.close();
      }
    });
  });
});
