// @ref llp/0005-runtime-loop-tools.rfc.md §Pointing an app at this dev server
// The built CLI resolves the device, opens URLs through subprocesses, and polls a real HTTP
// server. Targets appear only after the recorded launcher open, not after an arbitrary delay.
import fs from 'node:fs';
import path from 'node:path';

import { devClientConnectUrl } from '../../src/navigate/connectUrl';
import { makeTarget } from '../../src/runtime/__tests__/targetSelectionFixtures';
import {
  installStubEasAsync,
  stubEasArgs,
  writeCloudBindingAsync,
  writeCloudSessionFileAsync,
} from '../stubEas';
import {
  executeAgentCliAsync,
  expoHomeOf,
  holdDevLockAsync,
  setupFixtureAsync,
  startStubDevServerAsync,
} from '../utils';
import {
  bindingFixture,
  BOOTED_SIMULATOR,
  installStubAdbAsync,
  installStubXcrunAsync,
  EMULATOR_SERIAL,
  stubEmulatorStatePath,
} from './installedAppStubs';

const APP_ID = 'com.example.demo';
const ROUTE = 'demoapp://profile/42';
const TUNNEL_HOST = 'stub-tunnel.example';

type Scenario = {
  name: string;
  backend: 'cloud' | 'local-ios' | 'local-android';
  platform: 'ios' | 'android';
  /** Flags after the route, besides the ones every row passes. */
  flags?: string[];
  initial: 'own' | 'other' | 'empty';
  neverAttaches?: boolean;
  /** The app attaches only once this run has stopped it and opened the link again. */
  attachesAfterStop?: boolean;
  /** An Android app of another model is attached too, which this run must not stop or count. */
  otherModelApp?: boolean;
  /**
   * A second emulator of the bound model is attached; which of the two reverse the port before
   * this run's own `adb reverse`.
   */
  twin?: 'both' | 'bound' | 'neither';
  /** A second emulator of the bound model attaches with the app, while this run waits. */
  twinAttachesWhileWaiting?: boolean;
};
const scenarios: Scenario[] = [
  {
    name: 'no flag, Android session, only an iOS app attached',
    backend: 'cloud',
    platform: 'android',
    initial: 'other',
  },
  {
    name: 'no flag, Android session, its app attached',
    backend: 'cloud',
    platform: 'android',
    initial: 'own',
  },
  {
    name: 'no flag, iOS session, its app attached',
    backend: 'cloud',
    platform: 'ios',
    initial: 'own',
  },
  {
    name: 'no flag, iOS session, only a local simulator app attached',
    backend: 'cloud',
    platform: 'ios',
    initial: 'other',
  },
  {
    name: '--ios without --eas, iOS session, its app attached',
    backend: 'cloud',
    platform: 'ios',
    flags: ['--ios'],
    initial: 'own',
  },
  {
    name: '--ios --eas --app-id, iOS session, its app attached',
    backend: 'cloud',
    platform: 'ios',
    flags: ['--ios', '--eas', '--app-id', APP_ID],
    initial: 'own',
  },
  {
    name: 'iOS session, empty first list, then only a local app',
    backend: 'cloud',
    platform: 'ios',
    initial: 'empty',
    neverAttaches: true,
  },
  {
    name: '--ios, bound simulator A, only an app on B attached',
    backend: 'local-ios',
    platform: 'ios',
    flags: ['--ios'],
    initial: 'other',
  },
  {
    name: 'no flag, bound Android emulator, only an iOS app attached',
    backend: 'local-android',
    platform: 'android',
    initial: 'other',
  },
  {
    name: "no flag, bound Android emulator, only an iOS app and another model's Android app attached",
    backend: 'local-android',
    platform: 'android',
    initial: 'other',
    neverAttaches: true,
    otherModelApp: true,
  },
  {
    name: 'no flag, bound Android emulator beside a twin that reverses the port too',
    backend: 'local-android',
    platform: 'android',
    initial: 'own',
    neverAttaches: true,
    twin: 'both',
  },
  {
    name: 'no flag, bound Android emulator beside a twin, only the bound one reverses the port',
    backend: 'local-android',
    platform: 'android',
    initial: 'own',
    twin: 'bound',
  },
  {
    name: 'no flag, bound Android emulator beside a twin, neither reverses the port before this run',
    backend: 'local-android',
    platform: 'android',
    initial: 'empty',
    twin: 'neither',
  },
  {
    name: 'no flag, bound Android emulator, the app attaches after the recovery stops it and opens the link again',
    backend: 'local-android',
    platform: 'android',
    initial: 'empty',
    attachesAfterStop: true,
  },
  {
    name: 'no flag, bound Android emulator, a twin attaches with the app while it waits',
    backend: 'local-android',
    platform: 'android',
    initial: 'empty',
    twinAttachesWhileWaiting: true,
  },
];

async function deviceFixture(root: string, scenario: Scenario) {
  const xcrun = await installStubXcrunAsync(root, {
    simulators: [BOOTED_SIMULATOR, { udid: 'OTHER-SIM', name: 'Simulator B', state: 'Booted' }],
  });
  const localFile = await bindingFixture(root, BOOTED_SIMULATOR.udid, BOOTED_SIMULATOR.name);
  // Give every case a stub SDK so fact reads never consult a developer's adb.
  const adb = await installStubAdbAsync(root, APP_ID, {
    attached: scenario.backend === 'local-android',
  });
  if (scenario.backend === 'local-ios') {
    return {
      env: adb.env,
      opens: () =>
        xcrun
          .calls()
          .filter((args) => args[1] === 'openurl')
          .map((args) => args[3]!),
    };
  }
  await fs.promises.rm(localFile);
  if (scenario.backend === 'local-android') {
    return {
      env: adb.env,
      calls: adb.calls,
      forceStops: () => adb.calls().filter((args) => args.includes('force-stop')),
      opens: () =>
        adb
          .calls()
          .filter((args) => args.includes('start') && args.includes('-d'))
          // adb forwards these quoted arguments to the device's shell.
          .map((args) => args[args.indexOf('-d') + 1]!.replace(/^'|'$/g, '')),
    };
  }
  await installStubEasAsync(root);
  await writeCloudSessionFileAsync(root, 'sess-e2e');
  await writeCloudBindingAsync(expoHomeOf(root), root, {
    id: 'sess-e2e',
    platform: scenario.platform,
  });
  return {
    env: { ...adb.env, STUB_SIM_PLATFORM: scenario.platform.toUpperCase() },
    opens: () =>
      stubEasArgs(root)
        .filter((args) => args[0] === 'simulator:exec' && args[3] === 'open')
        .map((args) => args[4]!),
  };
}

it.each(scenarios)('$name', async (scenario) => {
  const root = await fs.promises.realpath(await setupFixtureAsync('dev-client-app'));
  const device = await deviceFixture(root, scenario);
  if (scenario.backend === 'local-android') {
    // The launcher's main activity and the recovery's force-stop both come from this config.
    const configPath = path.join(root, 'app.json');
    const { expo } = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
    await fs.promises.writeFile(
      configPath,
      JSON.stringify({ expo: { ...expo, android: { package: APP_ID } } })
    );
  }
  const own = makeTarget({
    id: 'own',
    appId: APP_ID,
    deviceName:
      scenario.platform === 'android'
        ? 'sdk_gphone64_arm64 - 15 - API 35'
        : scenario.backend === 'local-ios'
          ? BOOTED_SIMULATOR.name
          : 'iPhone 17',
  });
  const other = makeTarget({
    id: 'other',
    appId: 'host.exp.Exponent',
    deviceName: scenario.backend === 'local-ios' ? 'Simulator B' : BOOTED_SIMULATOR.name,
  });
  const otherModel = makeTarget({
    id: 'other-model',
    appId: 'host.exp.exponent',
    deviceName: 'Pixel 9 - 15 - API 35',
  });
  const initial = [
    ...(scenario.initial === 'empty' ? [] : scenario.initial === 'own' ? [own] : [other]),
    ...(scenario.otherModelApp ? [otherModel] : []),
  ];
  let launcher = '';
  const server = await startStubDevServerAsync({
    projectRoot: root,
    manifestOrigin: scenario.backend === 'cloud' ? `https://${TUNNEL_HOST}` : undefined,
    targets: () => {
      if (scenario.twinAttachesWhileWaiting && device.opens().includes(launcher)) {
        fs.writeFileSync(stubEmulatorStatePath(root), 'emulator-5556\n');
      }
      return scenario.attachesAfterStop
        ? device.forceStops!().length > 0
          ? [own]
          : []
        : device.opens().includes(launcher)
          ? scenario.neverAttaches
            ? [other, ...(scenario.otherModelApp ? [otherModel] : [])]
            : [...initial, own]
          : initial;
    },
  });
  launcher = devClientConnectUrl(
    'demoapp',
    scenario.backend === 'cloud' ? TUNNEL_HOST : new URL(server.url).host,
    scenario.backend === 'cloud' ? 'tunnel' : null,
    true
  );
  const twinEnv = scenario.twin
    ? await (async () => {
        await fs.promises.writeFile(stubEmulatorStatePath(root), 'emulator-5556\n');
        return {
          STUB_ADB_REVERSE: JSON.stringify({
            ...(scenario.twin === 'neither' ? {} : { [EMULATOR_SERIAL]: server.port }),
            ...(scenario.twin === 'both' ? { 'emulator-5556': server.port } : {}),
          }),
        };
      })()
    : {};
  const releaseLock = await holdDevLockAsync(root, {
    url: server.url,
    port: server.port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    projectRoot: root,
  });
  try {
    const result = await executeAgentCliAsync(
      root,
      [
        'navigate',
        '/profile/42',
        ...(scenario.flags ?? []),
        '--scheme',
        'demoapp',
        '--no-route-check',
        '--attach-timeout',
        '2s',
        '--json',
        '--no-followups',
      ],
      { reject: false, env: { ...device.env, ...twinEnv } }
    );
    expect(result.exitCode, result.all).toBe(scenario.neverAttaches ? 22 : 0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      deviceBackend: scenario.backend,
      platform: scenario.platform,
      url: ROUTE,
      attached: !scenario.neverAttaches,
    });
    // An app that cannot be placed on this device neither counts as attached nor holds the launcher.
    const ownAttached = scenario.initial === 'own' && scenario.twin !== 'both';
    const stuck = scenario.neverAttaches || scenario.attachesAfterStop;
    const recovers = stuck && scenario.backend === 'local-android';
    expect(device.opens()).toEqual(
      ownAttached ? [ROUTE] : recovers ? [launcher, ROUTE, ROUTE] : [launcher, ROUTE]
    );
    if (!recovers) expect(device.forceStops?.() ?? []).toEqual([]);
    expect(report.attachRecovered).toBe(!!recovers);
    if (ownAttached) expect(report.launch).toBeNull();
    else expect(report.launch).toMatchObject({ url: launcher, attached: !stuck });
    if (device.calls) {
      const calls = device.calls();
      const startOf = (url: string) =>
        calls.findIndex((args) => args.includes('start') && args.some((arg) => arg.includes(url)));
      if (!ownAttached) {
        // The launcher goes to the main activity by component: a VIEW intent reaches the
        // dev launcher before its app runs, and the app lands on an error screen.
        const launch = calls[startOf(launcher)]!.join(' ');
        expect(launch).toContain(`-n '${APP_ID}/.MainActivity'`);
        expect(launch).not.toContain('android.intent.action.VIEW');
      }
      if (scenario.twin === 'neither') {
        // The link would load against a port nothing on the device listens on, if it came first.
        expect(report.reversedPort).toBe(server.port);
        const reverse = calls.findIndex(
          (args) => args[2] === 'reverse' && args[3] === `tcp:${server.port}`
        );
        expect(reverse).toBeGreaterThan(-1);
        expect(reverse).toBeLessThan(startOf(launcher));
      }
      if (scenario.neverAttaches) {
        // The recovery stops the configured app, not the app of another model.
        const stops = device.forceStops!();
        expect(stops.length).toBeGreaterThan(0);
        for (const args of stops) expect(args.at(-1)!.replace(/^'|'$/g, '')).toBe(APP_ID);
        expect(result.stderr).toContain('no android app connected');
        expect(result.stderr).toContain('accepted the intent and nothing more');
        expect(result.stderr).toContain(
          'The app was stopped and the link opened a second time, and that did not attach either.'
        );
      }
    }
  } finally {
    await releaseLock();
    await server.close();
  }
});

it('recovers an Expo Go run by stopping Expo Go, not the android.package of the config', async () => {
  const root = await fs.promises.realpath(await setupFixtureAsync('go-app'));
  const device = await deviceFixture(root, {
    name: 'expo go',
    backend: 'local-android',
    platform: 'android',
    initial: 'empty',
  });
  const configPath = path.join(root, 'app.json');
  const { expo } = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
  await fs.promises.writeFile(
    configPath,
    JSON.stringify({ expo: { ...expo, android: { package: APP_ID } } })
  );
  const server = await startStubDevServerAsync({ projectRoot: root, targets: () => [] });
  const releaseLock = await holdDevLockAsync(root, {
    url: server.url,
    port: server.port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    projectRoot: root,
  });
  try {
    const result = await executeAgentCliAsync(
      root,
      ['navigate', '/profile/42', '--no-route-check', '--attach-timeout', '2s', '--json'],
      { reject: false, env: device.env }
    );
    expect(result.exitCode, result.all).toBe(22);
    const stops = device.forceStops!();
    expect(stops.length).toBeGreaterThan(0);
    for (const args of stops) expect(args.at(-1)!.replace(/^'|'$/g, '')).toBe('host.exp.exponent');
    expect(result.stderr).toContain(
      'The app was stopped and the link opened a second time, and that did not attach either.'
    );
  } finally {
    await releaseLock();
    await server.close();
  }
});

it('--print-url scopes to the bound EAS session like navigate, so an iOS Expo Go app does not count', async () => {
  const root = await fs.promises.realpath(await setupFixtureAsync('dev-client-app'));
  const device = await deviceFixture(root, scenarios[0]!);
  const server = await startStubDevServerAsync({
    projectRoot: root,
    manifestOrigin: `https://${TUNNEL_HOST}`,
    targets: () => [
      makeTarget({
        id: 'other',
        appId: 'host.exp.Exponent',
        deviceName: BOOTED_SIMULATOR.name,
      }),
    ],
  });
  const releaseLock = await holdDevLockAsync(root, {
    url: server.url,
    port: server.port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    projectRoot: root,
  });
  try {
    const result = await executeAgentCliAsync(
      root,
      ['navigate', '/profile/42', '--print-url', '--no-route-check', '--json', '--no-followups'],
      { reject: false, env: device.env }
    );
    expect(result.exitCode, result.all).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      url: 'exp+dev-client-app://profile/42',
      printUrl: true,
    });
    expect(device.opens()).toEqual([]);
  } finally {
    await releaseLock();
    await server.close();
  }
});
