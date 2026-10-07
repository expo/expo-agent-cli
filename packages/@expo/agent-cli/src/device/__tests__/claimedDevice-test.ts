// @ref llp/0030-one-device-per-agent.rfc.md §Every verb uses the claim
import fs from 'fs';
import { vol } from 'memfs';
import path from 'path';

import { claimFilePath, deviceRegistryDirectory, readClaims, writeClaim } from '../../deviceClaims';
import { debugEvent } from '../../deviceClaims/events';
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
  ],
  {
    onBoot,
    bootstatusExit = 0,
    onShutdown,
    shutdownExit = 0,
  }: {
    onBoot?: () => void;
    bootstatusExit?: number;
    onShutdown?: () => void;
    shutdownExit?: number;
  } = {}
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
      onBoot?.();
      devices.find((device) => device.udid === rest[0])!.state = 'Booted';
      return {};
    }
    if (verb === 'bootstatus') {
      return { exitCode: bootstatusExit };
    }
    if (verb === 'shutdown') {
      onShutdown?.();
      return shutdownExit === 0
        ? {}
        : { exitCode: shutdownExit, stderr: 'Unable to shutdown device in current state: Booted' };
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
    booted: false,
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
    booted: false,
  });
}

describe(`${resolveClaimedDeviceAsync.name} on iOS`, () => {
  it(`gives two worktrees two different simulators, and boots each`, async () => {
    const { tools } = fakeSimulators();
    const here = await resolveClaimedDeviceAsync({
      mode: 'claim',
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: true,
    });
    const other = await resolveClaimedDeviceAsync({
      mode: 'claim',
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
    expect(readClaims().map(({ booted }) => booted)).toEqual([true, true]);
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
      mode: 'claim',
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: true,
    });
    const again = await resolveClaimedDeviceAsync({
      mode: 'claim',
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
      mode: 'claim',
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
      mode: 'claim',
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: false,
    });

    expect(result).toMatchObject({ ok: false, kind: 'no-device' });
    expect(readClaims()).toMatchObject([{ id: 'SIM-A', touchedAt: LONG_AGO }]);
  });

  it(`answers unavailable, not no-device, when simctl cannot list the simulators`, async () => {
    fakeDeviceTools(() => ({
      exitCode: 1,
      stderr: 'CoreSimulatorService connection became invalid',
    }));

    const result = await resolveClaimedDeviceAsync({
      mode: 'claim',
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: true,
    });

    expect(result).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(!result.ok && result.error.code).toBe('DEVICE_UNAVAILABLE');
    expect(!result.ok && result.error.message).toContain('CoreSimulatorService');
  });

  it(`refuses the simulator when another worktree took its claim over during the boot`, async () => {
    fakeSimulators([{ udid: 'SIM-A', name: 'iPhone 17', state: 'Shutdown' }], {
      onBoot: () => {
        vol.rmSync(claimFilePath('local-ios', 'SIM-A'));
        otherClaim('SIM-A');
      },
    });
    const result = await resolveClaimedDeviceAsync({
      mode: 'claim',
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: true,
    });

    expect(result).toMatchObject({
      ok: false,
      kind: 'claimed',
      deviceId: 'SIM-A',
      error: { code: 'DEVICE_CLAIMED' },
    });
    expect(!result.ok && result.error.message).toContain(OTHER);
    expect(readClaims()).toMatchObject([{ id: 'SIM-A', projectRoot: OTHER }]);
    expect(debugEvent).not.toHaveBeenCalledWith('device_claim_touch_failed', expect.anything());
  });

  it(`refuses the simulator when its claim was released during the boot`, async () => {
    fakeSimulators([{ udid: 'SIM-A', name: 'iPhone 17', state: 'Shutdown' }], {
      onBoot: () => vol.rmSync(claimFilePath('local-ios', 'SIM-A')),
    });
    const result = await resolveClaimedDeviceAsync({
      mode: 'claim',
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: true,
    });

    expect(result).toMatchObject({ ok: false, kind: 'no-device', deviceId: 'SIM-A' });
    expect(readClaims()).toEqual([]);
  });

  it(`goes on with the simulator when only the touch failed and the claim is still its own`, async () => {
    fakeSimulators([{ udid: 'SIM-A', name: 'iPhone 17', state: 'Booted' }]);
    writeClaim(ownClaim('SIM-A', LONG_AGO));
    const spy = vi.spyOn(fs, 'utimesSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });

    try {
      expect(
        await resolveClaimedDeviceAsync({
          mode: 'claim',
          platform: 'ios',
          projectRoot: HERE,
          allowBoot: false,
        })
      ).toMatchObject({ ok: true, id: 'SIM-A', claim: { projectRoot: HERE } });
    } finally {
      spy.mockRestore();
    }
    expect(debugEvent).toHaveBeenCalledWith(
      'device_claim_touch_failed',
      expect.objectContaining({ id: 'SIM-A' })
    );
  });

  it(`records the boot in the claim before it waits for the simulator`, async () => {
    let during: unknown;
    fakeSimulators([{ udid: 'SIM-A', name: 'iPhone 17', state: 'Shutdown' }], {
      onBoot: () => {
        during = readClaims()[0];
      },
    });

    await resolveClaimedDeviceAsync({
      mode: 'claim',
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: true,
    });

    expect(during).toMatchObject({ id: 'SIM-A', projectRoot: HERE, booted: true });
  });

  it(`shuts down a simulator whose boot did not finish, and releases its fresh claim, under the lock`, async () => {
    let lockedAtShutdown = false;
    const { tools } = fakeSimulators([{ udid: 'SIM-A', name: 'iPhone 17', state: 'Shutdown' }], {
      bootstatusExit: 1,
      onShutdown: () => {
        lockedAtShutdown = vol.existsSync(path.join(deviceRegistryDirectory(), '.lock'));
      },
    });

    const result = await resolveClaimedDeviceAsync({
      mode: 'claim',
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: true,
    });

    expect(result).toMatchObject({ ok: false, kind: 'boot-failed', deviceId: 'SIM-A' });
    expect(tools.callsWith('simctl shutdown')).toEqual(['xcrun simctl shutdown SIM-A']);
    expect(lockedAtShutdown).toBe(true);
    expect(readClaims()).toEqual([]);
  });

  it(`keeps its own claim, marked booted, when a boot of its claimed simulator failed`, async () => {
    fakeSimulators([{ udid: 'SIM-A', name: 'iPhone 17', state: 'Shutdown' }], {
      bootstatusExit: 1,
    });
    writeClaim(ownClaim('SIM-A', new Date().toISOString()));

    await resolveClaimedDeviceAsync({
      mode: 'claim',
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: true,
    });

    expect(readClaims()).toMatchObject([{ id: 'SIM-A', projectRoot: HERE, booted: true }]);
  });

  // @ref llp/0030-one-device-per-agent.rfc.md §Release and cleanup
  it(`reaps the simulator of a deleted worktree before it allocates, inside the grace period`, async () => {
    const { tools } = fakeSimulators([
      { udid: 'SIM-A', name: 'iPhone 17', state: 'Booted' },
      { udid: 'SIM-B', name: 'iPhone 17 Pro', state: 'Shutdown' },
    ]);
    const now = new Date().toISOString();
    writeClaim({
      backend: 'local-ios',
      platform: 'ios',
      id: 'SIM-A',
      projectRoot: path.resolve('/work/deleted'),
      pid: 1,
      claimedAt: now,
      touchedAt: now,
      created: false,
      booted: true,
    });
    const progress = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await resolveClaimedDeviceAsync({
      mode: 'claim',
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: false,
    });

    expect(tools.callsWith('simctl shutdown SIM-A')).toHaveLength(1);
    expect(progress.mock.calls.flat().join('')).toContain(
      `Reaped SIM-A of the deleted worktree ${path.resolve('/work/deleted')} · shut down, claim dropped.`
    );
    progress.mockRestore();
    expect(result.ok).toBe(true);
    expect(readClaims().map(({ projectRoot }) => projectRoot)).toEqual([HERE]);
  });

  it(`never takes a booted simulator another worktree claimed`, async () => {
    fakeSimulators([
      { udid: 'SIM-A', name: 'iPhone 17', state: 'Booted' },
      { udid: 'SIM-B', name: 'iPhone 17 Pro', state: 'Booted' },
    ]);
    otherClaim('SIM-A');
    expect(
      await resolveClaimedDeviceAsync({
        mode: 'claim',
        platform: 'ios',
        projectRoot: HERE,
        allowBoot: false,
      })
    ).toMatchObject({ ok: true, id: 'SIM-B', booted: false });
    expect(readClaims().find(({ id }) => id === 'SIM-B')).toMatchObject({ booted: false });
  });

  it(`with allowBoot false, boots nothing, claims nothing, and says no simulator is booted`, async () => {
    const { tools } = fakeSimulators();
    const result = await resolveClaimedDeviceAsync({
      mode: 'claim',
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
      await resolveClaimedDeviceAsync({
        mode: 'claim',
        platform: 'ios',
        projectRoot: HERE,
        allowBoot: false,
      })
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
      mode: 'claim',
      platform: 'ios',
      projectRoot: HERE,
      explicit: 'iPhone 17 Pro',
      allowBoot: true,
    });
    const other = await resolveClaimedDeviceAsync({
      mode: 'claim',
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
      mode: 'claim',
      platform: 'ios',
      projectRoot: HERE,
      explicit: 'SIM-A',
      allowBoot: true,
    });
    await resolveClaimedDeviceAsync({
      mode: 'claim',
      platform: 'ios',
      projectRoot: HERE,
      explicit: 'SIM-B',
      allowBoot: true,
    });
    expect(readClaims().map(({ id }) => id)).toEqual(['SIM-B']);
  });

  it(`shuts down the simulator it booted, under the lock, before --device gives it up`, async () => {
    let atShutdown: { locked: boolean; claims: string[] } | null = null;
    const { tools } = fakeSimulators(undefined, {
      onShutdown: () => {
        atShutdown = {
          locked: vol.existsSync(path.join(deviceRegistryDirectory(), '.lock')),
          claims: readClaims()
            .map(({ id }) => id)
            .sort(),
        };
      },
    });
    for (const explicit of ['SIM-A', 'SIM-B']) {
      await resolveClaimedDeviceAsync({
        mode: 'claim',
        platform: 'ios',
        projectRoot: HERE,
        explicit,
        allowBoot: true,
      });
    }

    expect(tools.callsWith('simctl shutdown')).toEqual(['xcrun simctl shutdown SIM-A']);
    expect(atShutdown).toEqual({ locked: true, claims: ['SIM-A', 'SIM-B'] });
    expect(readClaims().map(({ id }) => id)).toEqual(['SIM-B']);
  });

  it(`leaves up a simulator it did not boot when --device gives it up`, async () => {
    const { tools } = fakeSimulators([
      { udid: 'SIM-A', name: 'iPhone 17', state: 'Booted' },
      { udid: 'SIM-B', name: 'iPhone 17 Pro', state: 'Booted' },
    ]);
    for (const explicit of ['SIM-A', 'SIM-B']) {
      await resolveClaimedDeviceAsync({
        mode: 'claim',
        platform: 'ios',
        projectRoot: HERE,
        explicit,
        allowBoot: true,
      });
    }

    expect(tools.callsWith('simctl shutdown')).toEqual([]);
    expect(readClaims().map(({ id }) => id)).toEqual(['SIM-B']);
  });

  it(`gives up the previous simulator when its shutdown failed, and says so`, async () => {
    fakeSimulators(undefined, { shutdownExit: 1 });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (const explicit of ['SIM-A', 'SIM-B']) {
        await resolveClaimedDeviceAsync({
          mode: 'claim',
          platform: 'ios',
          projectRoot: HERE,
          explicit,
          allowBoot: true,
        });
      }

      expect(readClaims().map(({ id }) => id)).toEqual(['SIM-B']);
      expect(stderr.mock.calls.map(([text]) => String(text)).join('')).toContain(
        'SIM-A, which --device replaced, is still up: "xcrun simctl shutdown SIM-A" exited 1'
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it(`keeps the worktree's booted simulator when a read names a shut-down one`, async () => {
    fakeSimulators([
      { udid: 'SIM-A', name: 'iPhone 17', state: 'Booted' },
      { udid: 'SIM-B', name: 'iPhone 17 Pro', state: 'Shutdown' },
    ]);
    await resolveClaimedDeviceAsync({
      mode: 'claim',
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: false,
    });

    const result = await resolveClaimedDeviceAsync({
      mode: 'claim',
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
      mode: 'claim',
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
      mode: 'claim',
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
      mode: 'claim',
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
      mode: 'claim',
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
      mode: 'claim',
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
      mode: 'claim',
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
        mode: 'claim',
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
        mode: 'claim',
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

describe(`${resolveClaimedDeviceAsync.name} with an app to open`, () => {
  it(`with requireApp, creates no simulator, because a new one has no app`, async () => {
    vi.mocked(simulatorHasAppAsync).mockResolvedValue(false);
    const { tools } = fakeSimulators([{ udid: 'SIM-A', name: 'iPhone 17', state: 'Booted' }]);
    otherClaim('SIM-A');

    const result = await resolveClaimedDeviceAsync({
      mode: 'claim',
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: true,
      appId: 'com.example.app',
      requireApp: true,
    });

    expect(result.ok).toBe(false);
    expect(tools.callsWith('simctl create')).toEqual([]);
    expect(tools.callsWith('simctl boot ')).toEqual([]);
    expect(readClaims()).toMatchObject([{ id: 'SIM-A', projectRoot: OTHER }]);
  });

  it(`says a simulator it created has not got the app, so the caller installs it`, async () => {
    vi.mocked(simulatorHasAppAsync).mockResolvedValue(false);
    fakeSimulators([{ udid: 'SIM-A', name: 'iPhone 17', state: 'Booted' }]);
    otherClaim('SIM-A');

    expect(
      await resolveClaimedDeviceAsync({
        mode: 'claim',
        platform: 'ios',
        projectRoot: HERE,
        allowBoot: true,
        appId: 'com.example.app',
      })
    ).toMatchObject({ ok: true, id: 'SIM-NEW', hasApp: false });
  });
});

describe(`${resolveClaimedDeviceAsync.name} on Android`, () => {
  /** What the CLI spawns for the emulator on this host: `emulator.exe` on Windows. */
  const EMULATOR = process.platform === 'win32' ? 'emulator.exe' : 'emulator';

  /**
   * One AVD. An emulator shows up in `adb devices` once it was spawned on its port. With `foreign`,
   * another process's emulator of that AVD takes the port first, and the one spawned exits 1.
   */
  function fakeAndroid({
    physical = [] as string[],
    avds = ['Pixel_8'],
    boots = true,
    listed = true,
    foreign = null as string | null,
  } = {}) {
    const running = new Map<string, string>();
    const tools = fakeDeviceTools((spawned, args) => {
      const command = path.basename(spawned, '.exe');
      if (command === 'emulator' && args[0] === '-list-avds') {
        return { stdout: `${avds.join('\n')}\n` };
      }
      if (command === 'emulator' && args[0] === '-avd') {
        const port = args[args.indexOf('-ports') + 1]!.split(',')[0];
        if (foreign != null) {
          running.set(`emulator-${port}`, foreign);
          return { exitCode: 1 };
        }
        if (listed) {
          running.set(`emulator-${port}`, args[1]!);
        }
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
        return boots ? { stdout: '1\n' } : { stdout: '\n' };
      }
      if (args.includes('emu') && args.includes('kill')) {
        return running.has(args[1]!)
          ? {}
          : { exitCode: 1, stderr: `error: device '${args[1]}' not found` };
      }
      return {};
    });
    return { tools, running };
  }

  it(`gives two worktrees two emulators on two ports, the second read-only`, async () => {
    const { tools } = fakeAndroid();
    const here = await resolveClaimedDeviceAsync({
      mode: 'claim',
      platform: 'android',
      projectRoot: HERE,
      allowBoot: true,
    });
    const other = await resolveClaimedDeviceAsync({
      mode: 'claim',
      platform: 'android',
      projectRoot: OTHER,
      allowBoot: true,
    });

    expect(here).toMatchObject({ ok: true, id: 'emulator-5554', name: 'Pixel_8', booted: true });
    expect(other).toMatchObject({ ok: true, id: 'emulator-5556', booted: true });
    expect(tools.callsWith('-avd ')).toEqual([
      `${EMULATOR} -avd Pixel_8 -ports 5554,5555 -no-snapshot-save`,
      `${EMULATOR} -avd Pixel_8 -ports 5556,5557 -no-snapshot-save -read-only`,
    ]);
  });

  it(`never allocates a physical device, and claims one --device names`, async () => {
    fakeAndroid({ physical: ['R58M123ABC'] });
    expect(
      await resolveClaimedDeviceAsync({
        mode: 'claim',
        platform: 'android',
        projectRoot: HERE,
        allowBoot: false,
      })
    ).toMatchObject({ ok: false, kind: 'no-device' });
    expect(
      await resolveClaimedDeviceAsync({
        mode: 'claim',
        platform: 'android',
        projectRoot: HERE,
        explicit: 'R58M123ABC',
        allowBoot: false,
      })
    ).toMatchObject({ ok: true, id: 'R58M123ABC', name: 'Pixel_7' });
    expect(
      await resolveClaimedDeviceAsync({
        mode: 'claim',
        platform: 'android',
        projectRoot: HERE,
        allowBoot: false,
      })
    ).toMatchObject({ ok: true, id: 'R58M123ABC', choice: 'this worktree claimed it already' });
  });

  it(`takes the free instance --device names when another worktree runs the same AVD`, async () => {
    const { running } = fakeAndroid();
    running.set('emulator-5554', 'Pixel_8');
    running.set('emulator-5556', 'Pixel_8');
    otherClaim('emulator-5554', 'local-android');

    expect(
      await resolveClaimedDeviceAsync({
        mode: 'claim',
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
      booted: false,
    });

    expect(
      await resolveClaimedDeviceAsync({
        mode: 'claim',
        platform: 'android',
        projectRoot: HERE,
        allowBoot: true,
      })
    ).toMatchObject({ ok: true, id: 'emulator-5554', booted: true });
    expect(tools.callsWith('-avd ')).toEqual([
      `${EMULATOR} -avd Pixel_8 -ports 5554,5555 -no-snapshot-save`,
    ]);
  });

  it(`shuts down an emulator whose boot timed out, and releases its fresh claim`, async () => {
    const { tools } = fakeAndroid({ boots: false });

    const result = await resolveClaimedDeviceAsync({
      mode: 'claim',
      platform: 'android',
      projectRoot: HERE,
      allowBoot: true,
      timeoutMs: 0,
    });

    expect(result).toMatchObject({ ok: false, kind: 'boot-failed', deviceId: 'emulator-5554' });
    expect(tools.callsWith('emu kill')).toHaveLength(1);
    expect(tools.kills).toEqual([]);
    expect(readClaims()).toEqual([]);
  });

  it(`kills the emulator it spawned when adb cannot see it to shut it down`, async () => {
    const { tools } = fakeAndroid({ boots: false, listed: false });

    const result = await resolveClaimedDeviceAsync({
      mode: 'claim',
      platform: 'android',
      projectRoot: HERE,
      allowBoot: true,
      timeoutMs: 0,
    });

    expect(result).toMatchObject({ ok: false, kind: 'boot-failed' });
    expect(tools.kills).toEqual([
      { command: expect.stringMatching(/emulator/), signal: 'SIGKILL' },
    ]);
    expect(readClaims()).toEqual([]);
  });

  it(`fails the boot, and claims and shuts down nothing, when another emulator took its port`, async () => {
    const { tools } = fakeAndroid({ foreign: 'Someone_Elses_AVD' });

    const result = await resolveClaimedDeviceAsync({
      mode: 'claim',
      platform: 'android',
      projectRoot: HERE,
      allowBoot: true,
    });

    expect(result).toMatchObject({ ok: false, kind: 'boot-failed', deviceId: 'emulator-5554' });
    expect(!result.ok && result.reason).toContain('exited with code 1');
    expect(tools.callsWith('emu kill')).toEqual([]);
    expect(readClaims()).toEqual([]);
  });

  it(`never starts an emulator another worktree is starting on the same port`, async () => {
    fakeAndroid();
    otherClaim('emulator-5554', 'local-android');
    expect(
      await resolveClaimedDeviceAsync({
        mode: 'claim',
        platform: 'android',
        projectRoot: HERE,
        allowBoot: true,
      })
    ).toMatchObject({ ok: true, id: 'emulator-5556' });
  });
});

// A peek answers from the same choice as a claim, for a verb that only reads.
describe(`${resolveClaimedDeviceAsync.name} peeking`, () => {
  it(`answers the simulator a claim then boots, and writes and boots nothing itself`, async () => {
    const { tools } = fakeSimulators();
    const peeked = await resolveClaimedDeviceAsync({
      mode: 'peek',
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: true,
    });

    expect(peeked).toMatchObject({ ok: true, action: 'boot', state: 'shutdown' });
    expect(readClaims()).toEqual([]);
    expect(tools.callsWith('simctl boot')).toEqual([]);

    const claimed = await resolveClaimedDeviceAsync({
      mode: 'claim',
      platform: 'ios',
      projectRoot: HERE,
      allowBoot: true,
    });
    expect(claimed.ok && peeked.ok && claimed.id === peeked.id).toBe(true);
  });

  it(`says a claim would create a simulator, and creates none`, async () => {
    const { tools } = fakeSimulators([{ udid: 'SIM-A', name: 'iPhone 17', state: 'Booted' }]);
    otherClaim('SIM-A');

    expect(
      await resolveClaimedDeviceAsync({
        mode: 'peek',
        platform: 'ios',
        projectRoot: HERE,
        allowBoot: true,
      })
    ).toMatchObject({ ok: true, action: 'create', id: null, state: null });
    expect(tools.callsWith('simctl create')).toEqual([]);
    expect(readClaims().map(({ projectRoot }) => projectRoot)).toEqual([OTHER]);
  });

  it(`leaves this worktree's claim untouched`, async () => {
    fakeSimulators([{ udid: 'SIM-A', name: 'iPhone 17', state: 'Booted' }]);
    writeClaim(ownClaim('SIM-A', LONG_AGO));

    expect(
      await resolveClaimedDeviceAsync({
        mode: 'peek',
        platform: 'ios',
        projectRoot: HERE,
        allowBoot: false,
      })
    ).toMatchObject({ ok: true, action: 'reuse', id: 'SIM-A', state: 'booted' });
    expect(readClaims()).toEqual([ownClaim('SIM-A', LONG_AGO)]);
  });

  it(`refuses a shut-down device as a claim would, when it may not boot one`, async () => {
    fakeSimulators();

    expect(
      await resolveClaimedDeviceAsync({
        mode: 'peek',
        platform: 'ios',
        projectRoot: HERE,
        allowBoot: false,
      })
    ).toMatchObject({ ok: false, kind: 'no-device', reason: 'no booted iOS simulator was found' });
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
