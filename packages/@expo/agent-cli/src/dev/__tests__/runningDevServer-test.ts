// @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

import type { DevServerLockInfo } from '../../devLock';
import {
  devServerRunningError,
  devServerRunningReason,
  runningDevServerAsync,
  type RunningDevServer,
} from '../runningDevServer';
import { lockInfo } from '../../devLock/__tests__/fakeLock';

const projectRoot = '/workspace/apps/my-app';

function lockOn(port: number): DevServerLockInfo {
  return {
    ...lockInfo(),
    url: `http://127.0.0.1:${port}`,
    port,
    pid: 4242,
    startedAt: '2026-10-07T00:00:00.000Z',
    projectRoot,
  };
}

describe(runningDevServerAsync, () => {
  let server: Server | null = null;

  async function listenAsync(handler: Parameters<typeof createServer>[1]): Promise<number> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  /** A dev server whose `/status` answers ready, naming this project root. */
  async function serveStatusAsync(root: string): Promise<number> {
    return listenAsync((_request, response) => {
      response.writeHead(200, { 'X-React-Native-Project-Root': root });
      response.end('packager-status:running');
    });
  }

  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    server = null;
  });

  it(`is serving when /status answers for this project`, async () => {
    const lock = lockOn(await serveStatusAsync(projectRoot));

    expect(await runningDevServerAsync(projectRoot, lock)).toEqual({ lock, phase: 'serving' });
  });

  // llp/0004 §A busy port: no project-root header is this project's server, as for every consumer
  // of the probe. An implementation that demanded a matching header would call this one starting.
  it(`is serving when /status answers with no project-root header`, async () => {
    const port = await listenAsync((_request, response) => {
      response.writeHead(200);
      response.end('packager-status:running');
    });
    const lock = lockOn(port);

    expect(await runningDevServerAsync(projectRoot, lock)).toEqual({ lock, phase: 'serving' });
  });

  it(`is starting when another project's Metro answers on the lock's port`, async () => {
    const lock = lockOn(await serveStatusAsync('/workspace/apps/other-app'));

    expect(await runningDevServerAsync(projectRoot, lock)).toEqual({ lock, phase: 'starting' });
  });

  it(`is starting when nothing answers on the lock's port`, async () => {
    const port = await listenAsync(() => {});
    await new Promise((resolve) => server!.close(resolve));
    server = null;
    const lock = lockOn(port);

    expect(await runningDevServerAsync(projectRoot, lock)).toEqual({ lock, phase: 'starting' });
  });
});

describe(devServerRunningError, () => {
  const serving: RunningDevServer = { lock: lockOn(8081), phase: 'serving' };
  const starting: RunningDevServer = { lock: lockOn(8082), phase: 'starting' };

  it(`is an outcome with the facts it was made on`, () => {
    expect(devServerRunningError(serving, 'ios')).toMatchObject({
      code: 'DEV_SERVER_RUNNING',
      exitCode: 20,
      data: { port: 8081, pid: 4242, phase: 'serving' },
      suggestedCommand: 'npx @expo/agent-cli smoke --ios',
    });
    expect(devServerRunningError(starting, 'android')).toMatchObject({
      code: 'DEV_SERVER_RUNNING',
      exitCode: 20,
      data: { port: 8082, pid: 4242, phase: 'starting' },
      suggestedCommand: 'npx @expo/agent-cli status',
    });
  });

  // @ref llp/0015-backend-selection-and-config.rfc.md §The device backend
  it(`points a run whose device is on EAS at the session`, () => {
    const error = devServerRunningError(serving, 'ios', { eas: true });
    expect(error.suggestedCommand).toBe('npx @expo/agent-cli smoke --ios --eas');
    expect(error.message).toContain('"npx @expo/agent-cli navigate / --eas" opens a route');
  });

  it(`says what runs, and on which port`, () => {
    expect(devServerRunningError(serving, 'ios').message).toMatch(
      /^This project's dev server is already running on port 8081 \(pid 4242\), so nothing was started\.\nWhy: .*\nHow: /
    );
    expect(devServerRunningError(starting, 'ios').message).toMatch(
      /^This project's dev server is starting on port 8082 \(pid 4242\), so nothing was started\./
    );
  });

  it.each([serving, starting])(`never suggests the dev command that just failed`, (running) => {
    expect(devServerRunningError(running, 'ios').message).not.toContain('dev --');
  });
});

describe(devServerRunningReason, () => {
  it(`names the port and the pid`, () => {
    expect(devServerRunningReason({ lock: lockOn(8081), phase: 'serving' })).toBe(
      "This project's dev server is already running on port 8081 (pid 4242); the run stops instead of starting a second one."
    );
    expect(devServerRunningReason({ lock: lockOn(8081), phase: 'starting' })).toBe(
      "This project's dev server is starting on port 8081 (pid 4242); the run stops instead of starting a second one."
    );
  });
});
