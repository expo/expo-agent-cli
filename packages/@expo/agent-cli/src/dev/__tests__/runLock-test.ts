// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization

import type { StartPlan } from '../../project/types';
import { withRunLockAsync } from '../runLock';

// A plan that serves nothing takes no lock, so the run touches no socket.
const plan = { steps: [] } as unknown as StartPlan;

afterEach(() => {
  vi.restoreAllMocks();
});

describe(withRunLockAsync, () => {
  it(`ends the process at once on a signal between steps`, async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await withRunLockAsync('/project', plan, null, async (_lock, steps) => {
      await steps.stepAsync(async () => {});
      process.emit('SIGTERM', 'SIGTERM');
    });

    expect(exit).toHaveBeenCalledWith(143);
  });

  it(`lets a running step end first, then stops the run`, async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await expect(
      withRunLockAsync('/project', plan, null, async (_lock, steps) => {
        await steps.stepAsync(async () => {
          process.emit('SIGINT', 'SIGINT');
        });
        steps.assertNotInterrupted();
      })
    ).rejects.toMatchObject({ code: 'DEV_INTERRUPTED', exitCode: 130 });
    expect(exit).not.toHaveBeenCalled();
  });

  // The spawn checks this signal after the runner queue: a step whose child is not spawned yet
  // has nothing to forward the signal to, so the child must never start.
  it(`aborts the step's signal with DEV_INTERRUPTED before its child exists`, async () => {
    await expect(
      withRunLockAsync('/project', plan, null, (_lock, steps) =>
        steps.stepAsync(async (signal) => {
          process.emit('SIGTERM', 'SIGTERM');
          signal.throwIfAborted();
        })
      )
    ).rejects.toMatchObject({ code: 'DEV_INTERRUPTED', exitCode: 143 });
  });
});
