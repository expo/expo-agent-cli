import type { DevServerLockInfo } from '../devLock';
import { PROGRAM_PREFIX } from '../programName';
import { quoteArgument } from '../utils/consent';
import type { AttemptReference, DetachedObservation, RunProgress } from './devRunTypes';
import { recoveryStartCommand } from './recoveryRequest';
import type { StartupRequest } from './startupRequest';

export type RecoveryAction =
  | { kind: 'observe'; phase: RunProgress['kind']; attempt: AttemptReference | null }
  | { kind: 'start' | 'stop-and-start'; request: StartupRequest; why: string | null }
  | { kind: 'discard-record'; attempt: AttemptReference }
  | { kind: 'uncertain'; attempt: AttemptReference | null; detail: string };

export interface RecoveryMetadata {
  kind: RecoveryAction['kind'];
  attempt?: AttemptReference;
}

export function decideRecovery({
  ownership = { kind: 'none' },
  lock,
  request,
  needsStart,
  why = null,
}: {
  ownership?: DetachedObservation;
  lock: DevServerLockInfo | null;
  request: StartupRequest;
  needsStart: boolean;
  why?: string | null;
}): RecoveryAction | null {
  if (ownership.kind === 'interrupted')
    return { kind: 'discard-record', attempt: ownership.attempt };
  if (ownership.kind === 'uncertain')
    return { kind: 'uncertain', attempt: ownership.attempt, detail: ownership.detail };
  if (ownership.kind === 'live') {
    if (ownership.progress.kind !== 'running')
      return { kind: 'observe', phase: ownership.progress.kind, attempt: ownership.attempt };
  } else if (lock) {
    if (lock.phase === 'building' || lock.phase === 'finishing')
      return {
        kind: 'observe',
        phase: lock.phase === 'building' ? 'starting' : 'stopping',
        attempt: null,
      };
    if (lock.easPlatform && lock.easOpenFinished !== true)
      return { kind: 'observe', phase: 'starting', attempt: null };
  }
  if (!needsStart) return null;
  return { kind: lock || ownership.kind === 'live' ? 'stop-and-start' : 'start', request, why };
}

export function renderRecovery(action: RecoveryAction): {
  command: string;
  why: string | null;
  recovery: RecoveryMetadata;
} {
  const attempt = 'attempt' in action ? action.attempt : null;
  const recovery: RecoveryMetadata = {
    kind: action.kind,
    ...(attempt ? { attempt: { id: attempt.id, pid: attempt.pid, logFile: attempt.logFile } } : {}),
  };
  const observe = attempt?.logFile ? `${PROGRAM_PREFIX} dev:logs` : `${PROGRAM_PREFIX} status`;
  switch (action.kind) {
    case 'observe':
      return {
        command: observe,
        why:
          action.phase === 'starting'
            ? `The run is still starting. ${attempt?.logFile ? 'Read its logs and check status again.' : 'Read the foreground terminal and check status again.'}`
            : `The run's ${action.phase === 'stopping' ? 'cleanup is still in progress' : 'completion is not established'}. Observe it before starting another run.`,
        recovery,
      };
    case 'uncertain':
      return {
        command: observe,
        why: `${action.detail} Ownership is uncertain; preserve its evidence and check again.`,
        recovery,
      };
    case 'discard-record':
      return {
        command: `${PROGRAM_PREFIX} dev:stop --discard-run ${quoteArgument(action.attempt.id)}`,
        why: `Run ${action.attempt.id} was interrupted. This discards only its ownership record. It does not stop processes or sessions.`,
        recovery,
      };
    case 'start':
    case 'stop-and-start':
      return {
        command: `${action.kind === 'stop-and-start' ? `${PROGRAM_PREFIX} dev:stop && ` : ''}${recoveryStartCommand(action.request)}`,
        why:
          action.why ??
          (action.kind === 'stop-and-start'
            ? 'Stop the owned dev-server process before starting another run. Plain stop preserves sessions.'
            : null),
        recovery,
      };
  }
}
