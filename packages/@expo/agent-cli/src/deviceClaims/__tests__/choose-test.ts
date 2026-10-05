// @ref llp/0030-one-device-per-agent.rfc.md §The registry
import { chooseDevice } from '../choose';
import type {
  ClaimLiveness,
  ClassifiedClaim,
  DeviceBackend,
  DeviceCandidate,
  DeviceChoice,
} from '../types';

const HERE = '/work/here';
const OTHER = '/work/other';
const NOW = new Date('2026-09-30T12:00:00.000Z');

function claim(
  id: string,
  projectRoot: string,
  liveness: ClaimLiveness,
  backend: DeviceBackend = 'local-ios'
): ClassifiedClaim {
  return {
    backend,
    platform: backend === 'local-android' ? 'android' : 'ios',
    id,
    projectRoot,
    pid: 1,
    claimedAt: '2026-09-30T10:00:00.000Z',
    touchedAt: '2026-09-30T10:00:00.000Z',
    created: false,
    booted: false,
    liveness,
  };
}

const booted = (id: string): DeviceCandidate => ({ id, state: 'booted' });
const shutdown = (id: string): DeviceCandidate => ({ id, state: 'shutdown' });

function choose({
  claims = [],
  inventory = [],
  capacity = 4,
  backend = 'local-ios',
  rank,
  explicit,
  isCreated,
}: {
  claims?: ClassifiedClaim[];
  inventory?: DeviceCandidate[];
  capacity?: number;
  backend?: DeviceBackend;
  rank?: (left: DeviceCandidate, right: DeviceCandidate) => number;
  explicit?: string;
  isCreated?: (candidate: DeviceCandidate) => boolean;
}) {
  return chooseDevice({
    projectRoot: HERE,
    platform: 'ios',
    backend,
    claims,
    inventory,
    capacity,
    rank,
    explicit,
    isCreated,
    matches: (candidate, query) =>
      candidate.id === query || (candidate as DeviceCandidate & { name?: string }).name === query,
    now: NOW,
    pid: 42,
  });
}

/** The decision with the claim reduced to what the rule decides: which device, for whom. */
function summarize(choice: DeviceChoice<DeviceCandidate>) {
  switch (choice.kind) {
    case 'reuse':
      return { kind: choice.kind, id: choice.claim.id, liveness: choice.liveness };
    case 'take':
    case 'boot':
      return { kind: choice.kind, id: choice.candidate.id };
    case 'create':
      return { kind: choice.kind };
    case 'exhausted':
    case 'claimed':
      return { kind: choice.kind, holders: choice.holders };
    case 'not-found':
      return { kind: choice.kind };
  }
}

describe('chooseDevice — the allocation order', () => {
  it.each([
    {
      rule: '1. the live claim of this worktree',
      claims: [claim('A', HERE, 'live')],
      inventory: [booted('B'), shutdown('A')],
      expected: { kind: 'reuse', id: 'A', liveness: 'live' },
    },
    {
      rule: '1 before 2: a live own claim wins over a stale one',
      claims: [claim('A', HERE, 'stale'), claim('B', HERE, 'live')],
      inventory: [booted('A'), booted('B')],
      expected: { kind: 'reuse', id: 'B', liveness: 'live' },
    },
    {
      rule: '2. a stale claim of this worktree whose device still exists',
      claims: [claim('A', HERE, 'stale')],
      inventory: [booted('B'), shutdown('A')],
      expected: { kind: 'reuse', id: 'A', liveness: 'stale' },
    },
    {
      rule: '3. a booted device with no live claim',
      claims: [claim('A', OTHER, 'live')],
      inventory: [booted('A'), shutdown('C'), booted('B')],
      expected: { kind: 'take', id: 'B' },
    },
    {
      rule: '3. a booted device whose claim is stale',
      claims: [claim('A', OTHER, 'stale')],
      inventory: [shutdown('C'), booted('A')],
      expected: { kind: 'take', id: 'A' },
    },
    {
      rule: '4. a shut-down device with no live claim',
      claims: [claim('A', OTHER, 'live')],
      inventory: [booted('A'), shutdown('C')],
      expected: { kind: 'boot', id: 'C' },
    },
    {
      rule: '5. a new device, when every existing one is held',
      claims: [claim('A', OTHER, 'live')],
      inventory: [booted('A')],
      expected: { kind: 'create' },
    },
    {
      rule: '5. a new device, on a machine with none',
      claims: [],
      inventory: [],
      expected: { kind: 'create' },
    },
    {
      rule: '6. every device held and no room for another',
      claims: [claim('A', OTHER, 'live'), claim('B', '/work/third', 'live')],
      inventory: [booted('A'), shutdown('B')],
      capacity: 2,
      expected: {
        kind: 'exhausted',
        holders: [
          { id: 'A', projectRoot: OTHER },
          { id: 'B', projectRoot: '/work/third' },
        ],
      },
    },
  ])(`$rule`, ({ claims, inventory, capacity, expected }) => {
    expect(summarize(choose({ claims, inventory, capacity }))).toEqual(expected);
  });
});

describe('chooseDevice — a claim whose device is gone', () => {
  it(`does not reuse a stale own claim, and falls through to the next rule`, () => {
    const choice = choose({
      claims: [claim('GONE', HERE, 'stale')],
      inventory: [shutdown('C')],
    });

    expect(summarize(choice)).toEqual({ kind: 'boot', id: 'C' });
  });

  it(`does not reuse a live own claim either, because nothing could drive it`, () => {
    const choice = choose({ claims: [claim('GONE', HERE, 'live')], inventory: [booted('B')] });

    expect(summarize(choice)).toEqual({ kind: 'take', id: 'B' });
  });
});

describe('chooseDevice — capacity', () => {
  it(`counts the live claims of this backend only`, () => {
    const choice = choose({
      claims: [claim('A', OTHER, 'live'), claim('E', OTHER, 'live', 'local-android')],
      inventory: [booted('A')],
      capacity: 2,
    });

    expect(summarize(choice)).toEqual({ kind: 'create' });
  });

  it(`does not count stale claims, which hold no device`, () => {
    const choice = choose({
      claims: [claim('A', OTHER, 'live'), claim('GONE', OTHER, 'stale')],
      inventory: [booted('A')],
      capacity: 2,
    });

    expect(summarize(choice)).toEqual({ kind: 'create' });
  });

  it(`refuses the device that would go over it`, () => {
    const choice = choose({
      claims: [claim('A', OTHER, 'live')],
      inventory: [booted('A')],
      capacity: 1,
    });

    expect(summarize(choice)).toEqual({
      kind: 'exhausted',
      holders: [{ id: 'A', projectRoot: OTHER }],
    });
  });

  it(`does not stop the reuse or takeover of a device that already exists`, () => {
    const choice = choose({
      claims: [claim('A', OTHER, 'live')],
      inventory: [booted('A'), shutdown('B')],
      capacity: 1,
    });

    expect(summarize(choice)).toEqual({ kind: 'boot', id: 'B' });
  });
});

describe('chooseDevice — ranking', () => {
  it(`boots shut-down devices in inventory order by default`, () => {
    expect(summarize(choose({ inventory: [shutdown('C'), shutdown('D')] }))).toEqual({
      kind: 'boot',
      id: 'C',
    });
  });

  it(`boots the device the caller ranks first`, () => {
    const choice = choose({
      inventory: [shutdown('C'), shutdown('D')],
      rank: (left, right) => right.id.localeCompare(left.id),
    });

    expect(summarize(choice)).toEqual({ kind: 'boot', id: 'D' });
  });
});

describe('chooseDevice — EAS', () => {
  it(`never takes an in-progress session this worktree did not claim`, () => {
    const choice = choose({ backend: 'eas', inventory: [booted('S1')] });

    expect(summarize(choice)).toEqual({ kind: 'create' });
  });

  it(`reuses the bound session while it is listed`, () => {
    const choice = choose({
      backend: 'eas',
      claims: [claim('S1', HERE, 'stale', 'eas')],
      inventory: [booted('S1')],
    });

    expect(summarize(choice)).toEqual({ kind: 'reuse', id: 'S1', liveness: 'stale' });
  });
});

describe('chooseDevice — the claim it writes', () => {
  it(`names this worktree, this process, and now`, () => {
    const choice = choose({ inventory: [booted('B')] });

    expect(choice).toEqual({
      kind: 'take',
      candidate: booted('B'),
      claim: {
        backend: 'local-ios',
        platform: 'ios',
        id: 'B',
        projectRoot: HERE,
        pid: 42,
        claimedAt: NOW.toISOString(),
        touchedAt: NOW.toISOString(),
        created: false,
        booted: false,
      },
    });
  });

  it(`carries over "created" from the stale claim it replaces, so the device can still be cleaned up`, () => {
    const stale = { ...claim('B', OTHER, 'stale'), created: true };

    const choice = choose({ claims: [stale], inventory: [booted('B')] });

    expect(choice).toMatchObject({ kind: 'take', claim: { projectRoot: HERE, created: true } });
  });

  it(`marks a device the caller knows this CLI created, with no claim to carry it over`, () => {
    const choice = choose({ inventory: [shutdown('B')], isCreated: ({ id }) => id === 'B' });

    expect(choice).toMatchObject({ kind: 'boot', claim: { id: 'B', created: true } });
  });
});

describe('step 0: a device the caller named', () => {
  const named = (id: string, name: string, state: 'booted' | 'shutdown') =>
    ({ id, name, state }) as DeviceCandidate;

  it(`takes the named device even when an earlier step would pick another`, () => {
    expect(
      choose({
        claims: [claim('A', HERE, 'live')],
        inventory: [booted('A'), shutdown('B')],
        explicit: 'B',
      })
    ).toMatchObject({
      kind: 'boot',
      candidate: { id: 'B' },
      claim: { id: 'B', projectRoot: HERE },
    });
  });

  it(`reuses this worktree's claim on the named device`, () => {
    expect(
      choose({ claims: [claim('A', HERE, 'stale')], inventory: [booted('A')], explicit: 'A' })
    ).toMatchObject({ kind: 'reuse', claim: { id: 'A' }, liveness: 'stale' });
  });

  it(`skips an instance another live worktree holds when two share the name`, () => {
    expect(
      choose({
        claims: [claim('emulator-5554', OTHER, 'live')],
        inventory: [
          named('emulator-5554', 'Pixel_8', 'booted'),
          named('emulator-5556', 'Pixel_8', 'booted'),
        ],
        explicit: 'Pixel_8',
      })
    ).toMatchObject({ kind: 'take', candidate: { id: 'emulator-5556' } });
  });

  it(`names the holder when every match is another live worktree's`, () => {
    expect(
      choose({ claims: [claim('A', OTHER, 'live')], inventory: [booted('A')], explicit: 'A' })
    ).toEqual({ kind: 'claimed', holders: [{ id: 'A', projectRoot: OTHER }] });
  });

  it(`takes over the named device from a stale claim`, () => {
    expect(
      choose({ claims: [claim('A', OTHER, 'stale')], inventory: [booted('A')], explicit: 'A' })
    ).toMatchObject({ kind: 'take', claim: { id: 'A', projectRoot: HERE } });
  });

  it(`says nothing matched`, () => {
    expect(choose({ inventory: [booted('A')], explicit: 'Z' })).toEqual({ kind: 'not-found' });
  });
});
