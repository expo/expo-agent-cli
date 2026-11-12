// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
// A `dev` run: its steps under one lock, the lock's take before a build step, and the stop
// between steps on a signal.

import os from 'node:os';

import { publishPlannedPortAsync, withRunLockAsync, type RunLock } from '../devLock';
import { isDevServerStep } from './forwardedArgs';
import type { StartPlan } from '../project/types';
import { CommandError } from '../utils/errors';
import {
  assertStartupActive,
  canOpenStartup,
  ownedRunStopSignal,
  registerLockedStop,
  type RunCancellation,
} from '../utils/startupTasks';

/** How a run marks its steps, so a signal knows whether a step has to end first. */
export interface RunSteps {
  /**
   * Run one step, with its EAS exit work. A signal while it runs reaches its child, which ends it.
   * `work` passes `signal` to the spawn: a signal that comes before the child exists aborts it, so
   * the child never starts and the step rejects with `DEV_INTERRUPTED`.
   */
  stepAsync<T>(work: (cancellation: RunCancellation) => Promise<T>): Promise<T>;
  /** Whether a signal arrived during the run. */
  readonly interrupted: boolean;
  /** Throw `DEV_INTERRUPTED` when a signal arrived during the run. */
  assertNotInterrupted(): void;
}

/**
 * Run `run` under the run's lock, and stop it between steps on SIGINT or SIGTERM.
 *
 * The lock is taken before the first step, with phase `building`, when a step runs before the
 * dev-server step; otherwise the dev-server step takes it.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — a signal ends the step it
 * reaches, and the run starts no later step.
 */
export async function withRunAsync<T>(
  projectRoot: string,
  plan: StartPlan,
  easPlatform: 'ios' | 'android' | null,
  run: (lock: RunLock, steps: RunSteps) => Promise<T>
): Promise<T> {
  assertStartupActive();
  return await withRunLockAsync(projectRoot, async (lock) => {
    const unregister = registerLockedStop(() => ('port' in lock.state ? lock.state.port : null));
    try {
      return await withSignalsAsync(async (steps) => {
        steps.assertNotInterrupted();
        const port = plan.devServerPort?.port;
        if (port != null && plan.steps.findIndex(isDevServerStep) > 0) {
          await publishPlannedPortAsync(lock, projectRoot, port, easPlatform);
          canOpenStartup();
          steps.assertNotInterrupted();
        }
        return await run(lock, steps);
      });
    } finally {
      unregister();
    }
  });
}

/** Run `run`, and stop it between steps on SIGINT or SIGTERM. */
async function withSignalsAsync<T>(run: (steps: RunSteps) => Promise<T>): Promise<T> {
  let signal: NodeJS.Signals | null = null;
  let running = 0;
  const abort = new AbortController();
  const stopSignal = ownedRunStopSignal();
  const onStop = () => abort.abort(stopSignal!.reason);
  stopSignal?.addEventListener('abort', onStop, { once: true });
  if (stopSignal?.aborted) onStop();
  const onSignal = (received: NodeJS.Signals) => {
    signal ??= received;
    abort.abort(interruptedError(signal));
    // A running step ends first, and the run stops after it. Between steps nothing runs to wait
    // for: end now, as Node does without a listener.
    if (running === 0) process.exit(128 + os.constants.signals[received]);
  };
  const steps: RunSteps = {
    async stepAsync(work) {
      steps.assertNotInterrupted();
      running++;
      try {
        return await work({ signal: abort.signal, ...(stopSignal ? { stopSignal } : {}) });
      } finally {
        running--;
      }
    },
    get interrupted() {
      return abort.signal.aborted;
    },
    assertNotInterrupted() {
      assertStartupActive();
      abort.signal.throwIfAborted();
    },
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    return await run(steps);
  } finally {
    stopSignal?.removeEventListener('abort', onStop);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
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
