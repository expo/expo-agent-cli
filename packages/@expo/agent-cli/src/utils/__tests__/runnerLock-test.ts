import { vol } from 'memfs';
import path from 'path';

import {
  acquireRunnerLockAsync,
  resetRunnerLocks,
  runnerSpawnKey,
  runnerWarmUpFor,
  RUNNER_WARM_UP_STALE_MS,
  warmUpRunnerAsync,
  withRunnerLockAsync,
} from '../runnerLock';

afterEach(() => {
  resetRunnerLocks();
  vol.reset();
});

describe(runnerSpawnKey, () => {
  it('keys an npx spawn on the package spec, past the runner flags', () => {
    expect(runnerSpawnKey('npx', ['--yes', 'eas-cli@latest', 'build:list', '--json'])).toBe(
      'npx:eas-cli@latest'
    );
  });

  it('keys a bunx spawn found at an absolute path on the same spec', () => {
    // The path is what gets spawned and says nothing about which scratch directory is shared: bun
    // keys that on the spec, so two spellings of one runner must not be two locks.
    expect(runnerSpawnKey('/opt/homebrew/bin/bunx', ['eas-cli@latest', 'whoami'])).toBe(
      'bunx:eas-cli@latest'
    );
  });

  it('recognises the Windows spelling of both runners', () => {
    expect(runnerSpawnKey('npx.cmd', ['--yes', 'eas-cli', 'build:view'])).toBe('npx:eas-cli');
    expect(runnerSpawnKey(`C:${path.sep}bun${path.sep}bunx.exe`, ['create-expo@latest'])).toBe(
      'bunx:create-expo@latest'
    );
  });

  it('gives two different package specs two different keys', () => {
    // Two specs are two scratch directories, so serializing them would cost time and buy nothing.
    expect(runnerSpawnKey('npx', ['--yes', 'eas-cli@latest', 'whoami'])).not.toBe(
      runnerSpawnKey('npx', ['--yes', 'create-expo@latest'])
    );
  });

  it('has no key for a command that is not a package runner', () => {
    expect(runnerSpawnKey('git', ['rev-parse', 'HEAD'])).toBeNull();
    expect(runnerSpawnKey('xcrun', ['simctl', 'list'])).toBeNull();
    expect(runnerSpawnKey('/usr/local/bin/eas', ['build:list'])).toBeNull();
  });

  it('falls back to the runner alone when nothing in the argv is a package spec', () => {
    // Conservative on purpose: a spelling this function cannot read serializes more than it has to,
    // which costs a moment. Reading it wrong would cost the race back.
    expect(runnerSpawnKey('npx', ['--yes'])).toBe('npx:*');
    expect(runnerSpawnKey('npx', [])).toBe('npx:*');
  });
});

describe(acquireRunnerLockAsync, () => {
  /** Record the order two bodies actually ran in, so overlap is visible rather than inferred. */
  function tracker() {
    const events: string[] = [];
    return {
      events,
      async body(name: string, holdMs: number): Promise<void> {
        events.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        events.push(`${name}:end`);
      },
    };
  }

  it('never lets two holders of one key overlap', async () => {
    const { events, body } = tracker();

    await Promise.all([
      withRunnerLockAsync('npx:eas-cli@latest', () => body('first', 30)),
      withRunnerLockAsync('npx:eas-cli@latest', () => body('second', 5)),
    ]);

    // The whole finding: started milliseconds apart, the two spawns shared one scratch directory.
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('lets two different keys overlap', async () => {
    const { events, body } = tracker();

    await Promise.all([
      withRunnerLockAsync('npx:eas-cli@latest', () => body('eas', 30)),
      withRunnerLockAsync('npx:create-expo@latest', () => body('create', 5)),
    ]);

    expect(events).toEqual(['eas:start', 'create:start', 'create:end', 'eas:end']);
  });

  it('hands the lock on when the holder throws', async () => {
    const { events, body } = tracker();

    const failing = withRunnerLockAsync('npx:eas-cli@latest', async () => {
      events.push('failing:start');
      throw new Error('the runner exploded');
    });
    const waiting = withRunnerLockAsync('npx:eas-cli@latest', () => body('waiting', 1));

    await expect(failing).rejects.toThrow('the runner exploded');
    await waiting;
    expect(events).toEqual(['failing:start', 'waiting:start', 'waiting:end']);
  });

  it('reports how long a spawn waited, so the queue is not free', async () => {
    const held = await acquireRunnerLockAsync('npx:eas-cli@latest');
    expect(held!.queuedMs).toBe(0);

    const queued = acquireRunnerLockAsync('npx:eas-cli@latest');
    await new Promise((resolve) => setTimeout(resolve, 25));
    held!.release();

    const lock = await queued;
    expect(lock).not.toBeNull();
    expect(lock!.queuedMs).toBeGreaterThanOrEqual(20);
    lock!.release();
  });

  it('gives up the wait rather than hanging a command that named a deadline', async () => {
    const held = await acquireRunnerLockAsync('npx:eas-cli@latest');

    const expired = await acquireRunnerLockAsync('npx:eas-cli@latest', { timeoutMs: 20 });

    expect(expired).toBeNull();
    // And the queue is intact: the waiter that gave up did not take the baton with it.
    held!.release();
    const next = await acquireRunnerLockAsync('npx:eas-cli@latest', { timeoutMs: 1000 });
    expect(next).not.toBeNull();
    next!.release();
  });
});

// @ref llp/0021-honest-reports.rfc.md §The rules — rule 11. Two processes on one cold
// `$TMPDIR/bunx-<uid>-eas-cli@latest`: 2 of 6 exited 1 with "TypeError: (0 , minimatch_1.minimatch)
// is not a function" under "Resolving dependencies"; 6 of 6 passed on a warm directory [observed —
// bun 1.3, eas-cli 24.10.0, 2026-10-05].
describe('the runner warm-up', () => {
  const PROJECT = '/work/app';

  beforeEach(() => {
    delete process.env.AGENT_CLI_NO_RUNNER_WARM_UP;
  });
  afterEach(() => {
    process.env.AGENT_CLI_NO_RUNNER_WARM_UP = '1';
  });

  it('is off when AGENT_CLI_NO_RUNNER_WARM_UP is set', () => {
    process.env.AGENT_CLI_NO_RUNNER_WARM_UP = '1';
    expect(warmUpRunnerAsync('npx', ['--yes', 'eas-cli@latest'], {}, vi.fn())).toBeNull();
  });

  function deferredSpawn() {
    const calls: { command: string; args: string[] }[] = [];
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const spawn = vi.fn(async (command: string, args: string[]) => {
      calls.push({ command, args });
      await done;
    });
    return { spawn, calls, finish };
  }

  it('runs one --version warm-up for two concurrent callers, then lets both through', async () => {
    const { spawn, calls, finish } = deferredSpawn();
    const args = ['--yes', 'eas-cli@latest', 'simulator', '--platform', 'ios'];

    const first = warmUpRunnerAsync('npx', args, { cwd: PROJECT }, spawn);
    const second = warmUpRunnerAsync('npx', args, { cwd: PROJECT }, spawn);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    finish();
    await Promise.all([first, second]);

    expect(calls).toEqual([{ command: 'npx', args: ['--yes', 'eas-cli@latest', '--version'] }]);
    // Warm in this process: the next spawn needs nothing and starts in its own tick.
    expect(warmUpRunnerAsync('npx', args, { cwd: PROJECT }, spawn)).toBeNull();
  });

  it('holds a machine-wide lock while it warms, and releases it after', async () => {
    const { spawn, finish } = deferredSpawn();
    const warmUp = runnerWarmUpFor('bunx', ['eas-cli@latest', 'whoami'], PROJECT)!;

    const pending = warmUpRunnerAsync(
      'bunx',
      ['eas-cli@latest', 'whoami'],
      { cwd: PROJECT },
      spawn
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(vol.existsSync(warmUp.lock)).toBe(true);
    finish();
    await pending;

    expect(vol.existsSync(warmUp.lock)).toBe(false);
  });

  it('waits for another process that holds the lock, then warms', async () => {
    const { spawn, calls, finish } = deferredSpawn();
    finish();
    const warmUp = runnerWarmUpFor('bunx', ['eas-cli@latest'], PROJECT)!;
    vol.mkdirSync(warmUp.lock, { recursive: true });

    const pending = warmUpRunnerAsync('bunx', ['eas-cli@latest'], { cwd: PROJECT }, spawn);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toEqual([]);
    vol.rmSync(warmUp.lock, { recursive: true });
    await pending;

    expect(calls).toEqual([{ command: 'bunx', args: ['eas-cli@latest', '--version'] }]);
  });

  it('removes a lock older than five minutes, whose holder is dead', async () => {
    const { spawn, calls, finish } = deferredSpawn();
    finish();
    const warmUp = runnerWarmUpFor('bunx', ['eas-cli@latest'], PROJECT)!;
    vol.mkdirSync(warmUp.lock, { recursive: true });
    const old = (Date.now() - RUNNER_WARM_UP_STALE_MS - 1000) / 1000;
    vol.utimesSync(warmUp.lock, old, old);

    await warmUpRunnerAsync('bunx', ['eas-cli@latest'], { cwd: PROJECT }, spawn);

    expect(RUNNER_WARM_UP_STALE_MS).toBe(5 * 60_000);
    expect(calls).toHaveLength(1);
  });

  it('gives up the lock wait at the caller deadline and spawns nothing', async () => {
    const { spawn, calls } = deferredSpawn();
    const warmUp = runnerWarmUpFor('bunx', ['eas-cli@latest'], PROJECT)!;
    vol.mkdirSync(warmUp.lock, { recursive: true });

    await warmUpRunnerAsync('bunx', ['eas-cli@latest'], { cwd: PROJECT, timeoutMs: 30 }, spawn);

    expect(calls).toEqual([]);
  });

  it('needs no warm-up when the spec resolves to the local install', () => {
    vol.fromJSON({ [`${PROJECT}/node_modules/eas-cli/package.json`]: '{"name":"eas-cli"}' });

    expect(runnerWarmUpFor('npx', ['--yes', 'eas-cli', 'build:list'], PROJECT)).toBeNull();
    expect(runnerWarmUpFor('npx', ['--yes', 'eas-cli', 'build:list'], `${PROJECT}/sub`)).toBeNull();
    expect(
      warmUpRunnerAsync('npx', ['--yes', 'eas-cli', 'build:list'], { cwd: PROJECT }, vi.fn())
    ).toBeNull();
  });

  it('warms a versioned spec even when a local install exists, because the version defeats it', () => {
    vol.fromJSON({ [`${PROJECT}/node_modules/eas-cli/package.json`]: '{"name":"eas-cli"}' });

    expect(runnerWarmUpFor('npx', ['--yes', 'eas-cli@latest', 'whoami'], PROJECT)?.args).toEqual([
      '--yes',
      'eas-cli@latest',
      '--version',
    ]);
  });

  it('warms nothing that is not a runner, and no package whose --version is unverified', () => {
    expect(runnerWarmUpFor('xcrun', ['simctl', 'list'], PROJECT)).toBeNull();
    expect(runnerWarmUpFor('npx', ['--yes', 'create-expo@latest', 'app'], PROJECT)).toBeNull();
    expect(runnerWarmUpFor('npx', ['--yes'], PROJECT)).toBeNull();
  });
});
