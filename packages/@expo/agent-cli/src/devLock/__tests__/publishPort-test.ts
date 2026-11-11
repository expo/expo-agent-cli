// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// When the lock is published: at the spawn when the arguments name a port, else when the dev
// server reports one. Against a real lock address.

import fs from 'fs';
import path from 'path';

import { readDevServerLockAsync } from '../client';
import { publishDevServerPortAsync } from '../publishPort';
import { RunLock } from '../runLock';
import { cleanupTempProjects, makeTempProject } from './tempProject';

// The suite-wide `fs` mock is memfs, which the kernel cannot bind a socket inside.
vi.unmock('fs');
vi.unmock('node:fs');

const held: RunLock[] = [];

/** A `start` run's lock, released after the test. */
function runLockFor(projectRoot: string): RunLock {
  const lock = new RunLock(projectRoot);
  held.push(lock);
  return lock;
}

afterEach(() => {
  for (const lock of held.splice(0)) {
    lock.apply({ type: 'run-ended' });
  }
  cleanupTempProjects();
});

/** The `LOG_EVENTS` file this process's `2g` writes, which the port watch reads Metro's report from. */
const eventLog = vi.hoisted(() => ({ file: '' }));
vi.mock('2g', async (importOriginal) => ({
  ...(await importOriginal<typeof import('2g')>()),
  getEventLoggerInfo: () => ({
    destination: 'file',
    isUserVisibleOutput: false,
    debug: true,
    file: eventLog.file,
  }),
}));

beforeEach(() => {
  eventLog.file = path.join(makeTempProject(), 'events.jsonl');
});

/** Append Metro's report of `port` to the event log, as `2g` writes it. */
function report(port: number) {
  fs.appendFileSync(
    eventLog.file,
    `${JSON.stringify({ _e: 'metro:instantiate', _t: Date.now(), port })}\n`
  );
}

/** Ask the lock until `check` holds, or fail after a second. */
async function eventuallyAsync<T>(read: () => Promise<T>, check: (value: T) => boolean) {
  const deadline = Date.now() + 1000;
  for (;;) {
    const value = await read();
    if (check(value) || Date.now() > deadline) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe(publishDevServerPortAsync, () => {
  // `onResolved` comes after the publish: a caller that then waits for `/status` finds the lock
  // already naming the port, so the answer is not lost on a lock not yet taken.
  it(`publishes the lock before any report when the arguments name a port`, async () => {
    const projectRoot = makeTempProject();
    const runLock = runLockFor(projectRoot);
    const resolved: string[] = [];
    let running = true;

    const lock = publishDevServerPortAsync(projectRoot, ['start', '--port', '8301'], {
      lock: runLock,
      phase: 'serving',
      since: Date.now(),
      isRunning: () => running,
      intervalMs: 10,
      onResolved: ({ port, source }) =>
        resolved.push(
          `${source}:${port}, lock on ${'port' in runLock.state && runLock.state.port}`
        ),
    });

    const answer = await eventuallyAsync(
      () => readDevServerLockAsync(projectRoot),
      (info) => info != null
    );
    expect(answer).toMatchObject({ port: 8301, portReported: false, easPlatform: null });
    expect(resolved).toEqual(['arg:8301, lock on 8301']);

    // Metro reports later, on another port: told again, and the lock follows.
    report(8302);
    await lock;
    expect(resolved).toEqual(['arg:8301, lock on 8301', 'reported:8302, lock on 8302']);
    expect(await readDevServerLockAsync(projectRoot)).toMatchObject({
      port: 8302,
      url: 'http://127.0.0.1:8302',
      portReported: true,
    });
    running = false;
  });

  // A named port is published at the spawn, so nothing waits on the watch: it follows the dev
  // server for as long as it runs, and a report after an `expo run:*` build still counts.
  it(`follows a report that comes after the watch's timeout when the arguments name a port`, async () => {
    const projectRoot = makeTempProject();
    let running = true;

    const lock = publishDevServerPortAsync(projectRoot, ['run:ios', '--port', '8303'], {
      lock: runLockFor(projectRoot),
      phase: 'serving',
      since: Date.now(),
      isRunning: () => running,
      intervalMs: 10,
      timeoutMs: 30,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    report(8303);
    expect(
      await eventuallyAsync(
        () => readDevServerLockAsync(projectRoot),
        (info) => info?.portReported === true
      )
    ).toMatchObject({ port: 8303, portReported: true });
    running = false;
    await lock;
  });

  // @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
  it(`answers easOpenFinished once the EAS open returns, and keeps it across the port update from the report`, async () => {
    const projectRoot = makeTempProject();
    const runLock = runLockFor(projectRoot);
    runLock.apply({ type: 'eas-open-started' });

    const lock = publishDevServerPortAsync(projectRoot, ['start', '--port', '8308'], {
      lock: runLock,
      phase: 'serving',
      since: Date.now(),
      isRunning: () => true,
      intervalMs: 10,
      easPlatform: 'ios',
    });

    expect(
      await eventuallyAsync(
        () => readDevServerLockAsync(projectRoot),
        (info) => info != null
      )
    ).toMatchObject({ port: 8308, easOpenFinished: false });

    runLock.apply({ type: 'eas-open-returned' });
    expect(
      await eventuallyAsync(
        () => readDevServerLockAsync(projectRoot),
        (info) => info?.easOpenFinished === true
      )
    ).toMatchObject({ port: 8308, easOpenFinished: true });

    report(8309);
    await lock;
    expect(await readDevServerLockAsync(projectRoot)).toMatchObject({
      port: 8309,
      portReported: true,
      easPlatform: 'ios',
      easOpenFinished: true,
    });
  });

  it(`waits for the report when the arguments name no port`, async () => {
    const projectRoot = makeTempProject();
    const resolved: string[] = [];

    const lock = publishDevServerPortAsync(projectRoot, ['start'], {
      lock: runLockFor(projectRoot),
      phase: 'serving',
      since: Date.now(),
      isRunning: () => true,
      intervalMs: 10,
      onResolved: ({ port, source }) => resolved.push(`${source}:${port}`),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readDevServerLockAsync(projectRoot)).toBeNull();
    expect(resolved).toEqual([]);

    report(8303);
    await lock;
    expect(resolved).toEqual(['reported:8303']);
    expect(await readDevServerLockAsync(projectRoot)).toMatchObject({
      port: 8303,
      portReported: true,
    });
  });

  // A Metro of another project on `*:8081` answered the port a run fell back to, and the lock
  // published it [observed — live suite, 2026-10-05: `status` read `source: 'lock'` with
  // `projectRootMatched: false`].
  it(`never publishes a named port that another project's dev server answers, and waits for the report`, async () => {
    const projectRoot = makeTempProject();
    const resolved: string[] = [];
    let running = true;

    const lock = publishDevServerPortAsync(projectRoot, ['start', '--port', '8304'], {
      lock: runLockFor(projectRoot),
      phase: 'serving',
      since: Date.now(),
      isRunning: () => running,
      intervalMs: 10,
      timeoutMs: 30,
      servesAnotherProject: async (port) => port === 8304,
      onResolved: ({ port, source }) => resolved.push(`${source}:${port}`),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readDevServerLockAsync(projectRoot)).toBeNull();
    expect(resolved).toEqual([]);

    report(8305);
    await lock;
    expect(resolved).toEqual(['reported:8305']);
    expect(await readDevServerLockAsync(projectRoot)).toMatchObject({
      port: 8305,
      portReported: true,
    });
    running = false;
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Dev-server lock — a port retry answers on
  // the run's lock, with no gap; a port of another project releases it.
  it.each([
    ['answers on the lock the run holds', false, { port: 8311, phase: 'serving' }],
    ['releases the lock the run holds for a foreign port', true, null],
  ] as const)(`%s`, async (_name, foreign, answer) => {
    const projectRoot = makeTempProject();
    const runLock = runLockFor(projectRoot);
    await runLock.publishAsync({
      type: 'published',
      phase: 'building',
      port: 8310,
      source: 'arg',
      since: 0,
      easPlatform: null,
    });
    const since = Date.now();
    let running = true;
    // The dev server stops before it logs a port, so a foreign port leaves nothing to name.
    const stopped = new Promise<void>((resolve) =>
      setTimeout(() => {
        running = false;
        resolve();
      }, 50)
    );

    await publishDevServerPortAsync(projectRoot, ['start', '--port', '8311'], {
      lock: runLock,
      phase: 'serving',
      since,
      isRunning: () => running,
      stopped,
      intervalMs: 10,
      timeoutMs: 30,
      servesAnotherProject: async () => foreign,
    });

    expect(await readDevServerLockAsync(projectRoot)).toEqual(
      answer && expect.objectContaining({ ...answer, startedAt: new Date(since).toISOString() })
    );
  });

  it(`holds nothing when the dev server stops with only a foreign port to name`, async () => {
    const projectRoot = makeTempProject();
    let running = true;
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));

    const lock = publishDevServerPortAsync(projectRoot, ['start', '--port', '8306'], {
      lock: runLockFor(projectRoot),
      phase: 'serving',
      since: Date.now(),
      isRunning: () => running,
      stopped,
      intervalMs: 10,
      timeoutMs: 30,
      servesAnotherProject: async () => true,
    });
    setTimeout(() => {
      running = false;
      stop();
    }, 60);

    await lock;
    expect(await readDevServerLockAsync(projectRoot)).toBeNull();
  });
});
