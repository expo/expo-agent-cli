// @ref llp/0028-one-device-per-agent.rfc.md §The registry
// The IO around `chooseDevice`: read, classify, choose and write, all under the registry lock, so
// two worktrees can never both see a device as free and both claim it.

import { canonicalizeExistingPath } from '../utils/dir';
import { chooseDevice } from './choose';
import { debugEvent, event } from './events';
import { classifyClaimAsync } from './liveness';
import {
  pruneUnreadableClaims,
  readClaims,
  releaseClaim,
  removeClaimFile,
  withRegistryLockAsync,
  writeClaim,
} from './registry';
import type {
  Allocation,
  ClassifiedClaim,
  DeviceBackend,
  DeviceCandidate,
  DeviceClaim,
  DevicePlatform,
} from './types';

/** @ref llp/0028-one-device-per-agent.rfc.md §Release and cleanup */
export const CREATED_DEVICE_EXPIRY_MS = 60 * 60_000;

export interface AllocateDeviceOptions<C extends DeviceCandidate> {
  projectRoot: string;
  platform: DevicePlatform;
  backend: DeviceBackend;
  /** Every device this backend has for the platform, booted or not. */
  listDevices: () => Promise<C[]>;
  /** Called under the registry lock, so the capacity it was counted against still holds. */
  createDevice?: () => Promise<C>;
  /** Deletes a device this CLI created whose claim expired. Absent: expired devices are kept. */
  deleteDevice?: (claim: DeviceClaim) => Promise<void>;
  capacity: number;
  rank?: (left: C, right: C) => number;
  now?: Date;
  probeLock?: (projectRoot: string) => Promise<unknown>;
}

/**
 * The device of this worktree, or who holds every device.
 *
 * Never boots: a boot takes a minute, and the lock would hold every other worktree for it. The
 * claim is written first, so no other worktree takes the device while the caller boots it.
 * Never touches a reused claim: only a caller that hands out a usable device may re-arm it.
 */
export async function allocateDeviceAsync<C extends DeviceCandidate>({
  projectRoot: givenRoot,
  platform,
  backend,
  listDevices,
  createDevice,
  deleteDevice,
  capacity,
  rank,
  now = new Date(),
  probeLock,
}: AllocateDeviceOptions<C>): Promise<Allocation<C>> {
  const projectRoot = canonicalizeExistingPath(givenRoot);

  return await withRegistryLockAsync(async () => {
    pruneUnreadableClaims(now.getTime());
    const inventory = await listDevices();
    const claims: ClassifiedClaim[] = await Promise.all(
      readClaims().map(async (claim) => ({
        ...claim,
        liveness: await classifyClaimAsync(claim, { now, probeLock }),
      }))
    );
    const choice = chooseDevice({
      projectRoot,
      platform,
      backend,
      claims,
      inventory,
      capacity: createDevice ? capacity : 0,
      rank,
      now,
      pid: process.pid,
    });

    const chosenId =
      choice.kind === 'reuse'
        ? choice.claim.id
        : 'candidate' in choice
          ? choice.candidate.id
          : null;
    const inScope = claims.filter(
      (claim) => claim.backend === backend && claim.platform === platform && claim.id !== chosenId
    );
    for (const claim of inScope) {
      const gone = !inventory.some((candidate) => candidate.id === claim.id);
      if (gone && claim.projectRoot === projectRoot) {
        // This worktree's own claim on a device that no longer exists: it holds nothing.
        releaseClaim(claim);
        continue;
      }
      if (claim.liveness !== 'stale') {
        continue;
      }
      if (gone) {
        removeStale(claim, 'device-gone');
      } else if (
        claim.created &&
        deleteDevice &&
        now.getTime() - Date.parse(claim.touchedAt) > CREATED_DEVICE_EXPIRY_MS
      ) {
        try {
          await deleteDevice(claim);
          removeStale(claim, 'expired');
        } catch (error: unknown) {
          debugEvent('device_delete_failed', {
            backend: claim.backend,
            id: claim.id,
            error: debugEvent.error(error as Error),
          });
        }
      }
    }

    switch (choice.kind) {
      case 'reuse':
      case 'exhausted':
        return choice;

      case 'take':
      case 'boot': {
        const replaced = claims.find(
          (claim) => claim.backend === backend && claim.id === choice.candidate.id
        );
        if (replaced) {
          removeStale(replaced, 'taken-over');
        }
        writeClaim(choice.claim);
        return choice;
      }

      case 'create': {
        const candidate = await createDevice!();
        const claim: DeviceClaim = {
          backend,
          platform,
          id: candidate.id,
          projectRoot,
          pid: process.pid,
          claimedAt: now.toISOString(),
          touchedAt: now.toISOString(),
          created: true,
        };
        writeClaim(claim);
        return { kind: 'created', candidate, claim };
      }
    }
  });
}

function removeStale(claim: DeviceClaim, reason: 'device-gone' | 'taken-over' | 'expired'): void {
  removeClaimFile(claim);
  event('device_claim_stale_removed', {
    backend: claim.backend,
    id: claim.id,
    projectRoot: claim.projectRoot,
    reason,
  });
}
