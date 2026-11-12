import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { listenAttemptAsync } from '../../src/dev/detachedProtocol';
import { lockAddressFor } from '../../src/devLock/address';
import { detachedRunFixture } from '../detachedRunFixture';
import { installStubEasAsync, stubEasCommands, writeCloudBindingAsync } from '../stubEas';
import {
  executeAgentCliAsync,
  expoHomeOf,
  fixturesDir,
  freePortAsync,
  holdDevLockAsync,
  killAsync,
  setupFixtureAsync,
  waitForAsync,
} from '../utils';

it.each([false, true])(
  'an unresponsive detached owner retains resources and names diagnostics (lock: %s)',
  async (withLock) => {
    const root = await setupFixtureAsync('go-app');
    const id = randomUUID();
    const directory = path.join(root, '.expo', 'dev', 'detached-run');
    const logFile = path.join(root, 'selected-owner.log');
    const signalled = path.join(root, 'owner-signalled');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      require('node:fs').writeFileSync(${JSON.stringify(logFile)}, 'ready');
      process.on('SIGTERM', () => require('node:fs').writeFileSync(${JSON.stringify(signalled)}, 'yes'));
      setInterval(() => {}, 1000);
    `,
      ],
      { stdio: 'ignore', detached: true }
    );
    const endpoint = lockAddressFor(root, { name: `detached-${id}` }).address;
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.end();
    });
    const port = await freePortAsync();
    let releaseLock: (() => void) | undefined;
    try {
      expect(await waitForAsync(() => fs.existsSync(logFile), 5000)).toBe(true);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(endpoint, resolve);
      });
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, `owner-${id}.json`),
        JSON.stringify({
          id,
          pid: child.pid,
          logFile,
          endpoint,
        })
      );
      if (withLock)
        releaseLock = await holdDevLockAsync(root, {
          pid: child.pid!,
          port,
          url: `http://127.0.0.1:${port}`,
          projectRoot: root,
          startedAt: new Date().toISOString(),
        });
      const { binDir } = await installStubEasAsync(root);
      await writeCloudBindingAsync(expoHomeOf(root), root, {
        id: 'captured-session',
        platform: 'android',
      });
      const started = Date.now();
      const result = await executeAgentCliAsync(
        root,
        ['dev:stop', '--eas', '--release', '--timeout', '300ms', '--json'],
        {
          reject: false,
          env: {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            AGENT_CLI_NO_DEVICE: '0',
          },
        }
      );
      expect(Date.now() - started).toBeLessThan(2500);
      expect(result.exitCode, result.all).toBe(20);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        stopped: false,
        admission: 'retained',
        pid: child.pid,
        signal: null,
      });
      expect(report.detail).toContain(logFile);
      expect(report.detail).toContain('captured-session');
      if (withLock) expect(report.detail).toContain(String(port));
      expect(fs.existsSync(signalled)).toBe(false);
      expect(stubEasCommands(root)).toEqual([]);
      expect(fs.existsSync(path.join(directory, `owner-${id}.json`))).toBe(true);
    } finally {
      releaseLock?.();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await killAsync(child, 'SIGKILL');
    }
  }
);

it('an explicit other port never cancels the detached owner', async () => {
  const f = await detachedRunFixture();
  try {
    const started = await f.start();
    expect(started.exitCode, started.all).toBe(0);
    const owner = JSON.parse(started.stdout);
    const otherPort = await freePortAsync();
    const result = await f.run(['dev:stop', '--port', String(otherPort), '--json']);
    expect(result.exitCode, result.all).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      stopped: false,
      port: otherPort,
      signal: null,
    });
    expect(await (await fetch(`${owner.url}/status`)).text()).toBe('packager-status:running');
  } finally {
    await f.cleanup();
  }
});

it('a canceled building owner reports no ready Metro even after its PID exits', async () => {
  const root = await setupFixtureAsync('go-app');
  const id = randomUUID();
  const directory = path.join(root, '.expo', 'dev', 'detached-run');
  const logFile = path.join(root, 'building-owner.log');
  const address = lockAddressFor(root, { name: `detached-${id}` }).address;
  const port = await freePortAsync();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: true,
  });
  const metro = { kind: 'awaiting', plannedPort: port } as const;
  let settling: Promise<void> | undefined;
  let endpoint: Awaited<ReturnType<typeof listenAttemptAsync>> | undefined;
  let releaseLock: (() => void) | undefined;
  try {
    endpoint = await listenAttemptAsync(address, id, {
      inspect: () => ({ kind: 'starting', metro }),
      cancel() {
        settling ??= (async () => {
          await killAsync(child, 'SIGKILL');
          endpoint?.close({
            kind: 'finished',
            metro,
            admission: 'released',
            cleanup: { sessions: [], devices: [] },
          });
        })();
      },
    });
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, `owner-${id}.json`),
      JSON.stringify({ id, pid: child.pid, logFile, endpoint: address })
    );
    releaseLock = await holdDevLockAsync(root, {
      pid: child.pid!,
      port,
      url: `http://127.0.0.1:${port}`,
      projectRoot: root,
      startedAt: new Date().toISOString(),
    });
    const result = await executeAgentCliAsync(root, ['dev:stop', '--json']);
    expect(result.exitCode, result.all).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      stopped: false,
      reason: 'not-running',
      admission: 'released',
      processStillRunning: false,
    });
  } finally {
    releaseLock?.();
    await settling;
    endpoint?.close();
    await killAsync(child, 'SIGKILL');
  }
});

it.skipIf(process.platform !== 'win32')(
  'ordinary Windows stop cooperates without taskkill',
  async () => {
    const f = await detachedRunFixture();
    try {
      expect((await f.start()).exitCode).toBe(0);
      const result = await executeAgentCliAsync(f.root, ['dev:stop', '--json'], {
        reject: false,
        env: {
          NODE_OPTIONS: `--require "${path.join(fixturesDir, 'ownership-stop-fault.cjs').replaceAll('\\', '/')}"`,
        },
      });
      expect(result.exitCode, result.all).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        stopped: true,
        reason: null,
        admission: 'released',
      });
      expect(fs.existsSync(path.join(f.root, '.expo', 'dev', 'detached-run'))).toBe(false);
      expect((await f.start()).exitCode).toBe(0);
    } finally {
      await f.cleanup();
    }
  }
);
