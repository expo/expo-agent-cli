// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// When the lock is published: at the spawn when the arguments name a port, else when the dev
// server reports one. Against a real lock address.

import fs from 'fs';
import path from 'path';

import { readDevServerLockAsync } from '../client';
import { holdDevServerLockAsync } from '../holdLock';
import type { DevServerLockHandle } from '../types';
import { cleanupTempProjects, makeTempProject } from './tempProject';

// The suite-wide `fs` mock is memfs, which the kernel cannot bind a socket inside.
vi.unmock('fs');
vi.unmock('node:fs');

const held: (DevServerLockHandle | null)[] = [];

afterEach(() => {
  for (const lock of held.splice(0)) {
    lock?.release();
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

describe(holdDevServerLockAsync, () => {
  it(`publishes the lock before any report when the arguments name a port`, async () => {
    const projectRoot = makeTempProject();
    const resolved: string[] = [];
    let running = true;

    const lock = holdDevServerLockAsync(projectRoot, ['start', '--port', '8301'], {
      since: Date.now(),
      isRunning: () => running,
      intervalMs: 10,
      onResolved: ({ port, source }) => resolved.push(`${source}:${port}`),
    }).then((handle) => (held.push(handle), handle));

    const answer = await eventuallyAsync(
      () => readDevServerLockAsync(projectRoot),
      (info) => info != null
    );
    expect(answer).toMatchObject({ port: 8301, portReported: false, easPlatform: null });
    expect(resolved).toEqual(['arg:8301']);

    // Metro reports later, on another port: told again, and the lock follows.
    report(8302);
    await lock;
    expect(resolved).toEqual(['arg:8301', 'reported:8302']);
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

    const lock = holdDevServerLockAsync(projectRoot, ['run:ios', '--port', '8303'], {
      since: Date.now(),
      isRunning: () => running,
      intervalMs: 10,
      timeoutMs: 30,
    }).then((handle) => (held.push(handle), handle));

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
  it(`answers easOpenFinished once the EAS open settles, and keeps it across the port update from the report`, async () => {
    const projectRoot = makeTempProject();
    let finishOpen!: () => void;
    const easOpenFinished = new Promise<void>((resolve) => (finishOpen = resolve));

    const lock = holdDevServerLockAsync(projectRoot, ['start', '--port', '8308'], {
      since: Date.now(),
      isRunning: () => true,
      intervalMs: 10,
      easPlatform: 'ios',
      easOpenFinished,
    }).then((handle) => (held.push(handle), handle));

    expect(
      await eventuallyAsync(
        () => readDevServerLockAsync(projectRoot),
        (info) => info != null
      )
    ).toMatchObject({ port: 8308, easOpenFinished: false });

    finishOpen();
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

    const lock = holdDevServerLockAsync(projectRoot, ['start'], {
      since: Date.now(),
      isRunning: () => true,
      intervalMs: 10,
      onResolved: ({ port, source }) => resolved.push(`${source}:${port}`),
    }).then((handle) => (held.push(handle), handle));

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

    const lock = holdDevServerLockAsync(projectRoot, ['start', '--port', '8304'], {
      since: Date.now(),
      isRunning: () => running,
      intervalMs: 10,
      timeoutMs: 30,
      servesAnotherProject: async (port) => port === 8304,
      onResolved: ({ port, source }) => resolved.push(`${source}:${port}`),
    }).then((handle) => (held.push(handle), handle));

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

  it(`holds nothing when the dev server stops with only a foreign port to name`, async () => {
    const projectRoot = makeTempProject();
    let running = true;
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));

    const lock = holdDevServerLockAsync(projectRoot, ['start', '--port', '8306'], {
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

    expect(await lock).toBeNull();
    expect(await readDevServerLockAsync(projectRoot)).toBeNull();
  });
});
