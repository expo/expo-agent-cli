// @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port
// The dev server port of a `dev` plan: picked before the plan is printed, and set on every step
// that serves.

import type { DevServerLockInfo } from '../devLock/types';
import { EXIT_OUTCOME_FAILED } from '../exitCodes';
import type { PlanPlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import type { StartPlan } from '../project/types';
import { CommandError } from '../utils/errors';
import { isDevServerStep, withDevServerPort } from './forwardedArgs';
import { findFreePortAsync, resolvePlannedPortAsync } from './portCollision';
import type { DevOptions } from './resolveOptions';
import { devServerRunningReason, runningDevServerAsync } from './runningDevServer';

/**
 * Pick the dev server port and set it on every step that serves. With a live lock, list no steps.
 */
export async function planDevServerPortAsync(
  projectRoot: string,
  lock: DevServerLockInfo | null,
  forwardedPlan: StartPlan,
  options: DevOptions
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
    const planned = await resolvePlannedPortAsync(options.port);
    if (!planned.bindable && options.port != null && options.mode !== 'plan') {
      throw await portDemandedError(options.port, options.platform);
    }
    plan = {
      ...withDevServerPort(forwardedPlan, planned.port),
      // A port the plan probed is only the port that was free when the plan was printed. A named
      // `--port` is not picked, so nothing is said about it.
      reasons:
        options.mode === 'plan' && options.port == null
          ? [...forwardedPlan.reasons, 'The dev server port is picked again when the plan runs.']
          : forwardedPlan.reasons,
      devServerPort:
        options.port != null
          ? { port: planned.port, movedFrom: null, state: 'named', taken: !planned.bindable }
          : { port: planned.port, movedFrom: planned.movedFrom, state: 'picked' },
    };
  }
  return plan;
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
  const { findPortListenerAsync } = require('./portListener') as typeof import('./portListener');
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
