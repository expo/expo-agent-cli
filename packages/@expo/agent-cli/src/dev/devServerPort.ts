// @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port
// The dev server port of a `dev` plan: picked before the plan is printed, and set on every step
// that serves.

import type { DevServerLockInfo } from '../devLock/types';
import { EXIT_OUTCOME_FAILED } from '../exitCodes';
import { Log } from '../log';
import type { PlanPlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import type { StartPlan } from '../project/types';
import { CommandError } from '../utils/errors';
import { isDevServerStep, withDevServerPort } from './forwardedArgs';
import { findFreePortAsync, formatPortMove, resolvePlannedPortAsync } from './portCollision';
import { findPortListenerAsync } from './portListener';
import type { DevOptions } from './resolveOptions';
import { DEFAULT_DEV_STOP_SIGNAL, DEFAULT_DEV_STOP_TIMEOUT_MS } from './resolveStopOptions';
import { devServerRunningReason, runningDevServerAsync } from './runningDevServer';
import {
  claimEndedRunAsync,
  judgeEndedRunAsync,
  servesPortOf,
  stopUntrackedDevServerAsync,
  untrackedDevServerClause,
  type UntrackedDevServer,
} from './untrackedDevServer';

/** What the dev server a killed run left means for this run's port. */
export interface UntrackedPortClaim {
  /** The port this run takes from it: a run stopped it, or the run a plan describes stops it. */
  claimedPort: number | null;
  /** What a plan says about it. Empty for a run, which warns instead. */
  reasons: string[];
}

export const NO_CLAIM: UntrackedPortClaim = { claimedPort: null, reasons: [] };

/**
 * Pick the dev server port and set it on every step that serves. With a live lock, list no steps.
 */
export async function planDevServerPortAsync(
  projectRoot: string,
  lock: DevServerLockInfo | null,
  forwardedPlan: StartPlan,
  options: DevOptions,
  claim: UntrackedPortClaim
): Promise<StartPlan> {
  // @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port —
  // the port is picked here, before the plan is printed, and set on every step that
  // serves. Left to `expo run:*`, a busy port skips its dev server, deep-links the app to whatever
  // holds the port, and exits 0 [observed — live suite, 2026-10-05].
  const serving = forwardedPlan.steps.filter(isDevServerStep).at(-1);
  let plan: StartPlan = forwardedPlan;
  if (lock) {
    // Only a plan gets here with a live lock; a run stopped on it before the probe. The plan lists
    // no steps, because the run does none, whatever the forwarded options made of the last step.
    const running = await runningDevServerAsync(projectRoot, lock);
    plan = {
      ...forwardedPlan,
      steps: [],
      reasons: [...forwardedPlan.reasons, devServerRunningReason(running)],
      devServerPort: { port: lock.port, movedFrom: null, state: 'running', phase: running.phase },
    };
  } else if (serving) {
    const planned =
      claim.claimedPort != null
        ? { port: claim.claimedPort, movedFrom: null, bindable: true }
        : await resolvePlannedPortAsync(options.port);
    if (!planned.bindable && options.port != null && options.mode !== 'plan') {
      throw await portDemandedError(options.port, options.platform);
    }
    plan = {
      ...withDevServerPort(forwardedPlan, planned.port),
      // A port the plan probed is only the port that was free when the plan was printed. A named
      // `--port` is not picked, so nothing is said about it.
      reasons: [
        ...forwardedPlan.reasons,
        ...claim.reasons,
        ...(options.mode === 'plan' && options.port == null && claim.claimedPort == null
          ? ['The dev server port is picked again when the plan runs.']
          : []),
      ],
      devServerPort:
        options.port != null
          ? { port: planned.port, movedFrom: null, state: 'named', taken: !planned.bindable }
          : { port: planned.port, movedFrom: planned.movedFrom, state: 'picked' },
    };
  }
  return plan;
}

/** The dev server a killed run of this project left, as a run finds it before the probe. */
export interface UntrackedDevServerFinding {
  /** The server a run stops before its first step, or null. Always null for a plan. */
  server: UntrackedDevServer | null;
  claim: UntrackedPortClaim;
}

/**
 * Find the dev server a killed run of this project left, before the probe, and say what its port
 * means for this run. Nothing is signalled here: a run stops it only after its refusals
 * ({@link replaceUntrackedDevServerAsync}), so a run that refuses leaves it serving. Nothing can
 * follow, reuse or stop it through a lock, and a second one on the next port would leave two Metros
 * for one project, so a run that goes on replaces it; a plan only names it.
 */
export async function findUntrackedDevServerAsync(
  projectRoot: string,
  lock: DevServerLockInfo | null,
  options: DevOptions
): Promise<UntrackedDevServerFinding> {
  // @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port
  if (lock) return { server: null, claim: NO_CLAIM };
  if (options.mode === 'plan') {
    const verdict = await judgeEndedRunAsync(projectRoot);
    if (verdict?.kind !== 'orphan') return { server: null, claim: NO_CLAIM };
    const takesPort = servesPortOf(verdict.server, options.port);
    return {
      server: null,
      claim: {
        claimedPort: takesPort ? verdict.server.port : null,
        reasons: [
          `${untrackedDevServerClause(verdict.server)}. The run stops it${takesPort ? ` and takes port ${verdict.server.port}` : ''}.`,
        ],
      },
    };
  }
  const server = await claimEndedRunAsync(projectRoot);
  if (server == null) return { server: null, claim: NO_CLAIM };
  const takesPort = servesPortOf(server, options.port);
  return { server, claim: { claimedPort: takesPort ? server.port : null, reasons: [] } };
}

/**
 * Replace the server {@link findUntrackedDevServerAsync} found: after the run's refusals, and only
 * for a plan whose step serves, so a run that refuses or serves nothing leaves it serving. It is
 * stopped by its pid, with a warning that names its port and pid.
 *
 * @returns the plan to run: the same one, or one whose port is picked again with no claim when the
 * server's pid went and something else still answers on its port (a named `--port` on it is then
 * `PORT_IN_USE`).
 * @throws {CommandError} `UNTRACKED_DEV_SERVER`, an outcome, when a run that would take its port
 * could not stop it.
 */
export async function replaceUntrackedDevServerAsync(
  projectRoot: string,
  plan: StartPlan,
  { server }: UntrackedDevServerFinding,
  options: DevOptions
): Promise<StartPlan> {
  // @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port
  if (server == null || !plan.steps.some(isDevServerStep)) return plan;
  // Picked again over the run's own plan: a run adds no reasons, and the port is set on every step
  // that serves. A server was found, so no lock answered.
  return (await stopForRunAsync(projectRoot, server, options))
    ? plan
    : await planDevServerPortAsync(projectRoot, null, plan, options, NO_CLAIM);
}

/** Stop it, and say whether the run's claim on its port still holds. */
async function stopForRunAsync(
  projectRoot: string,
  server: UntrackedDevServer,
  options: DevOptions
): Promise<boolean> {
  const takesPort = servesPortOf(server, options.port);
  const stopped = await stopUntrackedDevServerAsync(projectRoot, server, {
    signal: DEFAULT_DEV_STOP_SIGNAL,
    timeoutMs: DEFAULT_DEV_STOP_TIMEOUT_MS,
  });
  if (stopped.stopped) {
    const portLeft = takesPort && stopped.portStillAnswering;
    Log.warn(
      `${untrackedDevServerClause(server)}. It was stopped${
        portLeft
          ? `, but port ${server.port} still answers, so this run does not take it`
          : takesPort
            ? `, and this run takes port ${server.port}`
            : ''
      }.`
    );
    return !portLeft;
  }
  if (!takesPort) {
    // The run serves elsewhere, so the server it could not stop is not in its way. Its record is
    // replaced by this run's, so only `--force` will name it a dev server again.
    Log.warn(
      `${untrackedDevServerClause(server)}. It is still running: ${stopped.detail}. ${
        stopped.signal != null
          ? `Stop it with "${PROGRAM_PREFIX} dev:stop --port ${server.port} --force --signal SIGKILL".`
          : `Stop pid ${server.listener.pid} as the user that owns it.`
      }`
    );
    return true;
  }
  // A signal that reached it and did not end it: SIGKILL ends it. One that did not reach it (another
  // user's process) will not reach it either.
  const command =
    stopped.signal != null
      ? `${PROGRAM_PREFIX} dev:stop --port ${server.port} --signal SIGKILL`
      : null;
  const error = new CommandError(
    'UNTRACKED_DEV_SERVER',
    [
      `${untrackedDevServerClause(server)}, and it could not be stopped, so nothing was started.`,
      `Why: ${stopped.detail}.`,
      command
        ? `How: run "${command}", then run this command again.`
        : `How: stop pid ${server.listener.pid} as the user that owns it, then run this command again.`,
    ].join('\n')
  );
  if (command) error.suggestedCommand = command;
  error.exitCode = EXIT_OUTCOME_FAILED;
  error.data = { port: server.port, pid: server.listener.pid };
  throw error;
}

/**
 * The failure for a `--port` that was named and could not be had.
 *
 * An **outcome**, not a tool error and not a person: the command worked, and the thing it was asked
 * to do did not happen (llp/0010 §Exit codes). It never suggests the command that just failed —
 * running it again unchanged stops in the same place until the port is freed.
 */
export async function portDemandedError(
  port: number,
  platform: PlanPlatform
): Promise<CommandError> {
  const [listener, free] = await Promise.all([
    findPortListenerAsync(port),
    findFreePortAsync(port + 1),
  ]);
  const holder = listener
    ? `pid ${listener.pid}${listener.command ? ` (${listener.command})` : ''}`
    : 'a process this machine would not name';

  const error = new CommandError(
    'PORT_IN_USE',
    [
      `Port ${port} is taken, so no dev server was started on it.`,
      `Why: ${holder} is listening on it, and --port ${port} is a requirement rather than a preference — moving the dev server to another port would leave every URL and every command that names ${port} pointing at nothing.`,
      `How: free the port with "${PROGRAM_PREFIX} dev:stop --port ${port} --force", which stops it only when it answers as an Expo dev server${listener ? ` and pid ${listener.pid} looks like one` : ''}${free == null ? '' : `, or start on a free port instead with "${PROGRAM_PREFIX} dev --${platform} --port ${free}"`}. Leaving --port out lets this command pick a free port on its own.`,
    ].join('\n')
  );
  // Never the command that just failed: it would stop in exactly the same place.
  error.suggestedCommand =
    free == null
      ? `${PROGRAM_PREFIX} dev:stop --port ${port} --force`
      : `${PROGRAM_PREFIX} dev --${platform} --port ${free}`;
  error.exitCode = EXIT_OUTCOME_FAILED;
  return error;
}

/**
 * Warn on stderr, including in JSON mode, when the plan or retry picks a different port.
 *
 * @param expected The port to suggest requiring, or null if it is unknown.
 * @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port
 */
export function warnPortMove(
  move: Parameters<typeof formatPortMove>[0],
  expected: number | null
): void {
  Log.warn(
    `${formatPortMove(move)} ${
      expected == null
        ? 'Pass --port to name one yourself.'
        : `Pass --port ${expected} to require that port instead of moving, which fails when it is taken.`
    }`
  );
}
