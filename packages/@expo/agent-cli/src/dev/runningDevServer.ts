// @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port
// One dev server per project. A foreground `dev` whose plan serves stops on this project's live
// lock: a second server could not hold it, so `status` and `dev:stop` could not see it.

import type { DevServerLockInfo } from '../devLock';
import { EXIT_OUTCOME_FAILED } from '../exitCodes';
import type { NativePlatform, PlanPlatform } from '../plan/types';
import type { RunningDevServerPhase } from '../project/types';
import { PROGRAM_PREFIX } from '../programName';
import { probeBundlerAsync } from '../runtime/bundlerStatus';
import { defaultSmokePlatformAsync, smokeCommand } from '../smoke/suggest';
import { CommandError } from '../utils/errors';
import { RUN_PHASE } from './runPhase';

/** This project's live dev-server lock, and what its run does. */
export type RunningDevServer = { lock: DevServerLockInfo; phase: RunningDevServerPhase };

/**
 * The lock's phase, and for a `serving` lock one `/status` probe of its URL, picks the word.
 *
 * `starting` covers a `run:*` build that has not reached Metro, a Metro that is not up, and another
 * project's Metro on the lock's port while this project's busy-port retry moves off it: in each,
 * this project's server is on its way and there is nothing to open against yet.
 */
export async function runningDevServerAsync(
  projectRoot: string,
  lock: DevServerLockInfo
): Promise<RunningDevServer> {
  if (lock.phase !== 'serving') return { lock, phase: lock.phase };
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
  const row = RUN_PHASE[phase];
  return `${row.state(lock)}; the run stops instead of starting a second ${row.second}.`;
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
  const row = RUN_PHASE[phase];
  const error = new CommandError(
    'DEV_SERVER_RUNNING',
    [
      `${row.state(lock)}, so nothing was started.`,
      `Why: ${row.why(lock)}`,
      `How: ${row.how({ smoke, navigate })}`,
    ].join('\n')
  );
  error.suggestedCommand = row.command(smoke);
  error.exitCode = EXIT_OUTCOME_FAILED;
  error.data = { port, pid, phase };
  return error;
}
