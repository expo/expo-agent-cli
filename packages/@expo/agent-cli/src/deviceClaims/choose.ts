// @ref llp/0028-one-device-per-agent.rfc.md §The registry
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
}: ChooseDeviceInput<C>): DeviceChoice<C> {
  const mine = claims.filter(
    (claim) =>
      claim.backend === backend && claim.platform === platform && claim.projectRoot === projectRoot
  );
  const exists = (claim: DeviceClaim) => inventory.some((candidate) => candidate.id === claim.id);

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
    const claimFor = (candidate: C): DeviceClaim => ({
      backend,
      platform,
      id: candidate.id,
      projectRoot,
      pid,
      claimedAt: now.toISOString(),
      touchedAt: now.toISOString(),
      // The device changes hands with its stale claim, and with it the right to delete it later.
      created: claims.some(
        (claim) => claim.backend === backend && claim.id === candidate.id && claim.created
      ),
    });

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
