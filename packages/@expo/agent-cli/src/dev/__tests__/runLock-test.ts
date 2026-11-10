// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization

import type { StartPlan } from '../../project/types';
import { withRunLockAsync } from '../runLock';

// A plan that serves nothing takes no lock, so the run touches no socket.
const plan = { steps: [] } as unknown as StartPlan;

afterEach(() => {
  vi.restoreAllMocks();
});

describe(withRunLockAsync, () => {
  it(`ends the process at once on a signal nothing else handles`, async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await withRunLockAsync('/project', plan, null, async () => {
      process.emit('SIGTERM', 'SIGTERM');
    });

    expect(exit).toHaveBeenCalledWith(143);
  });

  it(`lets a running step end first, then stops the run`, async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    // Registered before the run and removed by Node as the signal arrives, as `2g`'s exit cleanup is.
    process.once('SIGINT', () => {});
    // A step's own forwarder, which `spawnAsync` installs while its child runs.
    const step = () => {};
    await expect(
      withRunLockAsync('/project', plan, null, async (_lock, assertNotInterrupted) => {
        process.on('SIGINT', step);
        process.emit('SIGINT', 'SIGINT');
        process.off('SIGINT', step);
        assertNotInterrupted();
      })
    ).rejects.toMatchObject({ code: 'DEV_INTERRUPTED', exitCode: 130 });
    expect(exit).not.toHaveBeenCalled();
  });
});
