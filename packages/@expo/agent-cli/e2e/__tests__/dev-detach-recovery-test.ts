import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { detachedRunFixture } from '../detachedRunFixture';
import { readDevLockAsync, waitForAsync } from '../utils';

// @ref llp/0036-detached-run-ownership.rfc.md
it.skipIf(process.platform === 'win32')(
  'a crashed detached run names an explicit discard command and can be restarted',
  async () => {
    const f = await detachedRunFixture();
    try {
      const started = await f.start();
      expect(started.exitCode, started.all).toBe(0);
      const owner = JSON.parse(started.stdout);
      const id = path.basename(owner.logFile).slice('dev-detached-'.length, -'.log'.length);
      process.kill(owner.pid, 'SIGKILL');
      await f.stopServer();
      expect(await waitForAsync(async () => !(await readDevLockAsync(f.root)), 5000)).toBe(true);
      const refused = await f.start();
      expect(refused.exitCode, refused.all).toBe(20);
      expect(JSON.parse(refused.stdout).error.code).toBe('DEV_START_UNCERTAIN');
      const stopped = await f.run(['dev:stop', '--json']);
      expect(refused.stdout).toContain(`dev:stop --discard-run ${id}`);
      expect(stopped.stdout).toContain(`dev:stop --discard-run ${id}`);
      const discarded = await f.run(['dev:stop', '--discard-run', id, '--json']);
      expect(discarded.exitCode, discarded.all).toBe(0);
      expect(JSON.parse(discarded.stdout)).toMatchObject({ discardedRun: id, stopped: false });
      const restarted = await f.start();
      expect(restarted.exitCode, restarted.all).toBe(0);
    } finally {
      await f.cleanup();
    }
  }
);

it.skipIf(process.platform === 'win32').each([true, false])(
  'SIGKILL retains ownership independently of surviving work (server alive: %s)',
  async (survives) => {
    const f = await detachedRunFixture();
    try {
      const started = await f.start();
      expect(started.exitCode, started.all).toBe(0);
      const owner = JSON.parse(started.stdout);
      const id = path.basename(owner.logFile).slice('dev-detached-'.length, -'.log'.length);
      const stopped = await f.run(['dev:stop', '--signal', 'SIGKILL', '--json']);
      expect(await (await fetch(`${owner.url}/status`)).text()).toBe('packager-status:running');
      expect(() => process.kill(f.serverPid(), 0)).not.toThrow();
      if (!survives) await f.stopServer();
      expect(stopped.stdout).toContain(
        `processes in other groups may still be running on port ${f.port}`
      );
      expect(stopped.stdout).toContain(`dev:stop --discard-run ${id}`);
      const refused = await f.start();
      expect(refused.exitCode, refused.all).toBe(20);
      expect(JSON.parse(refused.stdout).error.code).toBe('DEV_START_UNCERTAIN');
      const discarded = await f.run(['dev:stop', '--discard-run', id, '--json']);
      expect(discarded.exitCode, discarded.all).toBe(0);
      if (survives) {
        const foreign = await f.start();
        expect(foreign.exitCode, foreign.all).toBe(20);
        expect(JSON.parse(foreign.stdout).error.code).toBe('PORT_IN_USE');
        expect(foreign.stdout).toContain(`Port ${f.port} is taken`);
        expect(() => process.kill(f.serverPid(), 0)).not.toThrow();
        await f.stopServer();
      }
      const restarted = await f.start();
      expect(restarted.exitCode, restarted.all).toBe(0);
    } finally {
      await f.cleanup();
    }
  }
);

it.each([false, true])(
  'discard refuses a live owner even with malformed contents (%s)',
  async (malformed) => {
    const f = await detachedRunFixture();
    let marker: string | undefined;
    let saved: string | undefined;
    try {
      const started = await f.start();
      expect(started.exitCode, started.all).toBe(0);
      const owner = JSON.parse(started.stdout);
      const id = path.basename(owner.logFile).slice('dev-detached-'.length, -'.log'.length);
      marker = path.join(f.root, '.expo', 'dev', 'detached-run', `owner-${id}.json`);
      saved = fs.readFileSync(marker, 'utf8');
      if (malformed) fs.writeFileSync(marker, '{');
      const result = await f.run(['dev:stop', '--discard-run', id, '--json']);
      expect(result.exitCode, result.all).toBe(20);
      expect(JSON.parse(result.stdout).error.code).toBe('DEV_START_BUSY');
      expect(await readDevLockAsync(f.root)).toMatchObject({ pid: owner.pid });
      expect(await (await fetch(`${owner.url}/status`)).text()).toBe('packager-status:running');
    } finally {
      if (marker && saved) fs.writeFileSync(marker, saved);
      await f.cleanup();
    }
  }
);

it('concurrent discard and stale retries cannot remove replacement ownership', async () => {
  const f = await detachedRunFixture();
  try {
    const id = randomUUID();
    const directory = path.join(f.root, '.expo', 'dev', 'detached-run');
    fs.mkdirSync(directory, { recursive: true });
    // A draft checkout can leave unreadable evidence. Explicit discard names only its marker.
    fs.writeFileSync(path.join(directory, `owner-${id}.json`), '{');
    const discards = await Promise.all([
      f.run(['dev:stop', '--discard-run', id, '--json']),
      f.run(['dev:stop', '--discard-run', id, '--json']),
    ]);
    expect(discards.map((result) => result.exitCode)).toEqual([0, 0]);
    const started = await f.start();
    expect(started.exitCode, started.all).toBe(0);
    const owner = JSON.parse(started.stdout);
    const stale = await f.run(['dev:stop', '--discard-run', id, '--json']);
    expect(stale.exitCode, stale.all).toBe(0);
    expect(JSON.parse(stale.stdout)).toMatchObject({ discardedRun: null, stopped: false });
    expect(await readDevLockAsync(f.root)).toMatchObject({ pid: owner.pid });
    const retry = await f.start();
    expect(retry.exitCode, retry.all).toBe(20);
  } finally {
    await f.cleanup();
  }
});

it.each([['--force'], ['--eas'], ['--release'], ['--signal', 'SIGKILL'], ['--port', '8081']])(
  'discard rejects side-effect options: %j',
  async (...options) => {
    const f = await detachedRunFixture();
    try {
      const result = await f.run(['dev:stop', '--discard-run', randomUUID(), ...options, '--json']);
      expect(result.exitCode, result.all).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe('BAD_ARGS');
    } finally {
      await f.cleanup();
    }
  }
);
