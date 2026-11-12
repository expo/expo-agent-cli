import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

import { killProcessTree } from '../processGroup';
import { spawnCaptureAsync } from '../spawnCapture';
import { spawnSubprocessAsync } from '../subprocess';
import { createStartupScope, trackStartupTask, withStartupTasksAsync } from '../startupTasks';

it.each([spawnSubprocessAsync, spawnCaptureAsync])(
  'refuses a queued runner after tree termination fails and the direct child closes (%#)',
  async (runner) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    vi.mocked(spawn).mockReturnValue(child);
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    const scope = createStartupScope();
    try {
      await expect(
        withStartupTasksAsync(async () => {
          const active = spawnCaptureAsync('npx', ['tree-queue']);
          const queued = runner('npx', ['tree-queue']);
          const outcome = queued.catch((error) => error);
          killProcessTree(child);
          child.emit('close', 0);
          await active;
          expect(await outcome).toMatchObject({ code: 'DEV_INTERRUPTED' });
          expect(spawn).toHaveBeenCalledTimes(1);
        }, scope)
      ).rejects.toMatchObject({ code: 'DEV_INTERRUPTED' });
      expect(await scope.drained).toBe('uncertain');
    } finally {
      kill.mockRestore();
    }
  }
);

it.each([undefined, 4321])(
  'waits for whole work and an actual spawned child close (pid=%s)',
  async (pid) => {
    const scope = createStartupScope();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const child = Object.assign(new EventEmitter(), {
      pid,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    vi.mocked(spawn).mockReturnValue(child);
    let drained = false;
    void scope.drained.then(() => {
      drained = true;
    });
    const finished = withStartupTasksAsync(async () => {
      trackStartupTask(held);
      await spawnCaptureAsync('node', ['fixture']);
    }, scope);
    child.emit('error', new Error('stream error'));
    scope.finishIfNeverStarted();
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await Promise.resolve();
    if (pid != null) {
      expect(drained).toBe(false);
      child.emit('close', 0);
    }
    await finished;
    expect(await scope.drained).toBe('drained');
  }
);
