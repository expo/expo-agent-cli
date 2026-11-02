import path from 'node:path';

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

it.skipIf(process.platform === 'win32')(
  'SIGKILL retains ownership and discard leaves a surviving server subject to foreign-server refusal',
  async () => {
    const f = await detachedRunFixture();
    try {
      const started = await f.start();
      expect(started.exitCode, started.all).toBe(0);
      const owner = JSON.parse(started.stdout);
      const id = path.basename(owner.logFile).slice('dev-detached-'.length, -'.log'.length);
      const stopped = await f.run(['dev:stop', '--signal', 'SIGKILL', '--json']);
      expect(await (await fetch(`${owner.url}/status`)).text()).toBe('packager-status:running');
      expect(() => process.kill(f.serverPid(), 0)).not.toThrow();
      expect(stopped.stdout).toContain(
        `processes in other groups may still be running on port ${f.port}`
      );
      expect(stopped.stdout).toContain(`dev:stop --discard-run ${id}`);
      const refused = await f.start();
      expect(refused.exitCode, refused.all).toBe(20);
      expect(JSON.parse(refused.stdout).error.code).toBe('DEV_START_UNCERTAIN');
      const discarded = await f.run(['dev:stop', '--discard-run', id, '--json']);
      expect(discarded.exitCode, discarded.all).toBe(0);
      const foreign = await f.start();
      expect(foreign.exitCode, foreign.all).toBe(20);
      expect(foreign.stdout).toContain('FOREIGN_DEV_SERVER');
      expect(() => process.kill(f.serverPid(), 0)).not.toThrow();
      await f.stopServer();
      const restarted = await f.start();
      expect(restarted.exitCode, restarted.all).toBe(0);
    } finally {
      await f.cleanup();
    }
  }
);
