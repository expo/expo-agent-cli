// @ref llp/0030-one-device-per-agent.rfc.md §Release and cleanup
// A deleted worktree never runs `dev:stop`, and there is no daemon to notice. So the next
// allocation or `dev:stop` of any worktree reaps its claims: the local device this CLI booted is
// shut down, and its EAS session is stopped.

import {
  isDeletedWorktreeAsync,
  isSameClaim,
  readClaim,
  readClaims,
  removeClaimFile,
  withRegistryLockAsync,
  writeClaim,
  type DeviceBackend,
  type DeviceClaim,
} from '../deviceClaims';
import { event } from '../deviceClaims/events';
import { readDevServerLockAsync } from '../devLock';
import { canonicalizeExistingPath } from '../utils/dir';
import { spawnCaptureAsync } from '../utils/spawnCapture';
import { CREATED_SIMULATOR_PREFIX, parseSimulators, shutdownDeviceAsync } from './bootDevice';

/** One claim of a deleted worktree, and what was done about it. */
export interface ReapedDevice {
  id: string;
  backend: DeviceBackend;
  /** The deleted worktree that held the claim. */
  projectRoot: string;
  /** The claim was dropped. */
  released: boolean;
  /** The local device was shut down, or the EAS session was stopped. */
  shutDown: boolean;
  /** The simulator was deleted: one this CLI created and named `agent-cli N`. */
  deleted: boolean;
  /** Why a shutdown, delete or stop failed. Null when none did. */
  reason: string | null;
}

export interface ReapOptions {
  probeLock?: (projectRoot: string) => Promise<unknown>;
  stopEasSession?: (
    liveRoot: string,
    sessionId: string
  ) => Promise<{ ok: boolean; reason: string | null }>;
}

/**
 * Reap every claim whose worktree was deleted ({@link isDeletedWorktreeAsync}). The grace period
 * does not apply.
 *
 * A local claim is taken in `liveRoot`'s name under the registry lock, so no other worktree takes
 * the device while it shuts down outside the lock. A failed shutdown or stop is reported, not thrown.
 */
export async function reapDeletedWorktreeClaimsAsync(
  liveRoot: string,
  { probeLock = readDevServerLockAsync, stopEasSession = stopEasSessionAsync }: ReapOptions = {}
): Promise<ReapedDevice[]> {
  const isDeletedAsync = (claim: DeviceClaim) =>
    isDeletedWorktreeAsync(claim.projectRoot, probeLock);

  const found: DeviceClaim[] = [];
  for (const claim of readClaims()) {
    if (await isDeletedAsync(claim)) {
      found.push(claim);
    }
  }
  if (found.length === 0) {
    return [];
  }
  const root = canonicalizeExistingPath(liveRoot);
  const stillDeletedAsync = async (claim: DeviceClaim): Promise<boolean> => {
    const current = readClaim(claim.backend, claim.id);
    return current != null && isSameClaim(current, claim) && (await isDeletedAsync(current));
  };

  const reaped: ReapedDevice[] = [];
  const report = (
    claim: DeviceClaim,
    outcome: Omit<ReapedDevice, 'id' | 'backend' | 'projectRoot'>
  ) => {
    reaped.push({
      id: claim.id,
      backend: claim.backend,
      projectRoot: claim.projectRoot,
      ...outcome,
    });
    event('device_claim_reaped', {
      backend: claim.backend,
      id: claim.id,
      projectRoot: claim.projectRoot,
      released: outcome.released,
      shutDown: outcome.shutDown,
    });
  };

  const taken = await withRegistryLockAsync(async () => {
    const takes: {
      claim: DeviceClaim;
      take: DeviceClaim;
      backend: 'local-ios' | 'local-android';
    }[] = [];
    for (const claim of found) {
      if (claim.backend === 'eas' || !(await stillDeletedAsync(claim))) {
        continue;
      }
      removeClaimFile(claim);
      if (!claim.booted && !claim.created) {
        report(claim, { released: true, shutDown: false, deleted: false, reason: null });
        continue;
      }
      const at = new Date().toISOString();
      const take = { ...claim, projectRoot: root, pid: process.pid, claimedAt: at, touchedAt: at };
      writeClaim(take);
      takes.push({ claim, take, backend: claim.backend });
    }
    return takes;
  });

  for (const { claim, take, backend } of taken) {
    const shutdown = await shutdownDeviceAsync(claim.id, backend);
    const deletion =
      shutdown.ok && claim.created && backend === 'local-ios'
        ? await deleteCreatedSimulatorAsync(claim.id)
        : null;
    await withRegistryLockAsync(async () => {
      const current = readClaim(take.backend, take.id);
      if (current != null && isSameClaim(current, take)) {
        removeClaimFile(take);
      }
    });
    report(claim, {
      released: true,
      shutDown: shutdown.ok,
      deleted: deletion?.ok ?? false,
      reason: shutdown.reason ?? deletion?.reason ?? null,
    });
  }

  for (const claim of found.filter(({ backend }) => backend === 'eas')) {
    if (!(await stillDeletedAsync(claim))) {
      continue;
    }
    const stopped = await stopEasSession(root, claim.id);
    let released = false;
    if (stopped.ok) {
      released = await withRegistryLockAsync(async () => {
        if (!(await stillDeletedAsync(claim))) {
          return false;
        }
        removeClaimFile(claim);
        return true;
      });
    }
    report(claim, { released, shutDown: stopped.ok, deleted: false, reason: stopped.reason });
  }
  return reaped;
}

/** One line for a report: which device, whose, and what was done. */
export function describeReapedDevice(device: ReapedDevice): string {
  const done =
    device.backend === 'eas'
      ? device.shutDown
        ? 'session stopped'
        : `session still running — ${device.reason ?? 'no reason given'}`
      : device.deleted
        ? 'shut down and deleted'
        : device.shutDown
          ? 'shut down'
          : device.reason
            ? `still up — ${device.reason}`
            : 'left as it was';
  return `${device.id} of the deleted worktree ${device.projectRoot} · ${done}${
    device.released ? ', claim dropped' : ', claim kept'
  }`;
}

/**
 * Delete a simulator only when its name says this CLI created it, so a simulator a person named
 * is never deleted. A missing name is not proof, so nothing is deleted then.
 */
async function deleteCreatedSimulatorAsync(
  udid: string
): Promise<{ ok: boolean; reason: string | null }> {
  const listed = await spawnCaptureAsync('xcrun', ['simctl', 'list', 'devices', '-j'], {
    timeoutMs: 60_000,
  });
  const name = parseSimulators(listed.stdout).find((entry) => entry.udid === udid)?.name;
  if (name == null || !name.startsWith(CREATED_SIMULATOR_PREFIX)) {
    return { ok: false, reason: null };
  }
  const deleted = await spawnCaptureAsync('xcrun', ['simctl', 'delete', udid], {
    timeoutMs: 60_000,
  });
  return deleted.exitCode === 0
    ? { ok: true, reason: null }
    : {
        ok: false,
        reason: `"xcrun simctl delete ${udid}" exited ${deleted.exitCode}: ${
          deleted.stderr.trim() || 'no output'
        }`,
      };
}

async function stopEasSessionAsync(
  liveRoot: string,
  sessionId: string
): Promise<{ ok: boolean; reason: string | null }> {
  const { stopEasSessionAsync: stop } =
    require('../dev/openAppEas') as typeof import('../dev/openAppEas');
  return await stop(liveRoot, sessionId);
}
