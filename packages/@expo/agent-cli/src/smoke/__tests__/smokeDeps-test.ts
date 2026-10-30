// @ref llp/0035-one-device-per-worktree.rfc.md §iOS smoke
// @ref llp/0035-one-device-per-worktree.rfc.md §Wiring
// Smoke binds and releases only its own platform through the registry.
import { vol } from 'memfs';

import * as Log from '../../log';

import {
  acquireDeviceAsync,
  deviceIdOf,
  deviceNameOf,
  releaseWorktreeDevicesAsync,
} from '../../deviceBinding';
import {
  androidBindingFor,
  bindingFor,
  seedIosBinding,
} from '../../deviceBinding/__tests__/fakeTools';
import { bindingPathFor, readBindingFile } from '../../deviceBinding/registry';
import { fetchAdvertisedUrlAsync } from '../../dev/advertisedUrl';
import { probeCloudSessionAsync } from '../../device/cloudSimulator';
import { cloudProbe } from '../../device/__tests__/fakeCloudProbe';
import { lookUpEasSimulatorBuildAsync } from '../../plan/easBuildLookup';
import { PROGRAM_PREFIX } from '../../programName';
import { makeDeviceInventory, makeTarget } from '../../runtime/__tests__/targetSelectionFixtures';
import {
  resolveScopeAsync,
  resolveTargetSelectionAsync,
} from '../../runtime/resolveTargetSelection';
import {
  classifyTargets,
  describeSkippedApps,
  type TargetSelection,
} from '../../runtime/targetSelection';
import { resolveEasCli } from '../../utils/easCli';
import { spawnCaptureAsync } from '../../utils/spawnCapture';
import { ensureGitExcludedAsync } from '../../utils/gitExclude';
import { resolveSmokeOptions } from '../resolveOptions';
import { buildSmokeDeps, cleanupLeft, deviceBoundByStart } from '../smokeAsync';
import type { SmokeEnvironmentJson } from '../types';
import { mockPlatform } from '../../utils/__tests__/mockPlatform';

vi.mock('../../log');
vi.mock('../../deviceBinding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../deviceBinding')>()),
  acquireDeviceAsync: vi.fn(),
  releaseWorktreeDevicesAsync: vi.fn(async () => []),
}));

vi.mock('../../device/cloudSimulator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../device/cloudSimulator')>()),
  probeCloudSessionAsync: vi.fn(),
}));
vi.mock('../../plan/easBuildLookup', () => ({ lookUpEasSimulatorBuildAsync: vi.fn() }));
vi.mock('../../dev/advertisedUrl', () => ({ fetchAdvertisedUrlAsync: vi.fn() }));
vi.mock('../../utils/easCli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/easCli')>()),
  resolveEasCli: vi.fn(),
}));
vi.mock('../../utils/spawnCapture', () => ({ spawnCaptureAsync: vi.fn() }));
vi.mock('../../utils/gitExclude', () => ({ ensureGitExcludedAsync: vi.fn() }));
vi.mock('../../runtime/resolveTargetSelection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime/resolveTargetSelection')>();
  return {
    ...actual,
    resolveScopeAsync: vi.fn(actual.resolveScopeAsync),
    resolveTargetSelectionAsync: vi.fn(actual.resolveTargetSelectionAsync),
  };
});

const projectRoot = '/project';

afterEach(() => {
  vi.resetAllMocks();
});

describe('bootDevice', () => {
  // smoke-acquires-without-bootDevice
  it(`binds this worktree's simulator on iOS and boots nothing itself`, async () => {
    vi.mocked(acquireDeviceAsync).mockResolvedValue({
      device: {
        backend: 'local-ios',
        platform: 'ios',
        udid: 'SIM-1',
        name: 'agent-cli 0000',
        origin: 'created',
      },
      justBooted: true,
      action: 'created',
    });

    const result = await buildSmokeDeps(projectRoot, resolveSmokeOptions(['--ios'])).bootDevice();

    expect(acquireDeviceAsync).toHaveBeenCalledWith(projectRoot, 'ios');
    expect(result).toEqual({
      ok: true,
      deviceId: 'SIM-1',
      backend: 'local-ios',
      choice: 'agent-cli 0000',
      installNeeded: true,
      reason: null,
      bound: { name: 'agent-cli 0000', action: 'created' },
    });
  });

  it(`binds this worktree's emulator instance on Android, which needs the app installed`, async () => {
    vi.mocked(acquireDeviceAsync).mockResolvedValue({
      device: {
        backend: 'local-android',
        platform: 'android',
        serial: 'emulator-5556',
        origin: { kind: 'spawned', avd: 'Pixel_9', port: 5556, emulatorPid: 4242 },
      },
      justBooted: true,
      action: 'spawned',
    });

    const result = await buildSmokeDeps(
      projectRoot,
      resolveSmokeOptions(['--android'])
    ).bootDevice();

    expect(acquireDeviceAsync).toHaveBeenCalledWith(projectRoot, 'android');
    expect(result).toMatchObject({
      ok: true,
      deviceId: 'emulator-5556',
      backend: 'local-android',
      installNeeded: true,
    });
  });

  it.each([
    [
      'emulator-5556',
      { kind: 'spawned', avd: 'Pixel_9', port: 5556, emulatorPid: 4242 } as const,
      'Pixel_9',
    ],
    ['R58N123', { kind: 'explicit' } as const, null],
  ])(
    'names the AVD of a spawned instance as the choice, and nothing for an explicit serial: %s',
    async (serial, origin, choice) => {
      vi.mocked(acquireDeviceAsync).mockResolvedValue({
        device: { backend: 'local-android', platform: 'android', serial, origin },
        justBooted: true,
        action: 'reused',
      });

      const result = await buildSmokeDeps(
        projectRoot,
        resolveSmokeOptions(['--android'])
      ).bootDevice();

      expect(result).toMatchObject({ ok: true, deviceId: serial, choice });
    }
  );

  it(`reports the registry's refusal as a boot that failed`, async () => {
    vi.mocked(acquireDeviceAsync).mockRejectedValue(
      Object.assign(new Error('No iOS runtime with an iPhone is installed.\nHow: install one.'), {
        code: 'DEVICE_UNAVAILABLE',
      })
    );

    const result = await buildSmokeDeps(projectRoot, resolveSmokeOptions(['--ios'])).bootDevice();

    expect(result).toMatchObject({
      ok: false,
      deviceId: null,
      reason: 'No iOS runtime with an iPhone is installed. How: install one.',
    });
  });

  it(`binds nothing under AGENT_CLI_NO_DEVICE and says so`, async () => {
    process.env.AGENT_CLI_NO_DEVICE = '1';
    try {
      const result = await buildSmokeDeps(
        projectRoot,
        resolveSmokeOptions(['--android'])
      ).bootDevice();

      expect(acquireDeviceAsync).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('android') });
    } finally {
      delete process.env.AGENT_CLI_NO_DEVICE;
    }
  });
});

it('smoke releases only its acquired platform and binding', async () => {
  const { androidBindingFor } = await import('../../deviceBinding/__tests__/fakeTools');
  const binding = androidBindingFor(projectRoot, 'emulator-5554', { kind: 'explicit' });
  vi.mocked(acquireDeviceAsync).mockResolvedValue({
    binding,
    device: binding.device,
    action: 'reused',
    justBooted: false,
  });
  vi.mocked(releaseWorktreeDevicesAsync).mockResolvedValue([]);
  const deps = buildSmokeDeps(projectRoot, resolveSmokeOptions(['--android']));
  await deps.bootDevice();
  await deps.releaseDevice();
  expect(releaseWorktreeDevicesAsync).toHaveBeenCalledWith(projectRoot, {
    platform: 'android',
    expected: binding,
  });
});

describe(deviceBoundByStart, () => {
  it.each([
    ['created', null, bindingFor(projectRoot, 'SIM-NEW', { name: 'agent-cli 0000' })],
    ['reused', bindingFor(projectRoot, 'SIM-OLD'), bindingFor(projectRoot, 'SIM-OLD')],
    [
      'spawned',
      null,
      androidBindingFor(projectRoot, 'emulator-5556', {
        kind: 'spawned',
        avd: 'Pixel_9',
        port: 5556,
        emulatorPid: 4242,
      }),
    ],
  ] as const)(
    'reads a %s device from the binding the detached dev wrote',
    (action, before, after) => {
      expect(deviceBoundByStart(before, after, false)).toEqual({
        id: deviceIdOf(after.device),
        name: deviceNameOf(after.device),
        action,
      });
    }
  );

  it('reads the device as existing when its binding was live and up before the start', () => {
    const binding = bindingFor(projectRoot, 'SIM-OLD');
    expect(deviceBoundByStart(binding, binding, true)).toEqual({
      id: 'SIM-OLD',
      name: deviceNameOf(binding.device),
      action: 'existing',
    });
  });

  it('reads no device when the start left no binding', () => {
    expect(deviceBoundByStart(bindingFor(projectRoot, 'SIM-OLD'), null, false)).toBeUndefined();
  });
});

describe(cleanupLeft, () => {
  const device = {
    id: 'SIM-1',
    name: 'agent-cli 0000',
    action: 'created',
    shutDown: true,
  } as const;
  const environment = (overrides: Partial<SmokeEnvironmentJson>): SmokeEnvironmentJson => ({
    devServer: 'reused',
    device: 'booted',
    deviceChoice: null,
    boundDevice: null,
    cleanup: [],
    ...overrides,
  });

  it('keeps the reused dev server apart from the device the run released', () => {
    expect(
      cleanupLeft(
        environment({
          boundDevice: { ...device, released: true },
          cleanup: [{ resource: 'device', target: 'SIM-1', ok: true, reason: null, ms: 1 }],
        })
      )
    ).toEqual({ serverStopped: false, deviceReleased: true });
  });

  it('reports the dev server this run stopped', () => {
    expect(
      cleanupLeft(
        environment({
          devServer: 'started',
          boundDevice: { ...device, released: true },
          cleanup: [
            {
              resource: 'dev-server',
              target: 'http://127.0.0.1:8081',
              ok: true,
              reason: null,
              ms: 1,
            },
          ],
        })
      )
    ).toEqual({ serverStopped: true, deviceReleased: true });
  });

  it('reports a device the run did not bind as not released', () => {
    expect(
      cleanupLeft(
        environment({
          device: 'reused',
          boundDevice: { ...device, action: 'existing', released: null },
        })
      )
    ).toEqual({ serverStopped: false, deviceReleased: false });
  });
});

// @ref llp/0035-one-device-per-worktree.rfc.md §Session binding
describe('ensureEasSession with no EAS build to install', () => {
  const eas = () => buildSmokeDeps(projectRoot, resolveSmokeOptions(['--ios', '--eas']));
  const file = bindingPathFor(projectRoot, 'ios', 'cloud');

  beforeEach(() => {
    vol.reset();
    vi.mocked(lookUpEasSimulatorBuildAsync).mockResolvedValue(null);
    vi.mocked(resolveEasCli).mockReturnValue({
      command: 'eas',
      prefixArgs: [],
      source: 'eas',
    } as any);
  });

  it(`starts no session when none is up, with smoke's reason and no tunnel wait`, async () => {
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(cloudProbe.none());

    const result = await eas().ensureEasSession('http://127.0.0.1:8081');

    expect(result).toEqual({
      ok: false,
      sessionId: null,
      started: false,
      reason: `no EAS Simulator session is up, and EAS has no finished "development-simulator" build of this project's ios fingerprint to start one with — "${PROGRAM_PREFIX} dev --ios --eas" builds it and starts the session; this gate compiles nothing`,
    });
    expect(lookUpEasSimulatorBuildAsync).toHaveBeenCalledTimes(1);
    // No tunnel wait: the build lookup comes before it.
    expect(fetchAdvertisedUrlAsync).not.toHaveBeenCalled();
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
    expect(readBindingFile(file)).toEqual({ kind: 'none' });
  });

  it('keeps the session returned by ensure for subsequent device reads', async () => {
    vi.mocked(ensureGitExcludedAsync).mockResolvedValue({ result: 'already' });
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(
      cloudProbe.active({ id: 'session-ready', platform: 'ios' })
    );
    const deps = eas();
    expect(await deps.ensureEasSession('http://127.0.0.1:8081')).toMatchObject({
      ok: true,
      sessionId: 'session-ready',
    });
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(cloudProbe.unknown());
    expect(await deps.probeDevice()).toEqual({
      deviceId: 'session-ready',
      backend: 'cloud',
      reason: null,
    });
  });
});

describe('evaluate beside an app of another worktree', () => {
  const realFetch = globalThis.fetch;
  const CLONE = 'agent-cli c4ed0a60';
  const ON_CLONE = {
    id: '1',
    appId: 'host.exp.Exponent',
    deviceName: CLONE,
    webSocketDebuggerUrl: 'ws://127.0.0.1:1/inspector/debug?device=1&page=1',
  };

  afterEach(() => {
    globalThis.fetch = realFetch;
    vol.reset();
  });

  it(`skips that app, and names the worktree that bound its simulator`, async () => {
    vol.fromJSON({ [`${projectRoot}/package.json`]: '{}', '/wt/legend/package.json': '{}' });
    seedIosBinding('/wt/legend', 'SIM-LEGEND', CLONE);
    vi.mocked(spawnCaptureAsync).mockResolvedValue({
      stdout: JSON.stringify({ devices: { 'iOS-26-0': [{ udid: 'SIM-LEGEND', name: CLONE }] } }),
      stderr: '',
      exitCode: 0,
    });
    let listed: unknown[] = [];
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => listed,
    })) as unknown as typeof fetch;
    const deps = buildSmokeDeps(projectRoot, resolveSmokeOptions(['--ios']));
    await deps.evaluate('http://127.0.0.1:8081');
    listed = [ON_CLONE];

    const result = await deps.evaluate('http://127.0.0.1:8081');

    expect(result.reason).toContain(
      describeSkippedApps([
        { deviceName: CLONE, group: 'other-worktree', projectRoots: ['/wt/legend'] },
      ])
    );
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
  it('waitForAppConnection reports the skipped apps and prints nothing, however many waits a run makes', async () => {
    mockPlatform('darwin');
    vol.fromJSON({ [`${projectRoot}/package.json`]: '{}', '/wt/legend/package.json': '{}' });
    seedIosBinding('/wt/legend', 'SIM-LEGEND', CLONE);
    vi.mocked(spawnCaptureAsync).mockResolvedValue({
      stdout: JSON.stringify({
        devices: {
          'iOS-26-0': [
            { udid: 'SIM-LEGEND', name: CLONE, state: 'Booted' },
            { udid: 'SIM-OWN', name: 'iPhone 17 Pro', state: 'Booted' },
          ],
        },
      }),
      stderr: '',
      exitCode: 0,
    });
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => [ON_CLONE, { ...ON_CLONE, id: '2', deviceName: 'iPhone 17 Pro' }],
    })) as unknown as typeof fetch;
    const deps = buildSmokeDeps(projectRoot, resolveSmokeOptions(['--ios']));

    const first = await deps.waitForAppConnection('http://127.0.0.1:8081', 300);
    const second = await deps.waitForAppConnection('http://127.0.0.1:8081', 300);

    expect(second.skippedApps).toEqual(first.skippedApps);
    expect(first.skippedApps).toHaveLength(1);
    expect(vi.mocked(Log.progress)).not.toHaveBeenCalled();
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads
describe('reloadApp beside a local simulator, on a bound EAS session', () => {
  const realFetch = globalThis.fetch;
  const SESSION: TargetSelection = {
    platform: { value: 'ios', by: 'bound-device' },
    device: { backend: 'cloud', deviceId: 'session-1' },
    bound: true,
  };
  const target = (id: string, deviceName: string) =>
    makeTarget({ id, appId: 'host.exp.Exponent', deviceName });
  const targets = [target('local', 'iPhone 16e'), target('session', 'iPhone 17')];

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it(`keeps the placement the app phase made when simctl fails on the read before rung 1`, async () => {
    const deviceInventory = makeDeviceInventory({
      booted: [{ name: 'iPhone 16e', udid: 'SIM-1' }],
    });
    vi.mocked(resolveScopeAsync).mockResolvedValue(SESSION);
    vi.mocked(resolveTargetSelectionAsync).mockResolvedValue({
      targetSelection: SESSION,
      deviceInventory,
      classifiedTargets: classifyTargets(targets, SESSION, deviceInventory),
    });
    vi.mocked(spawnCaptureAsync).mockResolvedValue({ stdout: '', stderr: 'failed', exitCode: 1 });
    globalThis.fetch = (async () => ({ ok: true, json: async () => targets })) as never;
    const deps = buildSmokeDeps(projectRoot, resolveSmokeOptions(['--ios']));
    await deps.waitForAppConnection('http://127.0.0.1:8081', 1000);

    const result = await deps.reloadApp('http://127.0.0.1:8081', 1000);

    expect(result.targetOutcomes.map((each) => each.targetId)).toEqual(['session']);
  });
});
