import { EXIT_OUTCOME_FAILED, EXIT_OUTCOME_TIMEOUT } from '../exitCodes';
import { PROGRAM_PREFIX } from '../programName';
import { renderStartRefusal } from './recovery';
import { CommandError } from '../utils/errors';
import type { AttemptReference, DetachedObservation } from './devRunTypes';
import { equivalentStartupRequest, type StartupRequest } from './startupRequest';

export type StartRefusal = (
  | { kind: 'observe' | 'stop-and-start' | 'observe-stop' | 'discard'; attempt: AttemptReference }
  | { kind: 'uncertain'; attempt: AttemptReference | null; detail: string }
) & { request?: StartupRequest };

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
        return { kind: 'observe', attempt, request };
      if (progress.kind === 'unaccounted')
        return { kind: 'uncertain', attempt, detail: progress.detail, request };
      return {
        kind:
          progress.kind === 'stopping' || progress.kind === 'unknown'
            ? 'observe-stop'
            : 'stop-and-start',
        attempt,
        request,
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
  const recovery = renderStartRefusal(refusal);
  const details = attempt
    ? `Detached run ${attempt.id}${attempt.pid ? ` (pid ${attempt.pid})` : ''}.${attempt.logFile ? ` Log: ${attempt.logFile}.` : ''}`
    : '';
  const code =
    refusal.kind === 'observe'
      ? 'DEV_START_IN_PROGRESS'
      : refusal.kind === 'discard' || refusal.kind === 'uncertain'
        ? 'DEV_START_UNCERTAIN'
        : 'DEV_START_BUSY';
  return Object.assign(
    ownershipError(
      `${details} No new work was started. ${recovery.why ?? ''} How: run "${recovery.command}".`,
      code
    ),
    {
      exitCode: refusal.kind === 'observe' ? EXIT_OUTCOME_TIMEOUT : EXIT_OUTCOME_FAILED,
      suggestedCommand: recovery.command,
      data: {
        ...(attempt ? { pid: attempt.pid, logFile: attempt.logFile, attemptId: attempt.id } : {}),
        recovery: recovery.recovery,
      },
      ...(refusal.kind === 'discard' ? { attemptId: refusal.attempt.id } : {}),
    }
  );
}
