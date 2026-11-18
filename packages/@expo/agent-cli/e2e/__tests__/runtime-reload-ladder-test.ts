// @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads
//
// The runs where `runtime:reload` climbs, or cannot climb, to rung 2: the relaunch.
import {
  executeAgentCliAsync,
  holdLockForAsync,
  setupFixtureAsync,
  startStubDevServerAsync,
  stubExpoEnv,
} from '../utils';
import {
  appStartedMarkerPath,
  BOOTED_SIMULATOR,
  installStubXcrunAsync,
  SIMULATOR_UDID,
} from './installedAppStubs';
import { type ReloadResultJson } from '../../src/runtime/reload/reloadAsync';
import { EXPO_GO_TARGET, installNoDeviceXcrunAsync } from './reloadFixtures';

describe('runtime:reload climbs to the relaunch', () => {
  it('falls back to stopping the app on the device when no app is connected', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const stub = await startStubDevServerAsync({
      projectRoot,
      targets: [EXPO_GO_TARGET],
      messagePeers: {},
      // Nothing is connected until the stub `xcrun` has opened the app, which is what "no app is
      // connected" means on both channels at once: no peer on the command socket and no runtime in
      // the target list. The target that appears afterwards is therefore one this run produced.
      targetsAppearWithFile: appStartedMarkerPath(projectRoot),
    });
    const releaseLock = await holdLockForAsync(projectRoot, stub);
    const { calls: readXcrun } = await installStubXcrunAsync(projectRoot, {
      simulators: [BOOTED_SIMULATOR],
    });

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['runtime:reload', '--ios', '--json'],
        {
          env: stubExpoEnv(projectRoot),
        }
      );

      expect(result.exitCode).toBe(0);
      const report: ReloadResultJson = JSON.parse(result.stdout);
      expect(report.method).toBe('device');
      expect(report.verifiedBy).toBe('app-relaunch');
      const calls = readXcrun();
      expect(calls).toContainEqual(['simctl', 'terminate', SIMULATOR_UDID, 'host.exp.Exponent']);
      expect(calls.some((call) => call[1] === 'openurl')).toBe(true);
    } finally {
      releaseLock();
      await stub.close();
    }
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads — the cloud loop, K2.
//
// Two connection lists describe one app, and this command read the wrong one. `getpeers` on the
// dev server's command socket names the clients that speak *that* protocol; `/json/list` names the
// JavaScript runtimes that have a debugger — which is the list `status`, `runtime:eval` and `smoke`
// all use. Against a cloud app the first was empty and the second had the app in it, so
// `runtime:reload` printed "Apps connected 1 · no reload happened", then said "no app is connected
// to the dev server, so there is nothing to reload", then went looking for a booted simulator that
// this machine did not have — while `runtime:eval` was evaluating in that same app.
describe('an app the command socket cannot see', () => {
  /**
   * The same app, listed the way a dev server lists one a debugger can reach.
   *
   * `nativePageReloads` is what the target selector filters on, so a target without it is one no
   * CDP command can pick — which is right for the tests above and wrong for these.
   */
  const CDP_TARGET = {
    ...EXPO_GO_TARGET,
    title: 'React Native Experimental (Improved Chrome Reloads)',
    description: 'host.exp.Exponent',
    deviceName: 'iPhone 17 Pro',
    reactNative: { capabilities: { nativePageReloads: true }, logicalDeviceId: 'device-1' },
  };

  // @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads — wave 21.
  //
  // The K2 shape at the process boundary: the app is in `/json/list` and holds no client on the
  // command socket. `auto` used to refuse here and exit 20 with two methods to pick between; the
  // ladder now takes the rung that can reach the app, which is the relaunch — the same rung wave 19
  // made primary on a cloud session for the same reason.
  it('relaunches the app when the command socket has no client to broadcast to', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const stub = await startStubDevServerAsync({
      projectRoot,
      targets: [CDP_TARGET],
      messagePeers: {},
    });
    const releaseLock = await holdLockForAsync(projectRoot, stub);
    const { calls: readXcrun } = await installStubXcrunAsync(projectRoot, {
      simulators: [BOOTED_SIMULATOR],
    });

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        // A short wait, because this run cannot end early: neither observation is available, so it
        // spends the whole budget establishing that. The default 30s is the same wait live.
        ['runtime:reload', '--ios', '--timeout', '2s', '--json'],
        { env: stubExpoEnv(projectRoot), reject: false }
      );

      // 22, and honestly so: this stub relists the app under the page id it had before, which is
      // what a relaunched app does [observed — 2026-08-27, live on a cloud session: `…ce-1` before
      // the relaunch and `…ce-1` after it]. So there is no *fresh* target to be had, and this
      // project has no captured dev server log to read a `Bundled` line out of — the run reports
      // the mechanism it ran and says nothing was observed, which is "look again" and never a
      // success off a verb that accepted an argument.
      expect(result.exitCode).toBe(22);
      const report: ReloadResultJson = JSON.parse(result.stdout);
      expect(report.method).toBe('device');

      // @ref llp/0005-runtime-loop-tools.rfc.md §What proves a reload. No captured log: the How line
      // names the command that captures one.
      expect(result.stderr).toContain('npx @expo/agent-cli dev --detach --ios');
      expect(result.stderr).not.toContain('dev:logs');

      // The dev-server rung says the two lists disagreed rather than that nothing is connected.
      const broadcast = report.attempts.find((attempt) => attempt.method === 'dev-server')!;
      expect(broadcast.ok).toBe(false);
      expect(broadcast.reason).toContain('1 connected app');
      expect(broadcast.reason).not.toBe(
        'no app is connected to the dev server, so there is nothing to reload'
      );

      // The relaunch ran on the local device backend, and the attempt says what it cost.
      const device = report.attempts.find((attempt) => attempt.method === 'device')!;
      expect(device.ok).toBe(true);
      expect(device.reason).toContain(`the app's JavaScript state`);
      expect(readXcrun()).toContainEqual([
        'simctl',
        'terminate',
        SIMULATOR_UDID,
        'host.exp.Exponent',
      ]);
    } finally {
      releaseLock();
      await stub.close();
    }
  });

  // ...and with no device to relaunch on, the same state is exit 20 with the two deliberate
  // methods, which is what the ladder has left to offer.
  it('exits 20 and names the deliberate methods when no rung can reach the app', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const stub = await startStubDevServerAsync({
      projectRoot,
      targets: [CDP_TARGET],
      messagePeers: {},
    });
    const releaseLock = await holdLockForAsync(projectRoot, stub);
    // A stub `xcrun` that reports nothing booted, so the relaunch rung has no device.
    await installNoDeviceXcrunAsync(projectRoot);

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['runtime:reload', '--ios', '--json'],
        {
          env: stubExpoEnv(projectRoot),
          reject: false,
        }
      );

      expect(result.exitCode).toBe(20);
      expect(JSON.parse(result.stdout).reloaded).toBe(false);
      // Both deliberate methods are on stderr, with what each one costs.
      expect(result.stderr).toContain('--method device');
      expect(result.stderr).toContain('--method runtime');
    } finally {
      releaseLock();
      await stub.close();
    }
  });
});
