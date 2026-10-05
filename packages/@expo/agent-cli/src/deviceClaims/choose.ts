// @ref llp/0030-one-device-per-agent.rfc.md §The registry
// The allocation order as a pure function of the claims, the inventory and the capacity.

import type {
  ClassifiedClaim,
  DeviceBackend,
  DeviceCandidate,
  DeviceChoice,
  DeviceClaim,
  DevicePlatform,
} from './types';

export interface ChooseDeviceInput<C extends DeviceCandidate> {
  projectRoot: string;
  platform: DevicePlatform;
  backend: DeviceBackend;
  claims: ClassifiedClaim[];
  inventory: C[];
  /** How many live claims this backend may hold, the new device included. */
  capacity: number;
  /** Orders the shut-down candidates of step 4. Inventory order when absent. */
  rank?: (left: C, right: C) => number;
  /** Stamped on the claim a take or a boot writes. */
  now: Date;
  pid: number;
  /** Step 0: `--device`. Replaces steps 1 to 5 when present. */
  explicit?: string;
  /**
   * Whether this CLI created the candidate, known from the device itself. A created device keeps
   * `created` even after its claim was released, so it can still expire.
   */
  isCreated?: (candidate: C) => boolean;
  /** Whether a candidate answers to {@link explicit}. By id when absent. */
  matches?: (candidate: C, query: string) => boolean;
}

export function chooseDevice<C extends DeviceCandidate>({
  projectRoot,
  platform,
  backend,
  claims,
  inventory,
  capacity,
  rank,
  now,
  pid,
  explicit,
  isCreated,
  matches = (candidate, query) => candidate.id === query,
}: ChooseDeviceInput<C>): DeviceChoice<C> {
  const mine = claims.filter(
    (claim) =>
      claim.backend === backend && claim.platform === platform && claim.projectRoot === projectRoot
  );
  const exists = (claim: DeviceClaim) => inventory.some((candidate) => candidate.id === claim.id);

  const replaced = (candidate: C) =>
    claims.filter((claim) => claim.backend === backend && claim.id === candidate.id);
  const claimFor = (candidate: C): DeviceClaim => ({
    backend,
    platform,
    id: candidate.id,
    projectRoot,
    pid,
    claimedAt: now.toISOString(),
    touchedAt: now.toISOString(),
    // The device changes hands with its stale claim, and with it the right to delete it or shut
    // it down later.
    created:
      (isCreated?.(candidate) ?? false) || replaced(candidate).some((claim) => claim.created),
    booted: replaced(candidate).some((claim) => claim.booted),
  });

  if (explicit != null) {
    const holder = (candidate: C) =>
      claims.find(
        (claim) =>
          claim.backend === backend &&
          claim.id === candidate.id &&
          claim.liveness === 'live' &&
          claim.projectRoot !== projectRoot
      );
    const matching = inventory.filter((candidate) => matches(candidate, explicit));
    // Filtered before the pick: two emulators of one AVD share a name, and one may be another's.
    const free = matching.filter((candidate) => holder(candidate) == null);
    const named =
      free.find(({ id }) => id === explicit) ??
      free.find(({ state }) => state === 'booted') ??
      free[0];
    if (named == null) {
      return matching.length === 0
        ? { kind: 'not-found' }
        : {
            kind: 'claimed',
            holders: matching.map((candidate) => ({
              id: candidate.id,
              projectRoot: holder(candidate)!.projectRoot,
            })),
          };
    }
    const held = mine.find((claim) => claim.id === named.id);
    if (held) {
      const { liveness, ...claim } = held;
      return { kind: 'reuse', claim, liveness };
    }
    return {
      kind: named.state === 'booted' ? 'take' : 'boot',
      candidate: named,
      claim: claimFor(named),
    };
  }

  // Steps 1 and 2. A live claim whose device is gone is not reused either: every verb would fail
  // on it, and for EAS the RFC reuses the bound session only while it is listed.
  const own =
    mine.find((claim) => claim.liveness === 'live' && exists(claim)) ??
    mine.find((claim) => claim.liveness === 'stale' && exists(claim));
  if (own) {
    const { liveness, ...claim } = own;
    return { kind: 'reuse', claim, liveness };
  }

  const liveHere = claims.filter((claim) => claim.backend === backend && claim.liveness === 'live');

  // An in-progress EAS session with no claim here may belong to an agent on another machine, which
  // no local registry can see, so steps 3 and 4 never apply to it.
  if (backend !== 'eas') {
    const free = inventory.filter(
      (candidate) => !liveHere.some((claim) => claim.id === candidate.id)
    );
    const booted = free.find((candidate) => candidate.state === 'booted');
    if (booted) {
      return { kind: 'take', candidate: booted, claim: claimFor(booted) };
    }
    const shutdown = free.filter((candidate) => candidate.state === 'shutdown');
    const [first] = rank ? [...shutdown].sort(rank) : shutdown;
    if (first) {
      return { kind: 'boot', candidate: first, claim: claimFor(first) };
    }
  }

  if (liveHere.length + 1 <= capacity) {
    return { kind: 'create' };
  }

  return {
    kind: 'exhausted',
    holders: liveHere
      .filter((claim) => claim.platform === platform)
      .map(({ id, projectRoot: holder }) => ({ id, projectRoot: holder })),
  };
}
