// @ref llp/0004-smart-start-and-project-state.rfc.md
import { publishPlannedPortAsync, withRunLockAsync, type RunLock } from '../devLock';
import { isDevServerStep } from './forwardedArgs';
import type { StartPlan } from '../project/types';
import type { DevRun } from './devRun';

export interface RunSteps {
  readonly run: DevRun;
  stepAsync<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  readonly interrupted: boolean;
  assertNotInterrupted(): void;
}

export async function withRunAsync<T>(
  projectRoot: string,
  plan: StartPlan,
  easPlatform: 'ios' | 'android' | null,
  work: (lock: RunLock, steps: RunSteps) => Promise<T>,
  run: DevRun
): Promise<T> {
  return withRunLockAsync(projectRoot, async (lock) => {
    run.signal.throwIfAborted();
    const port = plan.devServerPort?.port;
    if (port != null && plan.steps.findIndex(isDevServerStep) > 0) {
      await publishPlannedPortAsync(lock, projectRoot, port, easPlatform);
    }
    run.signal.throwIfAborted();
    return work(lock, {
      run,
      stepAsync: (step) => {
        run.signal.throwIfAborted();
        return step(run.signal);
      },
      get interrupted() {
        return run.signal.aborted;
      },
      assertNotInterrupted: () => run.signal.throwIfAborted(),
    });
  });
}
