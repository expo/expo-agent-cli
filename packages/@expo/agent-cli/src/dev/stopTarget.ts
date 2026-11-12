import { devicesDisabled, type ReleasedDevice } from '../deviceBinding';
import { keptDevices } from '../deviceBinding/records';
import { readDevServerLockAsync, type DevServerLockInfo } from '../devLock';
import { observeDetachedRunAsync, captureDetachedRun } from './detachedOwnership';
import type { DetachedObservation, RunProgress } from './devRunTypes';
import type { DevStopOptions } from './resolveStopOptions';
import type { DevStopReportOptions } from './stopTypes';

export type OwnerEvidence = Exclude<DetachedObservation, { kind: 'none' }>;
export type StopTarget =
  | { kind: 'skip' }
  | { kind: 'discard'; id: string }
  | { kind: 'locked'; lock: DevServerLockInfo }
  | { kind: 'unlocked'; elsewhereLock: DevServerLockInfo | null; cleanResources: boolean }
  | {
      kind: 'owner';
      observation: OwnerEvidence;
      lock: DevServerLockInfo | null;
      devices: ReleasedDevice[];
      forcedRecord: ReturnType<typeof captureDetachedRun>;
    };

type Constraint =
  | { kind: 'project' }
  | { kind: 'owned-child'; child: DevStopReportOptions['ownedChild'] };

/** Resolve once. Waiting and cleanup never switch to a later lock, owner, or binding. */
export async function resolveStopTargetAsync(
  root: string,
  options: DevStopOptions,
  constraint: Constraint,
  deadline: number
): Promise<StopTarget> {
  if (options.discardRun != null) return { kind: 'discard', id: options.discardRun };
  const [lock, observation] = await Promise.all([
    readDevServerLockAsync(root, { timeoutMs: Math.max(1, Math.min(2000, deadline - Date.now())) }),
    observeDetachedRunAsync(root, { deadline }),
  ]);
  if (constraint.kind === 'owned-child') {
    const child = constraint.child;
    if (!child || child.exitCode !== null || child.signalCode !== null || lock?.pid !== child.pid)
      return { kind: 'skip' };
  }
  const ownerPort = observation.kind === 'live' ? ownerPortOf(observation) : null;
  const knownPort = lock?.port ?? ownerPort;
  if (options.port != null && options.port !== knownPort) {
    return { kind: 'unlocked', elsewhereLock: lock, cleanResources: observation.kind === 'none' };
  }
  if (observation.kind !== 'none') {
    return {
      kind: 'owner',
      observation,
      lock: lock?.pid === observation.attempt?.pid ? lock : null,
      devices: devicesDisabled() ? [] : keptDevices(root, options.platform),
      forcedRecord: lock ? captureDetachedRun(root, lock.pid) : null,
    };
  }
  return lock
    ? { kind: 'locked', lock }
    : { kind: 'unlocked', elsewhereLock: null, cleanResources: true };
}

export function progressPort(progress: RunProgress): number | null {
  if (progress.kind === 'unknown') return null;
  if (progress.kind === 'running') return progress.server.port;
  return progress.metro.kind === 'awaiting'
    ? progress.metro.plannedPort
    : (progress.metro.server?.port ?? null);
}

export function ownerPortOf(
  observation: Extract<DetachedObservation, { kind: 'live' }>
): number | null {
  const requested = observation.attempt.request?.port;
  return progressPort(observation.progress) ?? (typeof requested === 'number' ? requested : null);
}
