import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { lockAddressFor } from '../../src/devLock/address';
import { detachedRunFixture } from '../detachedRunFixture';

// @ref llp/0036-detached-run-ownership.rfc.md
it('simultaneous detached starts elect one owner and normal stop releases it', async () => {
  const f = await detachedRunFixture();
  try {
    const results = await Promise.all([f.start(), f.start()]);
    expect(results.map((result) => result.exitCode).sort()).toEqual([0, 20]);
    const winner = JSON.parse(results.find((result) => result.exitCode === 0)!.stdout);
    const refused = JSON.parse(results.find((result) => result.exitCode === 20)!.stdout);
    expect(['DEV_START_BUSY', 'DEV_SERVER_RUNNING']).toContain(refused.error.code);
    expect(refused.error.data.pid).toBe(winner.pid);
    const stopped = await f.run(['dev:stop', '--json']);
    expect(stopped.exitCode, stopped.all).toBe(0);
    const restarted = await f.start();
    expect(restarted.exitCode, restarted.all).toBe(0);
    expect(JSON.parse(restarted.stdout).pid).not.toBe(winner.pid);
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
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  try {
    const directory = path.join(f.root, '.expo', 'dev', 'detached-run');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, `owner-${id}.json`),
      JSON.stringify({
        id,
        pid: 2147483647,
        logFile: path.join(f.root, 'owner.log'),
        endpoint,
      })
    );
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
