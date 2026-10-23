// @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port
// One dev server per project. A foreground `dev` whose plan serves stops on this project's live
// lock: a second server could not hold it, so `status` and `dev:stop` could not see it.

import type { DevServerLockInfo } from '../devLock';
import { EXIT_OUTCOME_FAILED } from '../exitCodes';
import type { NativePlatform, PlanPlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import { probeBundlerAsync } from '../runtime/bundlerStatus';
import { defaultSmokePlatformAsync, smokeCommand } from '../smoke/suggest';
import { CommandError } from '../utils/errors';

/** This project's live dev-server lock, and whether its Metro answers `/status` for this project. */
export type RunningDevServer = { lock: DevServerLockInfo; phase: 'serving' | 'starting' };

/**
 * One `/status` probe of the lock's URL picks the word.
 *
 * `starting` covers a `run:*` build that has not reached Metro, a Metro that is not up, and another
 * project's Metro on the lock's port while this project's busy-port retry moves off it: in each,
 * this project's server is on its way and there is nothing to open against yet.
 */
export async function runningDevServerAsync(
  projectRoot: string,
  lock: DevServerLockInfo
): Promise<RunningDevServer> {
  const probe = await probeBundlerAsync(lock.url, { projectRoot });
  const serving = probe.answering && probe.projectRootMatched !== false;
  return { lock, phase: serving ? 'serving' : 'starting' };
}

/** The stop for a run, with its smoke platform resolved: a `--web` caller gets the project's default. */
export async function devServerRunningStopAsync(
  projectRoot: string,
  lock: DevServerLockInfo,
  platform: PlanPlatform,
  { eas = false }: { eas?: boolean } = {}
): Promise<CommandError> {
  const running = await runningDevServerAsync(projectRoot, lock);
  const smokePlatform =
    platform === 'web' ? await defaultSmokePlatformAsync(projectRoot) : platform;
  return devServerRunningError(running, smokePlatform, { eas });
}

/** One sentence for the plan's `Why` list, when the run stops instead of starting a second server. */
export function devServerRunningReason({ lock, phase }: RunningDevServer): string {
  const state = phase === 'serving' ? 'already running' : 'starting';
  return `This project's dev server is ${state} on port ${lock.port} (pid ${lock.pid}); the run stops instead of starting a second one.`;
}

/**
 * The stop for a foreground `dev` that would serve while this project's dev server runs.
 *
 * An outcome (llp/0010 §Exit codes). Never the command that just failed: it stops in the same
 * place until the running server is stopped.
 */
export function devServerRunningError(
  { lock, phase }: RunningDevServer,
  smokePlatform: NativePlatform,
  { eas = false }: { eas?: boolean } = {}
): CommandError {
  const { port, pid } = lock;
  // A run whose device is on EAS reads the running server on the session.
  const smoke = `${smokeCommand(smokePlatform)}${eas ? ' --eas' : ''}`;
  const navigate = `${PROGRAM_PREFIX} navigate /${eas ? ' --eas' : ''}`;
  const stopAndRetry = `or stop it with "${PROGRAM_PREFIX} dev:stop" and run this command again.`;
  const lines =
    phase === 'serving'
      ? [
          `This project's dev server is already running on port ${port} (pid ${pid}), so nothing was started.`,
          `Why: one project has one dev server. A second one could not hold this project's lock, so "${PROGRAM_PREFIX} status" and "${PROGRAM_PREFIX} dev:stop" could not see it.`,
          `How: use the running server ("${smoke}" checks its bundle and its app, "${navigate}" opens a route), ${stopAndRetry}`,
        ]
      : [
          `This project's dev server is starting on port ${port} (pid ${pid}), so nothing was started.`,
          `Why: its lock is published, and /status on port ${port} does not answer for this project yet: a run:* build that has not reached Metro, a Metro that is not up, or another project's Metro on that port, which this project's server moves off.`,
          `How: wait for it ("${PROGRAM_PREFIX} status" says when it answers), ${stopAndRetry}`,
        ];
  const error = new CommandError('DEV_SERVER_RUNNING', lines.join('\n'));
  error.suggestedCommand = phase === 'serving' ? smoke : `${PROGRAM_PREFIX} status`;
  error.exitCode = EXIT_OUTCOME_FAILED;
  error.data = { port, pid, phase };
  return error;
}
