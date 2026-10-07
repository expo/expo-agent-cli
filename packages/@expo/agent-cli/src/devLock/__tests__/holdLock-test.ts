// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// When the lock is published: at the spawn when the arguments name a port, else when the dev
// server logs one. Against a real lock address and a real `start.log`.

import fs from 'fs';
import path from 'path';

import { readDevServerLockAsync } from '../client';
import { event } from '../events';
import { claimDevServerLockAsync, holdDevServerLockAsync } from '../holdLock';
import { acquireDevServerLockAsync } from '../server';
import type { DevServerLockHandle } from '../types';
import { cleanupTempProjects, makeTempProject } from './tempProject';

// The suite-wide `fs` mock is memfs, which the kernel cannot bind a socket inside.
vi.unmock('fs');
vi.unmock('node:fs');
vi.mock('../events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../events')>()),
  event: vi.fn(),
}));

const held: (DevServerLockHandle | null)[] = [];

afterEach(() => {
  for (const lock of held.splice(0)) {
    lock?.release();
  }
  cleanupTempProjects();
});

/** Append a `metro:instantiate` entry to the project's `start.log`, as `2g` writes it. */
function logPort(projectRoot: string, port: number) {
  const logs = path.join(projectRoot, '.expo', 'dev', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.appendFileSync(
    path.join(logs, 'start.log'),
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
  it(`publishes the lock before any log line when the arguments name a port`, async () => {
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
    expect(answer).toMatchObject({ port: 8301, args: ['start', '--port', '8301'] });
    expect(resolved).toEqual(['arg:8301']);

    // Metro reports later, on another port: told again, and the lock follows.
    logPort(projectRoot, 8302);
    await lock;
    expect(resolved).toEqual(['arg:8301', 'log:8302']);
    expect(await readDevServerLockAsync(projectRoot)).toMatchObject({
      port: 8302,
      url: 'http://127.0.0.1:8302',
    });
    running = false;
  });

  it(`waits for the log when the arguments name no port`, async () => {
    const projectRoot = makeTempProject();
    const resolved: string[] = [];

    const lock = holdDevServerLockAsync(projectRoot, ['start'], {
      since: Date.now(),
      intervalMs: 10,
      onResolved: ({ port, source }) => resolved.push(`${source}:${port}`),
    }).then((handle) => (held.push(handle), handle));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readDevServerLockAsync(projectRoot)).toBeNull();
    expect(resolved).toEqual([]);

    logPort(projectRoot, 8303);
    await lock;
    expect(resolved).toEqual(['log:8303']);
    expect(await readDevServerLockAsync(projectRoot)).toMatchObject({ port: 8303 });
  });
});

describe(claimDevServerLockAsync, () => {
  it(`takes the lock before the spawn when the arguments name a port`, async () => {
    const projectRoot = makeTempProject();

    const claim = await claimDevServerLockAsync(projectRoot, ['start', '--port', '8311'], {
      since: Date.now(),
    });

    expect(claim.status).toBe('held');
    held.push(claim.status === 'held' ? claim.lock : null);
    expect(await readDevServerLockAsync(projectRoot)).toMatchObject({ port: 8311 });
  });

  it(`answers in-use for a live dev server of this project`, async () => {
    const projectRoot = makeTempProject();
    const other = await acquireDevServerLockAsync({
      url: 'http://127.0.0.1:8312',
      port: 8312,
      pid: process.pid + 1,
      startedAt: new Date().toISOString(),
      projectRoot,
      args: ['start', '--port', '8312'],
    });
    held.push(other.status === 'acquired' ? other.lock : null);

    const claim = await claimDevServerLockAsync(projectRoot, ['start', '--port', '8313'], {
      since: Date.now(),
    });

    expect(claim).toMatchObject({ status: 'in-use', holder: { port: 8312 } });
    // The plain `start` wrapper spawns anyway, and this event is all that is said.
    expect(event).toHaveBeenCalledWith(
      'dev_lock_skipped',
      expect.objectContaining({ reason: 'in-use', holderUrl: 'http://127.0.0.1:8312' })
    );
  });

  // A lock this process still holds is a retry's own, not another run.
  it(`answers held with no lock when the holder is this process`, async () => {
    const projectRoot = makeTempProject();
    const first = await claimDevServerLockAsync(projectRoot, ['start', '--port', '8314'], {
      since: Date.now(),
    });
    held.push(first.status === 'held' ? first.lock : null);

    const claim = await claimDevServerLockAsync(projectRoot, ['start', '--port', '8315'], {
      since: Date.now(),
    });

    expect(claim).toEqual({ status: 'held', lock: null });
  });

  it(`leaves the lock to the log when the arguments name no port`, async () => {
    const projectRoot = makeTempProject();

    await expect(
      claimDevServerLockAsync(projectRoot, ['start'], { since: Date.now() })
    ).resolves.toEqual({ status: 'unclaimed' });
    expect(await readDevServerLockAsync(projectRoot)).toBeNull();
  });
});
