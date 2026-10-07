// @ref llp/0030-one-device-per-agent.rfc.md §Release and cleanup
import { vol } from 'memfs';
import path from 'path';

import {
  allocateDeviceAsync,
  readClaims,
  writeClaim,
  type Allocation,
  type DeviceCandidate,
  type DeviceClaim,
} from '../../deviceClaims';
import { describeReapedDevice, reapDeletedWorktreeClaimsAsync } from '../reapClaims';
import { fakeDeviceTools, simctlDevices } from './fakeDeviceTools';

vi.mock('../../deviceClaims/events', () => ({
  event: vi.fn(),
  debugEvent: Object.assign(vi.fn(), { error: vi.fn((error) => error) }),
}));

const HERE = path.resolve('/work/here');
const GONE = path.resolve('/work/gone');
const UNMOUNTED = path.resolve('/Volumes/external/worktree');
const RECENT = new Date().toISOString();

beforeEach(() => {
  vol.mkdirSync(HERE, { recursive: true });
});

afterEach(() => {
  vol.reset();
});

function claim(overrides: Partial<DeviceClaim> & Pick<DeviceClaim, 'id'>): DeviceClaim {
  const written: DeviceClaim = {
    backend: 'local-ios',
    platform: 'ios',
    projectRoot: GONE,
    pid: 1,
    claimedAt: RECENT,
    touchedAt: RECENT,
    created: false,
    booted: true,
    ...overrides,
  };
  writeClaim(written);
  return written;
}

function simulators(names: Record<string, string> = {}) {
  return fakeDeviceTools((command, args) => {
    if (command === 'xcrun' && args[1] === 'list') {
      return {
        stdout: simctlDevices(
          Object.entries(names).map(([udid, name]) => ({ udid, name, state: 'Booted' as const }))
        ),
      };
    }
    return {};
  });
}

const noLock = async () => null;

describe(reapDeletedWorktreeClaimsAsync, () => {
  it(`shuts down a device the deleted worktree booted, and drops the claim, inside the grace period`, async () => {
    claim({ id: 'SIM-A' });
    const seenDuringShutdown: DeviceClaim[][] = [];
    const tools = fakeDeviceTools((_command, args) => {
      if (args.includes('shutdown')) {
        seenDuringShutdown.push(readClaims());
      }
      return {};
    });

    const reaped = await reapDeletedWorktreeClaimsAsync(HERE, { probeLock: noLock });

    expect(tools.callsWith('simctl shutdown SIM-A')).toHaveLength(1);
    expect(seenDuringShutdown).toEqual([
      [expect.objectContaining({ projectRoot: GONE, reaping: true })],
    ]);
    expect(readClaims()).toEqual([]);
    expect(reaped).toEqual([
      {
        id: 'SIM-A',
        backend: 'local-ios',
        projectRoot: GONE,
        released: true,
        shutDown: true,
        deleted: false,
        reason: null,
      },
    ]);
  });

  it(`never hands the device it shuts down to a command of the live worktree`, async () => {
    claim({ id: 'SIM-A' });
    let during: Promise<Allocation<DeviceCandidate>> | undefined;
    fakeDeviceTools((_command, args) => {
      if (args.includes('shutdown')) {
        during = allocateDeviceAsync({
          projectRoot: HERE,
          platform: 'ios',
          backend: 'local-ios',
          listDevices: async () => [
            { id: 'SIM-A', state: 'booted' },
            { id: 'SIM-B', state: 'booted' },
          ],
          capacity: 0,
          probeLock: noLock,
        });
      }
      return {};
    });

    await reapDeletedWorktreeClaimsAsync(HERE, { probeLock: noLock });

    expect(await during).toMatchObject({ kind: 'take', candidate: { id: 'SIM-B' } });
    expect(readClaims()).toMatchObject([{ id: 'SIM-B', projectRoot: HERE }]);
  });

  it(`deletes a created simulator after the shutdown when it is named agent-cli N`, async () => {
    claim({ id: 'SIM-NEW', created: true });
    const tools = simulators({ 'SIM-NEW': 'agent-cli 2' });

    const [reaped] = await reapDeletedWorktreeClaimsAsync(HERE, { probeLock: noLock });

    expect(tools.callsWith('simctl delete SIM-NEW')).toHaveLength(1);
    expect(reaped).toMatchObject({ shutDown: true, deleted: true, released: true });
  });

  it(`never deletes a simulator that a person named, even with created set`, async () => {
    claim({ id: 'SIM-A', created: true });
    const tools = simulators({ 'SIM-A': 'iPhone 17' });

    const [reaped] = await reapDeletedWorktreeClaimsAsync(HERE, { probeLock: noLock });

    expect(tools.callsWith('simctl shutdown SIM-A')).toHaveLength(1);
    expect(tools.callsWith('simctl delete')).toEqual([]);
    expect(reaped).toMatchObject({ shutDown: true, deleted: false });
  });

  it(`kills an emulator it booted and never deletes its AVD`, async () => {
    claim({ id: 'emulator-5556', backend: 'local-android', platform: 'android', created: true });
    const tools = fakeDeviceTools(() => ({}));

    const [reaped] = await reapDeletedWorktreeClaimsAsync(HERE, { probeLock: noLock });

    expect(tools.callsWith('-s emulator-5556 emu kill')).toHaveLength(1);
    expect(tools.callsWith('delete')).toEqual([]);
    expect(tools.callsWith('avdmanager')).toEqual([]);
    expect(reaped).toMatchObject({ shutDown: true, deleted: false, released: true });
  });

  it(`drops the claim and leaves the device when this CLI neither booted nor created it`, async () => {
    claim({ id: 'SIM-A', booted: false, created: false });
    const tools = fakeDeviceTools(() => ({}));

    const [reaped] = await reapDeletedWorktreeClaimsAsync(HERE, { probeLock: noLock });

    expect(tools.calls).toEqual([]);
    expect(readClaims()).toEqual([]);
    expect(reaped).toMatchObject({ released: true, shutDown: false, deleted: false });
  });

  it(`reports a shutdown that failed, drops the claim, and does not throw`, async () => {
    claim({ id: 'SIM-A', created: true });
    const tools = fakeDeviceTools((_command, args) =>
      args.includes('shutdown') ? { exitCode: 1, stderr: 'Unable to shutdown device' } : {}
    );

    const [reaped] = await reapDeletedWorktreeClaimsAsync(HERE, { probeLock: noLock });

    expect(tools.callsWith('simctl delete')).toEqual([]);
    expect(readClaims()).toEqual([]);
    expect(reaped).toMatchObject({ released: true, shutDown: false, deleted: false });
    expect(reaped!.reason).toContain('Unable to shutdown device');
  });

  it(`leaves a claim that another reaper is shutting down`, async () => {
    claim({ id: 'SIM-A', reaping: true });
    const tools = fakeDeviceTools(() => ({}));

    expect(await reapDeletedWorktreeClaimsAsync(HERE, { probeLock: noLock })).toEqual([]);
    expect(tools.calls).toEqual([]);
    expect(readClaims()).toMatchObject([{ id: 'SIM-A', reaping: true }]);
  });

  it(`leaves the claim of a worktree whose parent directory is missing, an unmounted volume`, async () => {
    claim({ id: 'SIM-A', projectRoot: UNMOUNTED });
    const tools = fakeDeviceTools(() => ({}));

    expect(await reapDeletedWorktreeClaimsAsync(HERE, { probeLock: noLock })).toEqual([]);
    expect(tools.calls).toEqual([]);
    expect(readClaims()).toHaveLength(1);
  });

  it(`leaves the claim while the deleted worktree's dev-server lock still answers`, async () => {
    claim({ id: 'SIM-A' });
    const tools = fakeDeviceTools(() => ({}));

    const reaped = await reapDeletedWorktreeClaimsAsync(HERE, {
      probeLock: async () => ({ pid: 5 }),
    });

    expect(reaped).toEqual([]);
    expect(tools.calls).toEqual([]);
    expect(readClaims()).toHaveLength(1);
  });

  it(`leaves the claims of worktrees that still exist, stale or not`, async () => {
    claim({ id: 'SIM-A', projectRoot: HERE, touchedAt: '2026-01-01T00:00:00.000Z' });
    const tools = fakeDeviceTools(() => ({}));

    expect(await reapDeletedWorktreeClaimsAsync(HERE, { probeLock: noLock })).toEqual([]);
    expect(tools.calls).toEqual([]);
    expect(readClaims()).toHaveLength(1);
  });

  it(`stops the EAS session from the live worktree, and drops the claim after the stop`, async () => {
    claim({ id: 'sess-1', backend: 'eas', booted: false, created: true });
    const stopEasSession = vi.fn(async () => {
      expect(readClaims()).toHaveLength(1);
      return { ok: true, reason: null };
    });

    const [reaped] = await reapDeletedWorktreeClaimsAsync(HERE, {
      probeLock: noLock,
      stopEasSession,
    });

    expect(stopEasSession).toHaveBeenCalledWith(HERE, 'sess-1');
    expect(readClaims()).toEqual([]);
    expect(reaped).toMatchObject({ backend: 'eas', released: true, shutDown: true });
  });

  it(`keeps the EAS claim when the stop failed`, async () => {
    claim({ id: 'sess-1', backend: 'eas', booted: false, created: true });

    const [reaped] = await reapDeletedWorktreeClaimsAsync(HERE, {
      probeLock: noLock,
      stopEasSession: async () => ({ ok: false, reason: 'exited 1: not logged in' }),
    });

    expect(readClaims()).toMatchObject([{ id: 'sess-1', projectRoot: GONE }]);
    expect(reaped).toMatchObject({ released: false, shutDown: false });
    expect(describeReapedDevice(reaped!)).toContain('session still running — exited 1');
  });
});

describe(describeReapedDevice, () => {
  it(`names the device, the deleted worktree, and what was done`, () => {
    expect(
      describeReapedDevice({
        id: 'SIM-NEW',
        backend: 'local-ios',
        projectRoot: GONE,
        released: true,
        shutDown: true,
        deleted: true,
        reason: null,
      })
    ).toBe(`SIM-NEW of the deleted worktree ${GONE} · shut down and deleted, claim dropped`);
  });
});
