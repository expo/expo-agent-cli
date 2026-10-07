// @ref llp/0030-one-device-per-agent.rfc.md §The registry
// The IO around `chooseDevice`: read, classify, choose and write, all under the registry lock, so
// two worktrees can never both see a device as free and both claim it.

import { canonicalizeExistingPath } from '../utils/dir';
import { chooseDevice } from './choose';
import { debugEvent, event } from './events';
import { classifyClaimAsync } from './liveness';
import {
  isSameClaim,
  pruneUnreadableClaims,
  readClaim,
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

/** @ref llp/0030-one-device-per-agent.rfc.md §Release and cleanup */
export const CREATED_DEVICE_EXPIRY_MS = 60 * 60_000;

export interface AllocateDeviceOptions<C extends DeviceCandidate> {
  projectRoot: string;
  platform: DevicePlatform;
  backend: DeviceBackend;
  /**
   * Every device this backend has for the platform, booted or not. Handed the classified claims,
   * so an inventory that depends on claims counts only the live ones of other worktrees.
   */
  listDevices: (claims: ClassifiedClaim[]) => Promise<C[]>;
  /** Called under the registry lock, so the capacity it was counted against still holds. */
  createDevice?: () => Promise<C>;
  /** Deletes a device this CLI created whose claim expired. Absent: expired devices are kept. */
  deleteDevice?: (claim: DeviceClaim) => Promise<void>;
  capacity: number;
  rank?: (left: C, right: C) => number;
  /** Step 0: `--device`. The caller releases its other claims once this device proves usable. */
  explicit?: string;
  matches?: (candidate: C, query: string) => boolean;
  isCreated?: (candidate: C) => boolean;
  now?: Date;
  probeLock?: (projectRoot: string) => Promise<unknown>;
}

/**
 * The device of this worktree, or who holds every device.
 *
 * Never boots: a boot takes a minute, and the lock would hold every other worktree for it. The
 * claim is written first, so no other worktree takes the device while the caller boots it.
 * Never touches a reused claim: only a caller that hands out a usable device may re-arm it.
 *
 * The inventory is slow, and `touchClaim` runs outside the lock, so a claim that was stale when it
 * was read may be live by the time it is acted on. Each claim is read again just before it is
 * removed, released or its device deleted, and is left when it changed or is live now.
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
  explicit,
  matches,
  isCreated,
  now: givenNow,
  probeLock,
}: AllocateDeviceOptions<C>): Promise<Allocation<C>> {
  const projectRoot = canonicalizeExistingPath(givenRoot);

  return await withRegistryLockAsync(async () => {
    // Read once the lock is held, so a touch made while this call waited is not in the future.
    const now = givenNow ?? new Date();
    const classifyAsync = async (claim: DeviceClaim): Promise<ClassifiedClaim> => ({
      ...claim,
      liveness: await classifyClaimAsync(claim, { now, probeLock }),
    });
    const currentAsync = async (claim: DeviceClaim): Promise<ClassifiedClaim | null> => {
      const current = readClaim(claim.backend, claim.id);
      return current == null ? null : await classifyAsync(current);
    };
    const stillStaleAsync = async (claim: DeviceClaim): Promise<boolean> => {
      const current = await currentAsync(claim);
      return current != null && isSameClaim(current, claim) && current.liveness === 'stale';
    };

    pruneUnreadableClaims(now.getTime());
    let claims = await Promise.all(readClaims().map(classifyAsync));
    let inventory = await listDevices(claims);

    for (;;) {
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
        explicit,
        matches,
        isCreated,
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
          const current = readClaim(claim.backend, claim.id);
          if (current != null && isSameClaim(current, claim)) {
            releaseClaim(claim);
          }
          continue;
        }
        if (claim.liveness !== 'stale') {
          continue;
        }
        if (gone) {
          if (await stillStaleAsync(claim)) {
            removeStale(claim, 'device-gone');
          }
        } else if (
          claim.created &&
          deleteDevice &&
          now.getTime() - Date.parse(claim.touchedAt) > CREATED_DEVICE_EXPIRY_MS &&
          (await stillStaleAsync(claim))
        ) {
          try {
            await deleteDevice(claim);
            removeStale(claim, 'expired');
            inventory = inventory.filter((candidate) => candidate.id !== claim.id);
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
        case 'claimed':
        case 'not-found':
          return choice;

        case 'take':
        case 'boot': {
          const replaced = claims.find(
            (claim) => claim.backend === backend && claim.id === choice.candidate.id
          );
          if (replaced) {
            const current = await currentAsync(replaced);
            if (current == null || !isSameClaim(current, replaced) || current.liveness === 'live') {
              // The claim changed during the inventory. Choose again from what its file says now.
              claims = claims.filter((claim) => claim !== replaced);
              if (current != null) {
                claims.push(current);
              }
              continue;
            }
            removeStale(replaced, 'taken-over');
          }
          try {
            writeClaim(choice.claim);
            return choice;
          } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
              throw error;
            }
          }
          // Claimed since the registry was read, or held by a claim file still being written.
          // Choose again from what the file says now.
          const current = await currentAsync(choice.claim);
          claims = claims.filter(
            (claim) => !(claim.backend === backend && claim.id === choice.candidate.id)
          );
          if (current != null) {
            claims.push(current);
          } else {
            inventory = inventory.filter((candidate) => candidate.id !== choice.candidate.id);
          }
          continue;
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
            booted: true,
          };
          writeClaim(claim);
          return { kind: 'created', candidate, claim };
        }
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
