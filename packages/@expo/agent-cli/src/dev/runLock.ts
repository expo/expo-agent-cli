// @ref llp/0004-smart-start-and-project-state.rfc.md §Dev-server lock
// The `dev` run's half of the lock: taken before a build step, and the stop between steps.

import { servesAnotherProjectAsync } from '../devLock/port';
import { acquireDevServerLockAsync } from '../devLock/server';
import type { DevServerLockHandle } from '../devLock/types';
import { isDevServerStep } from './forwardedArgs';
import type { StartPlan } from '../project/types';
import { CommandError } from '../utils/errors';

/** The run's dev-server lock, once the run or a step took it. */
export type RunLock = { lock: DevServerLockHandle | null };

/**
 * Take the run's lock with phase `building` when a step runs before the dev-server step.
 *
 * Null when the plan serves first or serves nothing, when its planned port answers for another
 * project, or when the lock cannot be taken: the dev-server step then takes it as before.
 */
export async function takeBuildingLockAsync(
  projectRoot: string,
  plan: StartPlan
): Promise<DevServerLockHandle | null> {
  const port = plan.devServerPort?.port;
  const serving = plan.steps.findIndex(isDevServerStep);
  if (port == null || serving <= 0 || (await servesAnotherProjectAsync(projectRoot, port))) {
    return null;
  }
  const result = await acquireDevServerLockAsync({
    url: `http://127.0.0.1:${port}`,
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    projectRoot,
    easPlatform: null,
    easOpenFinished: false,
    phase: 'building',
  });
  return result.status === 'acquired' ? result.lock : null;
}

/** The stop of a run that a signal reached between steps. */
export function interruptedError(signal: NodeJS.Signals): CommandError {
  const error = new CommandError(
    'DEV_INTERRUPTED',
    `The dev run stopped on ${signal}. The step it reached ended, and no later step ran. An EAS build that was already submitted keeps running on EAS; "eas build:cancel" ends it.`
  );
  error.exitCode = 128 + (signal === 'SIGINT' ? 2 : 15);
  return error;
}
