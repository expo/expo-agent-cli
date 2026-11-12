import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { lockAddressFor } from '../../src/devLock/address';
import { detachedRunFixture } from '../detachedRunFixture';
import { detachedBarrierFixture } from '../detachedBarrierFixture';
import { executeAgentCliAsync, fixturesDir, waitForAsync } from '../utils';

function publishEvidence(root: string, id: string) {
  const endpoint = lockAddressFor(root, { name: `detached-${id}` }).address;
  const directory = path.join(root, '.expo', 'dev', 'detached-run');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `owner-${id}.json`),
    JSON.stringify({ id, pid: 2147483647, logFile: path.join(root, 'owner.log'), endpoint })
  );
  return endpoint;
}

// @ref llp/0036-detached-run-ownership.rfc.md
it('death before publication leaves admission available', async () => {
  const f = await detachedBarrierFixture();
  try {
    const first = f.start({ DETACH_TEST_BOOT_BARRIER: '1' });
    expect(await waitForAsync(() => f.marks('child').length === 1, 15_000)).toBe(true);
    process.kill(Number(f.marks('child')[0]!.slice('child-'.length)), 'SIGKILL');
    expect((await first.result).exitCode).not.toBe(0);
    f.release();
    const replacement = await f.start().result;
    expect(replacement.exitCode, replacement.all).toBe(0);
  } finally {
    await f.cleanup();
  }
});

it('an empty ownership directory does not prevent publication', async () => {
  const f = await detachedRunFixture();
  try {
    fs.mkdirSync(path.join(f.root, '.expo', 'dev', 'detached-run'), { recursive: true });
    const started = await f.start();
    expect(started.exitCode, started.all).toBe(0);
  } finally {
    await f.cleanup();
  }
});

it('a silent ownership endpoint prevents admission regardless of its diagnostic PID', async () => {
  const f = await detachedRunFixture();
  const id = randomUUID();
  const endpoint = lockAddressFor(f.root, { name: `detached-${id}` }).address;
  fs.mkdirSync(path.join(f.root, '.expo'), { recursive: true });
  const server = net.createServer((socket) => {
    socket.resume();
    socket.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  try {
    publishEvidence(f.root, id);
    const refused = await f.start();
    expect(refused.exitCode, refused.all).toBe(20);
    expect(JSON.parse(refused.stdout).error.code).toBe('DEV_START_BUSY');
    const discard = await f.run(['dev:stop', '--discard-run', id, '--json']);
    expect(discard.exitCode, discard.all).toBe(20);
    expect(JSON.parse(discard.stdout).error.code).toBe('DEV_START_BUSY');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
});

it.each(['EACCES', 'timeout'])(
  'an uncertain endpoint (%s) permits neither start nor discard',
  async (fault) => {
    const f = await detachedRunFixture();
    const id = randomUUID();
    const endpoint = publishEvidence(f.root, id);
    const env = {
      NODE_OPTIONS: `--require "${path.join(fixturesDir, 'ownership-probe-fault.cjs').replaceAll('\\', '/')}"`,
      OWNERSHIP_TEST_ENDPOINT: endpoint,
      OWNERSHIP_TEST_FAULT: fault,
    };
    try {
      for (const args of [
        [
          'dev',
          '--android',
          '--local',
          '--go',
          '--no-open',
          '--port',
          String(f.port),
          '--detach',
          '--wait-ready',
        ],
        ['dev:stop', '--discard-run', id],
      ]) {
        const result = await executeAgentCliAsync(f.root, [...args, '--json'], {
          env,
          reject: false,
        });
        expect(result.exitCode, result.all).toBe(20);
        expect(JSON.parse(result.stdout).error.code).toBe('DEV_START_UNCERTAIN');
        expect(JSON.parse(result.stdout).error.suggestedCommand).toBeNull();
      }
      // Removing the network fault reveals the retained evidence and its explicit recovery.
      const refused = await f.start();
      expect(refused.exitCode, refused.all).toBe(20);
      expect(refused.stdout).toContain(`dev:stop --discard-run ${id}`);
      const discarded = await f.run(['dev:stop', '--discard-run', id, '--json']);
      expect(JSON.parse(discarded.stdout).discardedRun).toBe(id);
    } finally {
      await f.cleanup();
    }
  }
);
