// @ref llp/0030-one-device-per-agent.rfc.md §The registry
import { vol } from 'memfs';
import path from 'path';

import { allocateDeviceAsync, CREATED_DEVICE_EXPIRY_MS } from '../allocate';
import { devicesAllClaimedError } from '../errors';
import { event } from '../events';
import { claimFilePath, readClaims, writeClaim } from '../registry';
import type { DeviceCandidate, DeviceClaim } from '../types';

vi.mock('os', async (importOriginal) => {
  const os = { ...(await importOriginal<typeof import('os')>()), homedir: () => '/home' };
  return { ...os, default: os };
});
vi.mock('../events', () => ({
  event: vi.fn(),
  debugEvent: Object.assign(vi.fn(), { error: vi.fn((error) => error) }),
}));

const HERE = path.resolve('/work/here');
const OTHER = path.resolve('/work/other');
const NOW = new Date('2026-09-30T12:00:00.000Z');
const LONG_AGO = new Date(NOW.getTime() - CREATED_DEVICE_EXPIRY_MS - 60_000).toISOString();

const booted = (id: string): DeviceCandidate => ({ id, state: 'booted' });
const shutdown = (id: string): DeviceCandidate => ({ id, state: 'shutdown' });

/** Worktrees whose dev server answers. Every other claim is live only by its touch. */
let liveRoots: Set<string>;

beforeEach(() => {
  liveRoots = new Set();
  vol.mkdirSync(HERE, { recursive: true });
  vol.mkdirSync(OTHER, { recursive: true });
});

afterEach(() => {
  vol.reset();
});

function allocate(
  projectRoot: string,
  {
    inventory = [],
    createDevice,
    deleteDevice,
    capacity = 4,
    now = NOW,
  }: {
    inventory?: DeviceCandidate[];
    createDevice?: () => Promise<DeviceCandidate>;
    deleteDevice?: (claim: DeviceClaim) => Promise<void>;
    capacity?: number;
    now?: Date;
  } = {}
) {
  return allocateDeviceAsync({
    projectRoot,
    platform: 'ios',
    backend: 'local-ios',
    listDevices: async () => inventory,
    createDevice,
    deleteDevice,
    capacity,
    now,
    probeLock: async (root) => (liveRoots.has(root) ? {} : null),
  });
}

function staleClaim(overrides: Partial<DeviceClaim>): DeviceClaim {
  return {
    backend: 'local-ios',
    platform: 'ios',
    id: 'A',
    projectRoot: OTHER,
    pid: 1,
    claimedAt: LONG_AGO,
    touchedAt: LONG_AGO,
    created: false,
    booted: false,
    ...overrides,
  };
}

describe('allocateDeviceAsync', () => {
  it(`gives two worktrees two different devices`, async () => {
    const inventory = [booted('A'), booted('B')];

    const one = await allocate(HERE, { inventory });
    const other = await allocate(OTHER, { inventory });

    expect(one).toMatchObject({ kind: 'take', candidate: { id: 'A' } });
    expect(other).toMatchObject({ kind: 'take', candidate: { id: 'B' } });
    expect(readClaims().map((claim) => [claim.id, claim.projectRoot])).toEqual(
      expect.arrayContaining([
        ['A', HERE],
        ['B', OTHER],
      ])
    );
  });

  it(`gives two worktrees two different devices when they ask at the same time`, async () => {
    const inventory = [booted('A'), booted('B')];

    const [one, other] = await Promise.all([
      allocate(HERE, { inventory }),
      allocate(OTHER, { inventory }),
    ]);

    const ids = [one, other].map((allocation) =>
      allocation.kind === 'take' ? allocation.candidate.id : null
    );
    expect(new Set(ids)).toEqual(new Set(['A', 'B']));
  });

  it(`reuses the device of the same worktree, and leaves the touch to a caller that can use it`, async () => {
    const inventory = [booted('A'), booted('B')];
    await allocate(HERE, { inventory });
    const later = new Date(NOW.getTime() + 60_000);

    const again = await allocate(HERE, { inventory, now: later });

    expect(again).toMatchObject({
      kind: 'reuse',
      liveness: 'live',
      claim: { id: 'A', touchedAt: NOW.toISOString() },
    });
    expect(readClaims()).toMatchObject([{ touchedAt: NOW.toISOString() }]);
    expect(readClaims()).toHaveLength(1);
  });

  it(`reports a shut-down device to boot, and boots nothing itself`, async () => {
    const allocation = await allocate(HERE, { inventory: [shutdown('C')] });

    expect(allocation).toMatchObject({ kind: 'boot', candidate: { id: 'C' } });
    expect(readClaims()).toMatchObject([{ id: 'C', projectRoot: HERE }]);
  });

  it(`creates a device under the lock when every device is held, and marks it as created`, async () => {
    liveRoots.add(OTHER);
    writeClaim(staleClaim({ id: 'A' }));
    const createDevice = vi.fn(async () => shutdown('NEW'));

    const allocation = await allocate(HERE, { inventory: [booted('A')], createDevice });

    expect(createDevice).toHaveBeenCalledTimes(1);
    expect(allocation).toMatchObject({
      kind: 'created',
      candidate: { id: 'NEW' },
      claim: { id: 'NEW', projectRoot: HERE, created: true },
    });
    expect(vol.existsSync(claimFilePath('local-ios', 'NEW'))).toBe(true);
  });

  it(`stops and names the holders when nothing can be created`, async () => {
    liveRoots.add(OTHER);
    writeClaim(staleClaim({ id: 'A' }));

    const allocation = await allocate(HERE, { inventory: [booted('A')] });

    expect(allocation).toEqual({ kind: 'exhausted', holders: [{ id: 'A', projectRoot: OTHER }] });
  });

  it(`turns the stop into DEVICES_ALL_CLAIMED, which exits 1 and names each holder`, () => {
    const error = devicesAllClaimedError('ios', [{ id: 'A', projectRoot: OTHER }]);

    expect(error.code).toBe('DEVICES_ALL_CLAIMED');
    expect(error.exitCode).toBeUndefined();
    expect(error.message).toContain(OTHER);
    expect(error.data).toEqual({ platform: 'ios', holders: [{ id: 'A', projectRoot: OTHER }] });
  });

  it(`stops at capacity even with a way to create`, async () => {
    liveRoots.add(OTHER);
    writeClaim(staleClaim({ id: 'A' }));
    const createDevice = vi.fn(async () => shutdown('NEW'));

    const allocation = await allocate(HERE, {
      inventory: [booted('A')],
      createDevice,
      capacity: 1,
    });

    expect(allocation.kind).toBe('exhausted');
    expect(createDevice).not.toHaveBeenCalled();
  });

  it(`takes over the device of a stale claim`, async () => {
    writeClaim(staleClaim({ id: 'A', created: true }));

    const allocation = await allocate(HERE, { inventory: [booted('A')] });

    expect(allocation).toMatchObject({ kind: 'take', claim: { id: 'A', projectRoot: HERE } });
    expect(readClaims()).toMatchObject([{ id: 'A', projectRoot: HERE, created: true }]);
    expect(event).toHaveBeenCalledWith(
      'device_claim_stale_removed',
      expect.objectContaining({ id: 'A', projectRoot: OTHER, reason: 'taken-over' })
    );
  });

  it(`releases a stale claim whose device is gone`, async () => {
    writeClaim(staleClaim({ id: 'GONE' }));

    await allocate(HERE, { inventory: [booted('A')] });

    expect(readClaims().map((claim) => claim.id)).toEqual(['A']);
    expect(event).toHaveBeenCalledWith(
      'device_claim_stale_removed',
      expect.objectContaining({ id: 'GONE', reason: 'device-gone' })
    );
  });

  it(`keeps a live claim whose device is gone, because it is not this worktree's to judge`, async () => {
    liveRoots.add(OTHER);
    writeClaim(staleClaim({ id: 'GONE' }));

    await allocate(HERE, { inventory: [booted('A')] });

    expect(
      readClaims()
        .map((claim) => claim.id)
        .sort()
    ).toEqual(['A', 'GONE']);
  });

  it(`releases its own claim whose device is gone, even while it is live`, async () => {
    liveRoots.add(HERE);
    writeClaim(staleClaim({ id: 'GONE', projectRoot: HERE }));

    const allocation = await allocate(HERE, { inventory: [booted('A')] });

    expect(allocation).toMatchObject({ kind: 'take', candidate: { id: 'A' } });
    expect(readClaims().map((claim) => claim.id)).toEqual(['A']);
  });

  it(`deletes a device it created once its claim has been stale for an hour`, async () => {
    writeClaim(staleClaim({ id: 'OLD', created: true }));
    const deleteDevice = vi.fn(async () => {});

    await allocate(HERE, { inventory: [booted('A'), shutdown('OLD')], deleteDevice });

    expect(deleteDevice).toHaveBeenCalledWith(expect.objectContaining({ id: 'OLD' }));
    expect(readClaims().map((claim) => claim.id)).toEqual(['A']);
  });

  it(`never deletes a device it did not create`, async () => {
    writeClaim(staleClaim({ id: 'OLD', created: false }));
    const deleteDevice = vi.fn(async () => {});

    await allocate(HERE, { inventory: [booted('A'), shutdown('OLD')], deleteDevice });

    expect(deleteDevice).not.toHaveBeenCalled();
  });

  it(`keeps the claim of a device it failed to delete, so the next run tries again`, async () => {
    writeClaim(staleClaim({ id: 'OLD', created: true }));
    const deleteDevice = vi.fn(async () => {
      throw new Error('simctl refused');
    });

    await allocate(HERE, { inventory: [booted('A'), shutdown('OLD')], deleteDevice });

    expect(
      readClaims()
        .map((claim) => claim.id)
        .sort()
    ).toEqual(['A', 'OLD']);
  });

  it(`takes a device whose claim file a crash left half written`, async () => {
    const file = claimFilePath('local-ios', 'A');
    vol.mkdirSync(path.dirname(file), { recursive: true });
    vol.writeFileSync(file, '{"backend":"local-ios","plat');
    const written = (NOW.getTime() - 61_000) / 1000;
    vol.utimesSync(file, written, written);

    const allocation = await allocate(HERE, { inventory: [booted('A')] });

    expect(allocation).toMatchObject({ kind: 'take', candidate: { id: 'A' } });
    expect(readClaims()).toMatchObject([{ id: 'A', projectRoot: HERE }]);
  });

  it(`leaves the registry unlocked`, async () => {
    await allocate(HERE, { inventory: [booted('A')] });

    expect(vol.existsSync(path.join(path.dirname(claimFilePath('local-ios', 'A')), '.lock'))).toBe(
      false
    );
  });
});
