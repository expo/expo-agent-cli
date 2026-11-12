import { devicesDisabled, type ReleasedDevice } from '../deviceBinding';
import { keptDevices } from '../deviceBinding/records';
import { readDevServerLockAsync, type DevServerLockInfo } from '../devLock';
import { observeDetachedRunAsync, captureDetachedRun } from './detachedOwnership';
import type { DetachedObservation, RunProgress } from './devRunTypes';
import type { DevStopOptions } from './resolveStopOptions';
import type { StopTargetConstraint } from './stopTypes';

export type OwnerEvidence = Exclude<DetachedObservation, { kind: 'none' }>;
type Selection =
  | { kind: 'skip' }
  | { kind: 'locked'; lock: DevServerLockInfo }
  | { kind: 'unlocked'; elsewhereLock: DevServerLockInfo | null; cleanResources: boolean }
  | { kind: 'foreground'; lock: DevServerLockInfo; observation: OwnerEvidence }
  | { kind: 'owner'; observation: OwnerEvidence; lock: DevServerLockInfo | null };
export type StopTarget =
  | { kind: 'discard'; id: string }
  | Exclude<Selection, { kind: 'owner' | 'foreground' }>
  | (Extract<Selection, { kind: 'foreground' }> & { devices: ReleasedDevice[] })
  | (Extract<Selection, { kind: 'owner' }> & {
      devices: ReleasedDevice[];
      forcedRecord: ReturnType<typeof captureDetachedRun>;
    });

/** Resolve once. Waiting and cleanup never switch to a later lock, owner, or binding. */
export async function resolveStopTargetAsync(
  root: string,
  options: DevStopOptions,
  constraint: StopTargetConstraint,
  deadline: number
): Promise<StopTarget> {
  if (options.discardRun != null) return { kind: 'discard', id: options.discardRun };
  const [lock, observation] = await Promise.all([
    readDevServerLockAsync(root, { timeoutMs: Math.max(1, Math.min(2000, deadline - Date.now())) }),
    observeDetachedRunAsync(root, { deadline }),
  ]);
  const selected = selectStopTarget(lock, observation, options.port, constraint);
  if (selected.kind !== 'owner' && selected.kind !== 'foreground') return selected;
  const devices = devicesDisabled() ? [] : keptDevices(root, options.platform);
  if (selected.kind === 'foreground') return { ...selected, devices };
  const record = selected.lock ? captureDetachedRun(root, selected.lock.pid) : null;
  return {
    ...selected,
    devices,
    forcedRecord: record?.id === selected.observation.attempt?.id ? record : null,
  };
}

/** The requested port and captured child each constrain lock and owner independently. */
export function selectStopTarget(
  lock: DevServerLockInfo | null,
  observation: DetachedObservation,
  port: number | null,
  constraint: StopTargetConstraint
): Selection {
  const child = constraint.kind === 'owned-child' ? constraint.child : null;
  if (child && (child.exitCode !== null || child.signalCode !== null)) return { kind: 'skip' };
  const allowedLock = lock && (!child || lock.pid === child.pid) ? lock : null;
  const allowedOwner =
    !child || (observation.kind === 'live' && observation.attempt.pid === child.pid);
  if (child && !allowedLock && !allowedOwner) return { kind: 'skip' };
  const selectedLock =
    allowedLock && (port == null || allowedLock.port === port) ? allowedLock : null;
  if (selectedLock) {
    if (observation.kind === 'none') return { kind: 'locked', lock: selectedLock };
    if (observation.attempt?.pid != null && observation.attempt.pid !== selectedLock.pid)
      return { kind: 'foreground', lock: selectedLock, observation };
    return { kind: 'owner', lock: selectedLock, observation };
  }
  if (observation.kind !== 'none' && allowedOwner) {
    const ownerPort = observation.kind === 'live' ? ownerPortOf(observation) : null;
    if (port == null || port === ownerPort) return { kind: 'owner', lock: null, observation };
    if (ownerPort == null)
      return {
        kind: 'owner',
        lock: null,
        observation: {
          kind: 'uncertain',
          attempt: observation.attempt,
          detail: `Port ${port} cannot be associated with the captured owner; nothing was signalled.`,
        },
      };
  }
  if (child) return { kind: 'skip' };
  return { kind: 'unlocked', elsewhereLock: lock, cleanResources: observation.kind === 'none' };
}

function progressPort(progress: RunProgress): number | null {
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
