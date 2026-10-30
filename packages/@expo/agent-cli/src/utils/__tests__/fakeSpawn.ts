import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import type { Mock } from 'vitest';

/** A child process the test drives by hand: it emits `data`, `close` and `error` itself. */
export interface FakeChild<Stream extends EventEmitter | null = EventEmitter> extends EventEmitter {
  stdout: Stream;
  stderr: Stream;
  kill: Mock;
}

/** Make the next `spawn` calls return one child, and give it back so the test can emit on it. */
export function mockSpawnChild(): FakeChild;
export function mockSpawnChild(options: { piped: false }): FakeChild<null>;
export function mockSpawnChild({ piped = true } = {}): FakeChild<EventEmitter | null> {
  const child = Object.assign(new EventEmitter(), {
    stdout: piped ? new EventEmitter() : null,
    stderr: piped ? new EventEmitter() : null,
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as never);
  return child;
}

/** What one auto-settling child does: print, then exit with a code, or fail to start. */
export interface SpawnAnswer {
  stdout?: string;
  stderr?: string;
  /** Defaults to 0. `null` is a child that was killed by a signal, as on a timeout. */
  exitCode?: number | null;
  /** The child emits `error` and never closes, as a tool that is not installed does. */
  error?: Error;
}

export interface SpawnCall {
  command: string;
  args: string[];
}

/**
 * Answer each `spawn` with what `answerFor` returns for it; no answer is an empty one (exit 0).
 * Every child settles on the next tick, after the code under test attached its listeners.
 * `onCall` runs once per spawn, before its child settles. Returns the commands spawned so far.
 */
export function mockSpawnBy(
  answerFor: (call: SpawnCall, index: number) => SpawnAnswer | undefined,
  onCall?: (index: number) => void
): SpawnCall[] {
  const calls: SpawnCall[] = [];
  vi.mocked(spawn).mockImplementation(((command: string, args: string[]) => {
    const call = { command, args };
    calls.push(call);
    const index = calls.length - 1;
    const answer = answerFor(call, index) ?? {};
    onCall?.(index);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    process.nextTick(() => {
      if (answer.error) {
        child.emit('error', answer.error);
        return;
      }
      if (answer.stdout) child.stdout.emit('data', answer.stdout);
      if (answer.stderr) child.stderr.emit('data', answer.stderr);
      child.emit('close', answer.exitCode === undefined ? 0 : answer.exitCode, null);
    });
    return child as never;
  }) as never);
  return calls;
}

/** Answer each `spawn` with the next answer in turn; a spawn past the end exits 0, silent. */
export function mockSpawnQueue(
  answers: SpawnAnswer[],
  onCall?: (index: number) => void
): SpawnCall[] {
  return mockSpawnBy((_call, index) => answers[index], onCall);
}

/** Every `spawn` gets the same answer. */
export function mockSpawnAlways(answer: SpawnAnswer = {}): SpawnCall[] {
  return mockSpawnBy(() => answer);
}
