import { spawn } from 'child_process';
import { EventEmitter } from 'events';

/** What one run of the config loader child does, as the spawn mock plays it. */
export interface FakeLoaderRun {
  /** Messages the child sends over IPC before it exits. */
  messages?: unknown[];
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  /** Emit `error` instead of running, the way a missing `node` does. */
  spawnError?: NodeJS.ErrnoException;
  /** Never exit, so the caller's timeout is what ends the run. */
  hang?: boolean;
}

/** Answer the next `spawn` with a child that plays `run`, and return what it was killed with. */
export function mockConfigLoader(run: FakeLoaderRun = {}): { kill: ReturnType<typeof vi.fn> } {
  const kill = vi.fn();
  vi.mocked(spawn).mockImplementationOnce((() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill,
    });
    process.nextTick(() => {
      if (run.spawnError) {
        child.emit('error', run.spawnError);
        return;
      }
      for (const message of run.messages ?? []) {
        child.emit('message', message);
      }
      if (run.stderr) {
        child.stderr.emit('data', Buffer.from(run.stderr));
      }
      if (!run.hang) {
        child.emit('close', run.exitCode ?? 0, run.signal ?? null);
      }
    });
    return child as never;
  }) as never);
  return { kill };
}

/** The argv and options the last `spawn` was called with. */
export function lastSpawn(): { command: string; args: string[]; options: Record<string, any> } {
  const calls = vi.mocked(spawn).mock.calls;
  const [command, args, options] = calls[calls.length - 1] as unknown as [
    string,
    string[],
    Record<string, any>,
  ];
  return { command, args, options };
}
