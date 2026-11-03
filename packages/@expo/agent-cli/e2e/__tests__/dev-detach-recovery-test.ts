import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { detachedRunFixture } from '../detachedRunFixture';
import { detachedBarrierFixture } from '../detachedBarrierFixture';
import { executeAgentCliAsync, fixturesDir, readDevLockAsync, waitForAsync } from '../utils';

// @ref llp/0036-detached-run-ownership.rfc.md
it('death after publication but before work requires explicit discard', async () => {
  const f = await detachedBarrierFixture();
  try {
    const first = f.start({ DETACH_TEST_CLAIM_BARRIER: '1' });
    expect(await waitForAsync(() => f.marks('claimed').length === 1, 15_000)).toBe(true);
    process.kill(Number(f.marks('claimed')[0]!.slice('claimed-'.length)), 'SIGKILL');
    await first.result;
    const refused = await f.start().result;
    expect(refused.exitCode, refused.all).toBe(20);
    const error = JSON.parse(refused.stdout).error;
    expect(error.code).toBe('DEV_START_UNCERTAIN');
    expect(f.marks('blocked')).toHaveLength(0);
    const args = error.suggestedCommand.split(' ').slice(2);
    const discarded = await executeAgentCliAsync(f.root, [...args, '--json']);
    expect(discarded.exitCode, discarded.all).toBe(0);
    f.release();
    const started = await f.start().result;
    expect(started.exitCode, started.all).toBe(0);
  } finally {
    await f.cleanup();
  }
});

it.skipIf(process.platform !== 'win32')(
  'a failed Windows tree stop retains ownership',
  async () => {
    const f = await detachedRunFixture();
    try {
      const started = await f.start();
      expect(started.exitCode, started.all).toBe(0);
      const owner = JSON.parse(started.stdout);
      const failed = await executeAgentCliAsync(
        f.root,
        ['dev:stop', '--timeout', '200ms', '--json'],
        {
          reject: false,
          env: { SystemRoot: path.join(f.root, 'missing-system-root') },
        }
      );
      expect(failed.exitCode, failed.all).toBe(20);
      expect(JSON.parse(failed.stdout)).toMatchObject({
        stopped: false,
        processStillRunning: true,
      });
      const id = path.basename(owner.logFile).slice('dev-detached-'.length, -'.log'.length);
      const discarded = await f.run(['dev:stop', '--discard-run', id, '--json']);
      expect(discarded.exitCode, discarded.all).toBe(20);
      expect(JSON.parse(discarded.stdout).error.code).toBe('DEV_START_BUSY');
    } finally {
      await f.cleanup();
    }
  }
);

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

it.for(['discard', 'Windows stop'])(
  'delayed %s cannot remove replacement ownership',
  async (operation, context) => {
    if (operation === 'Windows stop' && process.platform !== 'win32') context.skip();
    const f = await detachedRunFixture();
    const paused = path.join(f.root, 'removal-paused');
    const release = path.join(f.root, 'release-removal');
    let delayed: ReturnType<typeof executeAgentCliAsync> | undefined;
    try {
      let id: string = randomUUID();
      const directory = path.join(fs.realpathSync(f.root), '.expo', 'dev', 'detached-run');
      if (operation === 'Windows stop') {
        const started = await f.start();
        expect(started.exitCode, started.all).toBe(0);
        id = path
          .basename(JSON.parse(started.stdout).logFile)
          .slice('dev-detached-'.length, -'.log'.length);
      } else {
        fs.mkdirSync(directory, { recursive: true });
        // Old draft evidence is unreadable, but its filename still bounds explicit discard.
        fs.writeFileSync(path.join(directory, `owner-${id}.json`), '{');
      }
      delayed = executeAgentCliAsync(
        f.root,
        ['dev:stop', ...(operation === 'discard' ? ['--discard-run', id] : []), '--json'],
        {
          reject: false,
          env: {
            NODE_OPTIONS: `--require "${path.join(fixturesDir, 'ownership-remove-barrier.cjs').replaceAll('\\', '/')}"`,
            OWNERSHIP_TEST_REMOVE: path.join(directory, `owner-${id}.json`),
            OWNERSHIP_TEST_PAUSED: paused,
            OWNERSHIP_TEST_RELEASE: release,
          },
        }
      );
      expect(await waitForAsync(() => fs.existsSync(paused), 15_000)).toBe(true);
      const discarded = await f.run(['dev:stop', '--discard-run', id, '--json']);
      expect(discarded.exitCode, discarded.all).toBe(0);
      const started = await f.start();
      expect(started.exitCode, started.all).toBe(0);
      const owner = JSON.parse(started.stdout);
      fs.writeFileSync(release, '');
      const finished = await delayed;
      expect(finished.exitCode, finished.all).toBe(0);
      expect(JSON.parse(finished.stdout).stopped).toBe(operation === 'Windows stop');
      expect(await readDevLockAsync(f.root)).toMatchObject({ pid: owner.pid });
      const retry = await f.start();
      expect(retry.exitCode, retry.all).toBe(20);
      expect(JSON.parse(retry.stdout).error.data.pid).toBe(owner.pid);
    } finally {
      fs.writeFileSync(release, '');
      await delayed;
      await f.cleanup();
    }
  }
);

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
