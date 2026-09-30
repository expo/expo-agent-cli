// @ref llp/0028-one-device-per-agent.rfc.md §Every verb uses the claim
import { vol } from 'memfs';
import path from 'path';

import { readClaims, writeClaim } from '../../deviceClaims';
import { newestIosRuntime, resolveClaimedDeviceAsync } from '../claimedDevice';
import { simulatorHasAppAsync } from '../installedApps';
import { adbDevices, fakeDeviceTools, simctlDevices } from './fakeDeviceTools';

vi.mock('../installedApps', () => ({ simulatorHasAppAsync: vi.fn(async () => false) }));

vi.mock('../../deviceClaims/events', () => ({
  event: vi.fn(),
  debugEvent: Object.assign(vi.fn(), { error: vi.fn((error) => error) }),
}));
vi.mock('../bootDevice', async (importOriginal) => {
  const original = await importOriginal<typeof import('../bootDevice')>();
  return {
    ...original,
    // No bind test: the machine running the tests may have an emulator of its own on 5554.
    findFreeEmulatorPortAsync: async ({
      skip = () => false,
    }: { skip?: (port: number) => boolean } = {}) => {
      for (let port = 5554; port <= 5584; port += 2) {
        if (!skip(port)) {
          return port;
        }
      }
      return null;
    },
  };
});

const HERE = path.resolve('/work/here');
const OTHER = path.resolve('/work/other');

beforeEach(() => {
  vol.mkdirSync(HERE, { recursive: true });
  vol.mkdirSync(OTHER, { recursive: true });
  process.env.EXPO_AGENT_MAX_DEVICES = '4';
});

afterEach(() => {
  vol.reset();
  delete process.env.EXPO_AGENT_MAX_DEVICES;
});

/** Two shut-down iPhones; `simctl boot` flips one to booted, as the real tool does. */
function fakeSimulators(
  initial: { udid: string; name: string; state: 'Booted' | 'Shutdown' }[] = [
    { udid: 'SIM-A', name: 'iPhone 17', state: 'Shutdown' },
    { udid: 'SIM-B', name: 'iPhone 17 Pro', state: 'Shutdown' },
  ]
) {
  const devices = initial.map((device) => ({ ...device }));
  const tools = fakeDeviceTools((command, args) => {
    if (command !== 'xcrun') {
      return { spawnError: 'ENOENT' };
    }
    const [, verb, ...rest] = args;
    if (verb === 'list' && rest[0] === 'devices') {
      return { stdout: simctlDevices(devices) };
    }
    if (verb === 'list' && rest[0] === 'runtimes') {
      return {
        stdout: JSON.stringify({
          runtimes: [
            runtime('com.apple.CoreSimulator.SimRuntime.iOS-18-0', '18.0'),
            runtime('com.apple.CoreSimulator.SimRuntime.iOS-26-0', '26.0'),
          ],
        }),
      };
    }
    if (verb === 'boot') {
      devices.find((device) => device.udid === rest[0])!.state = 'Booted';
      return {};
    }
    if (verb === 'create') {
      devices.push({ udid: 'SIM-NEW', name: rest[0]!, state: 'Shutdown' });
      return { stdout: 'SIM-NEW\n' };
    }
    return {};
  });
  return { tools, devices };
}

function runtime(identifier: string, version: string) {
  return {
    identifier,
    version,
    platform: 'iOS',
    isAvailable: true,
    supportedDeviceTypes: [
      { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro', productFamily: 'iPad' },
      { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', productFamily: 'iPhone' },
      { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16', productFamily: 'iPhone' },
    ],
  };
}

const LONG_AGO = new Date(Date.now() - 3 * 60 * 60_000).toISOString();

function ownClaim(id: string, at: string) {
  return {
    backend: 'local-ios' as const,
    platform: 'ios' as const,
    id,
    projectRoot: HERE,
    pid: 1,
    claimedAt: at,
    touchedAt: at,
    created: false,
  };
}

function otherClaim(id: string, backend: 'local-ios' | 'local-android' = 'local-ios') {
  const now = new Date().toISOString();
  writeClaim({
    backend,
    platform: backend === 'local-ios' ? 'ios' : 'android',
    id,
    projectRoot: OTHER,
    pid: 1,
    claimedAt: now,
    touchedAt: now,
    created: false,
  });
}

describe(`${resolveClaimedDeviceAsync.name} on iOS`, () => {
  it(`gives two worktrees two different simulators, and boots each`, async () => {
    const { tools } = fakeSimulators();
    const here = await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: true,
    });
    const other = await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: OTHER,
      allowBoot: true,
    });

    expect(here).toMatchObject({ ok: true, booted: true });
    expect(other).toMatchObject({ ok: true, booted: true });
    expect(here.ok && other.ok && here.id !== other.id).toBe(true);
    expect(tools.callsWith('simctl boot ').sort()).toEqual([
      'xcrun simctl boot SIM-A',
      'xcrun simctl boot SIM-B',
    ]);
    expect(
      readClaims()
        .map(({ id, projectRoot }) => [id, projectRoot])
        .sort()
    ).toEqual(
      [
        [here.ok && here.id, HERE],
        [other.ok && other.id, OTHER],
      ].sort()
    );
  });

  it(`reuses the worktree's own simulator on the next call, and boots nothing`, async () => {
    const { tools } = fakeSimulators();
    const first = await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: true,
    });
    const again = await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: false,
    });

    expect(again).toMatchObject({
      ok: true,
      booted: false,
      choice: 'this worktree claimed it already',
    });
    expect(first.ok && again.ok && again.id === first.id).toBe(true);
    expect(tools.callsWith('simctl boot ')).toHaveLength(1);
  });

  it(`touches the worktree's claim when it hands the simulator out`, async () => {
    fakeSimulators([{ udid: 'SIM-A', name: 'iPhone 17', state: 'Booted' }]);
    writeClaim(ownClaim('SIM-A', LONG_AGO));

    const result = await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: false,
    });

    expect(result).toMatchObject({ ok: true, id: 'SIM-A' });
    expect(Date.parse(readClaims()[0]!.touchedAt)).toBeGreaterThan(Date.parse(LONG_AGO));
  });

  it(`does not re-arm a stale claim on a shut-down simulator that a read cannot use`, async () => {
    fakeSimulators([{ udid: 'SIM-A', name: 'iPhone 17', state: 'Shutdown' }]);
    writeClaim(ownClaim('SIM-A', LONG_AGO));

    const result = await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: false,
    });

    expect(result).toMatchObject({ ok: false, kind: 'no-device' });
    expect(readClaims()).toMatchObject([{ id: 'SIM-A', touchedAt: LONG_AGO }]);
  });

  it(`never takes a booted simulator another worktree claimed`, async () => {
    fakeSimulators([
      { udid: 'SIM-A', name: 'iPhone 17', state: 'Booted' },
      { udid: 'SIM-B', name: 'iPhone 17 Pro', state: 'Booted' },
    ]);
    otherClaim('SIM-A');
    expect(
      await resolveClaimedDeviceAsync({ platform: 'ios', projectRoot: HERE, allowBoot: false })
    ).toMatchObject({ ok: true, id: 'SIM-B', booted: false });
  });

  it(`with allowBoot false, boots nothing, claims nothing, and says no simulator is booted`, async () => {
    const { tools } = fakeSimulators();
    const result = await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: false,
    });

    expect(result).toMatchObject({
      ok: false,
      kind: 'no-device',
      reason: 'no booted iOS simulator was found',
      holders: [],
    });
    expect(tools.callsWith('simctl boot ')).toEqual([]);
    expect(readClaims()).toEqual([]);
  });

  it(`with allowBoot false, says so when every booted simulator is another worktree's`, async () => {
    fakeSimulators([
      { udid: 'SIM-A', name: 'iPhone 17', state: 'Booted' },
      { udid: 'SIM-B', name: 'iPhone 17 Pro', state: 'Shutdown' },
    ]);
    otherClaim('SIM-A');
    expect(
      await resolveClaimedDeviceAsync({ platform: 'ios', projectRoot: HERE, allowBoot: false })
    ).toMatchObject({
      ok: false,
      kind: 'no-device',
      reason: 'every booted iOS simulator is claimed by another worktree',
      holders: [{ id: 'SIM-A', projectRoot: OTHER }],
      error: { code: 'DEVICES_ALL_CLAIMED' },
    });
  });

  it(`takes the device --device names, by name, and claims it so no other worktree allocates it`, async () => {
    fakeSimulators();
    const named = await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: HERE,
      explicit: 'iPhone 17 Pro',
      allowBoot: true,
    });
    const other = await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: OTHER,
      allowBoot: true,
    });

    expect(named).toMatchObject({ ok: true, id: 'SIM-B', choice: '--device named it' });
    expect(other).toMatchObject({ ok: true, id: 'SIM-A' });
  });

  it(`gives up the worktree's previous simulator when --device names another`, async () => {
    fakeSimulators();
    await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: HERE,
      explicit: 'SIM-A',
      allowBoot: true,
    });
    await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: HERE,
      explicit: 'SIM-B',
      allowBoot: true,
    });
    expect(readClaims().map(({ id }) => id)).toEqual(['SIM-B']);
  });

  it(`keeps the worktree's booted simulator when a read names a shut-down one`, async () => {
    fakeSimulators([
      { udid: 'SIM-A', name: 'iPhone 17', state: 'Booted' },
      { udid: 'SIM-B', name: 'iPhone 17 Pro', state: 'Shutdown' },
    ]);
    await resolveClaimedDeviceAsync({ platform: 'ios', projectRoot: HERE, allowBoot: false });

    const result = await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: HERE,
      explicit: 'SIM-B',
      allowBoot: false,
    });

    expect(result).toMatchObject({ ok: false, kind: 'no-device' });
    expect(readClaims().map(({ id }) => id)).toEqual(['SIM-A']);
  });

  it(`refuses a --device another live worktree holds`, async () => {
    fakeSimulators();
    otherClaim('SIM-A');
    const result = await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: HERE,
      explicit: 'SIM-A',
      allowBoot: true,
    });
    expect(result).toMatchObject({ ok: false, kind: 'claimed' });
    expect(!result.ok && result.error.code).toBe('DEVICE_CLAIMED');
  });

  it(`refuses a --device this machine does not have`, async () => {
    fakeSimulators();
    const result = await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: HERE,
      explicit: 'Galaxy',
      allowBoot: true,
    });
    expect(!result.ok && result.error.code).toBe('DEVICE_NOT_FOUND');
  });

  it(`creates a simulator from the newest runtime when every one is claimed and there is room`, async () => {
    const { tools } = fakeSimulators([{ udid: 'SIM-A', name: 'iPhone 17', state: 'Booted' }]);
    otherClaim('SIM-A');
    const result = await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: true,
    });

    expect(result).toMatchObject({ ok: true, id: 'SIM-NEW', name: 'agent-cli 1', booted: true });
    expect(result.ok && result.claim.created).toBe(true);
    expect(tools.callsWith('simctl create')).toEqual([
      'xcrun simctl create agent-cli 1 com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-26-0',
    ]);
  });

  it(`marks a simulator this CLI created as created when it claims it again without a claim`, async () => {
    fakeSimulators([{ udid: 'SIM-NEW', name: 'agent-cli 1', state: 'Shutdown' }]);

    const result = await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: true,
    });

    expect(result).toMatchObject({ ok: true, id: 'SIM-NEW', claim: { created: true } });
    expect(readClaims()).toMatchObject([{ id: 'SIM-NEW', created: true }]);
  });

  it(`stops with DEVICES_ALL_CLAIMED at capacity, naming the holder`, async () => {
    process.env.EXPO_AGENT_MAX_DEVICES = '1';
    const { tools } = fakeSimulators([{ udid: 'SIM-A', name: 'iPhone 17', state: 'Booted' }]);
    otherClaim('SIM-A');
    const result = await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: true,
    });

    expect(result).toMatchObject({ ok: false, kind: 'exhausted' });
    expect(!result.ok && result.error.code).toBe('DEVICES_ALL_CLAIMED');
    expect(!result.ok && result.error.message).toContain(OTHER);
    expect(tools.callsWith('simctl create')).toEqual([]);
  });

  it(`names --eas when simctl cannot run`, async () => {
    fakeDeviceTools(() => ({ spawnError: 'ENOENT' }));
    const result = await resolveClaimedDeviceAsync({
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: true,
    });
    expect(result).toMatchObject({ ok: false, kind: 'no-tool' });
    expect(!result.ok && result.error.code).toBe('XCRUN_NOT_RUNNABLE');
    expect(!result.ok && result.error.message).toContain('--eas');
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §The device that can open the app. A dev-client
  // project booted a fresh simulator and the deep link came back `115` — no handler — after a
  // 12.4 s boot for a device that could never have opened it.
  it(`boots the free simulator that has the app before the one used more recently`, async () => {
    vi.mocked(simulatorHasAppAsync).mockImplementation(async (udid) => udid === 'SIM-B');
    fakeSimulators();
    expect(
      await resolveClaimedDeviceAsync({
        platform: 'ios',
        projectRoot: HERE,
        allowBoot: true,
        appId: 'com.example.app',
      })
    ).toMatchObject({
      ok: true,
      id: 'SIM-B',
      hasApp: true,
      choice: 'it has com.example.app installed',
    });
  });

  it(`with requireApp, declines to boot a simulator without the app, and keeps no claim`, async () => {
    vi.mocked(simulatorHasAppAsync).mockResolvedValue(false);
    const { tools } = fakeSimulators();
    expect(
      await resolveClaimedDeviceAsync({
        platform: 'ios',
        projectRoot: HERE,
        allowBoot: true,
        appId: 'com.example.app',
        requireApp: true,
      })
    ).toMatchObject({ ok: false, kind: 'no-app' });
    expect(tools.callsWith('simctl boot ')).toEqual([]);
    expect(readClaims()).toEqual([]);
  });
});

describe(`${resolveClaimedDeviceAsync.name} on Android`, () => {
  /** One AVD. An emulator shows up in `adb devices` once it was spawned on its port. */
  function fakeAndroid({ physical = [] as string[], avds = ['Pixel_8'] } = {}) {
    const running = new Map<string, string>();
    const tools = fakeDeviceTools((command, args) => {
      if (command === 'emulator' && args[0] === '-list-avds') {
        return { stdout: `${avds.join('\n')}\n` };
      }
      if (command === 'emulator' && args[0] === '-avd') {
        const port = args[args.indexOf('-ports') + 1]!.split(',')[0];
        running.set(`emulator-${port}`, args[1]!);
        return {};
      }
      if (command !== 'adb') {
        return { spawnError: 'ENOENT' };
      }
      if (args[0] === 'devices') {
        return {
          stdout: adbDevices([
            ...physical.map((serial) => ({ serial, model: 'Pixel_7' })),
            ...[...running.keys()].map((serial) => ({ serial, model: 'sdk_gphone64_arm64' })),
          ]),
        };
      }
      if (args.includes('avd') && args.includes('name')) {
        return { stdout: `${running.get(args[1]!)}\nOK\n` };
      }
      if (args.includes('sys.boot_completed')) {
        return { stdout: '1\n' };
      }
      return {};
    });
    return { tools, running };
  }

  it(`gives two worktrees two emulators on two ports, the second read-only`, async () => {
    const { tools } = fakeAndroid();
    const here = await resolveClaimedDeviceAsync({
      platform: 'android',
      projectRoot: HERE,
      allowBoot: true,
    });
    const other = await resolveClaimedDeviceAsync({
      platform: 'android',
      projectRoot: OTHER,
      allowBoot: true,
    });

    expect(here).toMatchObject({ ok: true, id: 'emulator-5554', name: 'Pixel_8', booted: true });
    expect(other).toMatchObject({ ok: true, id: 'emulator-5556', booted: true });
    expect(tools.callsWith('-avd ')).toEqual([
      'emulator -avd Pixel_8 -ports 5554,5555 -no-snapshot-save',
      'emulator -avd Pixel_8 -ports 5556,5557 -no-snapshot-save -read-only',
    ]);
  });

  it(`never allocates a physical device, and claims one --device names`, async () => {
    fakeAndroid({ physical: ['R58M123ABC'] });
    expect(
      await resolveClaimedDeviceAsync({ platform: 'android', projectRoot: HERE, allowBoot: false })
    ).toMatchObject({ ok: false, kind: 'no-device' });
    expect(
      await resolveClaimedDeviceAsync({
        platform: 'android',
        projectRoot: HERE,
        explicit: 'R58M123ABC',
        allowBoot: false,
      })
    ).toMatchObject({ ok: true, id: 'R58M123ABC', name: 'Pixel_7' });
    expect(
      await resolveClaimedDeviceAsync({ platform: 'android', projectRoot: HERE, allowBoot: false })
    ).toMatchObject({ ok: true, id: 'R58M123ABC', choice: 'this worktree claimed it already' });
  });

  it(`takes the free instance --device names when another worktree runs the same AVD`, async () => {
    const { running } = fakeAndroid();
    running.set('emulator-5554', 'Pixel_8');
    running.set('emulator-5556', 'Pixel_8');
    otherClaim('emulator-5554', 'local-android');

    expect(
      await resolveClaimedDeviceAsync({
        platform: 'android',
        projectRoot: HERE,
        explicit: 'Pixel_8',
        allowBoot: false,
      })
    ).toMatchObject({ ok: true, id: 'emulator-5556', choice: '--device named it' });
  });

  it(`ignores a dead worktree's claim on an emulator that never came up`, async () => {
    process.env.EXPO_AGENT_MAX_DEVICES = '1';
    const { tools } = fakeAndroid();
    writeClaim({
      backend: 'local-android',
      platform: 'android',
      id: 'emulator-5554',
      projectRoot: OTHER,
      pid: 1,
      claimedAt: LONG_AGO,
      touchedAt: LONG_AGO,
      created: false,
    });

    expect(
      await resolveClaimedDeviceAsync({ platform: 'android', projectRoot: HERE, allowBoot: true })
    ).toMatchObject({ ok: true, id: 'emulator-5554', booted: true });
    expect(tools.callsWith('-avd ')).toEqual([
      'emulator -avd Pixel_8 -ports 5554,5555 -no-snapshot-save',
    ]);
  });

  it(`never starts an emulator another worktree is starting on the same port`, async () => {
    fakeAndroid();
    otherClaim('emulator-5554', 'local-android');
    expect(
      await resolveClaimedDeviceAsync({ platform: 'android', projectRoot: HERE, allowBoot: true })
    ).toMatchObject({ ok: true, id: 'emulator-5556' });
  });
});

describe(newestIosRuntime, () => {
  it(`takes the newest available iOS runtime and its first iPhone, which is the newest`, () => {
    expect(
      newestIosRuntime(
        JSON.stringify({
          runtimes: [
            runtime('com.apple.CoreSimulator.SimRuntime.iOS-26-0', '26.0'),
            {
              ...runtime('com.apple.CoreSimulator.SimRuntime.iOS-27-0', '27.0'),
              isAvailable: false,
            },
            runtime('com.apple.CoreSimulator.SimRuntime.iOS-18-0', '18.0'),
          ],
        })
      )
    ).toEqual({
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
      deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
    });
  });
});
