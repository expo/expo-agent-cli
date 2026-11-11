import { EXIT_OUTCOME_FAILED, EXIT_OUTCOME_TIMEOUT } from '../exitCodes';
import { PROGRAM_PREFIX } from '../programName';
import { CommandError } from '../utils/errors';
import type { AttemptReference, DetachedObservation } from './devRunTypes';
import { equivalentStartupRequest, type StartupRequest } from './startupRequest';

export type StartRefusal =
  | { kind: 'observe' | 'stop-and-start' | 'observe-stop' | 'discard'; attempt: AttemptReference }
  | { kind: 'uncertain'; attempt: AttemptReference | null; detail: string };

export function classifyDetachedStart(
  observation: DetachedObservation,
  request?: StartupRequest
): StartRefusal | null {
  switch (observation.kind) {
    case 'none':
      return null;
    case 'interrupted':
      return { kind: 'discard', attempt: observation.attempt };
    case 'uncertain':
      return observation;
    case 'live': {
      const { attempt, progress } = observation;
      if (
        progress.kind === 'starting' &&
        request &&
        attempt.request &&
        equivalentStartupRequest(request, attempt.request)
      )
        return { kind: 'observe', attempt };
      if (progress.kind === 'unaccounted')
        return { kind: 'uncertain', attempt, detail: progress.detail };
      return {
        kind:
          progress.kind === 'stopping' || progress.kind === 'unknown'
            ? 'observe-stop'
            : 'stop-and-start',
        attempt,
      };
    }
  }
}

export const discardRunCommand = (id: string) => `${PROGRAM_PREFIX} dev:stop --discard-run ${id}`;

export function ownershipError(message: string, code = 'DEV_START_UNCERTAIN'): CommandError {
  return Object.assign(new CommandError(code, message), { exitCode: EXIT_OUTCOME_FAILED });
}

export function detachedStartError(refusal: StartRefusal): CommandError {
  const { attempt } = refusal;
  const details = attempt
    ? `Detached run ${attempt.id}${attempt.pid ? ` (pid ${attempt.pid})` : ''}.${attempt.logFile ? ` Log: ${attempt.logFile}.` : ''}`
    : '';
  const data = attempt
    ? { pid: attempt.pid, logFile: attempt.logFile, attemptId: attempt.id }
    : undefined;
  if (refusal.kind === 'observe')
    return Object.assign(
      ownershipError(
        `${details} The matching run is still starting. No new work was started. Observe its log or check status again.`,
        'DEV_START_IN_PROGRESS'
      ),
      { exitCode: EXIT_OUTCOME_TIMEOUT, data, suggestedCommand: `${PROGRAM_PREFIX} dev:logs` }
    );
  if (refusal.kind === 'uncertain')
    return Object.assign(
      ownershipError(
        `${details} ${refusal.detail} Read its log and check status again; the record was retained.`
      ),
      { data }
    );
  if (refusal.kind === 'discard')
    return Object.assign(
      ownershipError(
        `${details} The owner ended without releasing ownership; subprocesses may survive. Discard only this record with "${discardRunCommand(refusal.attempt.id)}". This does not stop processes or EAS sessions.`
      ),
      {
        data,
        attemptId: refusal.attempt.id,
        suggestedCommand: discardRunCommand(refusal.attempt.id),
      }
    );
  return Object.assign(
    ownershipError(
      `${details} Another detached run holds startup ownership. No new work was started. Read its log, then check status or stop it before starting again.`,
      'DEV_START_BUSY'
    ),
    { data }
  );
}
