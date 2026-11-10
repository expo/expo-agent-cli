// @ref llp/0004-smart-start-and-project-state.rfc.md §Dev-server lock
// The `dev` run's half of the lock: taken before a build step, and the stop between steps.

import os from 'node:os';

import { takeDevServerLockAsync, type DevServerLockHandle } from '../devLock';
import { servesAnotherProjectAsync } from '../devLock/port';
import { isDevServerStep } from './forwardedArgs';
import type { StartPlan } from '../project/types';
import { CommandError } from '../utils/errors';

/**
 * The `dev` run's lock. It is taken before a build step, the dev-server step answers on it, and it
 * is released when the run ends, so it answers through a port retry and the EAS exit work.
 */
export class RunLock {
  #handle: DevServerLockHandle | null;

  constructor(handle: DevServerLockHandle | null) {
    this.#handle = handle;
  }

  /** The lock a dev-server step answers on, or null when the step takes its own. */
  get handle(): DevServerLockHandle | null {
    return this.#handle;
  }

  /** Keep the lock a dev-server step left: the same one, a new one, or none. */
  keep(handle: DevServerLockHandle | null): void {
    this.#handle = handle;
  }

  /** The step that built now serves: /status answers for this project. */
  serve(): void {
    const handle = this.#handle;
    if (handle?.info.phase === 'building') handle.update({ ...handle.info, phase: 'serving' });
  }

  /**
   * Metro exited after the EAS open started. While the open runs, the run binds the session it
   * returns, so the lock answers `finishing`; once it returned, the session cleanup needs no lock,
   * and a lock left as `serving` would send `dev:stop` to signal a run that is ending its session.
   */
  finish(openReturned: Promise<unknown>): void {
    const handle = this.#handle;
    if (!handle?.info.easOpenFinished && handle) {
      handle.update({ ...handle.info, phase: 'finishing' });
      void openReturned.then(() => {
        if (this.#handle === handle) this.release();
      });
    } else {
      this.release();
    }
  }

  release(): void {
    this.#handle?.release();
    this.#handle = null;
  }
}

/** How a run marks its steps, so a signal knows whether a step has to end first. */
export interface RunSteps {
  /**
   * Run one step, with its EAS exit work. A signal while it runs reaches its child, which ends it.
   */
  stepAsync<T>(work: () => Promise<T>): Promise<T>;
  /** Whether a signal arrived during the run. */
  readonly interrupted: boolean;
  /** Throw `DEV_INTERRUPTED` when a signal arrived during the run. */
  assertNotInterrupted(): void;
}

/**
 * Run `run` under the run's lock, and stop it between steps on SIGINT or SIGTERM.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — a signal ends the step it
 * reaches, and the run starts no later step.
 */
export async function withRunLockAsync<T>(
  projectRoot: string,
  plan: StartPlan,
  easPlatform: 'ios' | 'android' | null,
  run: (lock: RunLock, steps: RunSteps) => Promise<T>
): Promise<T> {
  const lock = new RunLock(await takeBuildingLockAsync(projectRoot, plan, easPlatform));
  let signal: NodeJS.Signals | null = null;
  let running = 0;
  const onSignal = (received: NodeJS.Signals) => {
    signal ??= received;
    // A running step ends first, and the run stops after it. Between steps nothing runs to wait
    // for: end now, as Node does without a listener.
    if (running === 0) process.exit(128 + os.constants.signals[received]);
  };
  const steps: RunSteps = {
    async stepAsync(work) {
      running++;
      try {
        return await work();
      } finally {
        running--;
      }
    },
    get interrupted() {
      return signal != null;
    },
    assertNotInterrupted() {
      if (signal) throw interruptedError(signal);
    },
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    return await run(lock, steps);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    lock.release();
  }
}

/**
 * The run's lock with phase `building`, when a step runs before the dev-server step.
 *
 * Null when the plan serves first or serves nothing, when its planned port answers for another
 * project, or when the lock cannot be taken: the dev-server step then takes it as before.
 */
async function takeBuildingLockAsync(
  projectRoot: string,
  plan: StartPlan,
  easPlatform: 'ios' | 'android' | null
): Promise<DevServerLockHandle | null> {
  const port = plan.devServerPort?.port;
  const serving = plan.steps.findIndex(isDevServerStep);
  if (port == null || serving <= 0 || (await servesAnotherProjectAsync(projectRoot, port))) {
    return null;
  }
  return await takeDevServerLockAsync(projectRoot, port, {
    since: Date.now(),
    easPlatform,
    phase: 'building',
  });
}

/** The stop of a run that a signal reached between steps. */
function interruptedError(signal: NodeJS.Signals): CommandError {
  const error = new CommandError(
    'DEV_INTERRUPTED',
    `The dev run stopped on ${signal}. The step it reached ended, and no later step ran. An EAS build that was already submitted keeps running on EAS; "eas build:cancel" ends it.`
  );
  error.exitCode = 128 + os.constants.signals[signal];
  return error;
}
