// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// When the lock is published: at the spawn when the arguments name a port, else when the dev
// server logs one. Against a real lock address and a real `start.log`.

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
    expect(answer).toMatchObject({ port: 8301 });
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
