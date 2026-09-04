// @ref llp/0002-testing-and-evals.plan.md
// The readiness wait, against a real HTTP server rather than a mocked `fetch`: the contract under
// test is an HTTP one — flushed headers, a body that arrives later, a request that is aborted
// mid-flight — and a stubbed `fetch` would be a test of the stub.

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

import {
  PACKAGER_STATUS_READY,
  waitForAppConnectionAsync,
  waitForBundlerReadyAsync,
  waitForFreshAppConnectionAsync,
} from '../waitReady';

type StatusHandler = (request: { url: string }) => {
  status?: number;
  headers?: Record<string, string>;
  /** Body to write, after `delayMs`. */
  body?: string;
  delayMs?: number;
};

const servers: Server[] = [];

/** Start a throwaway HTTP server on an ephemeral port, closed after the test. */
async function startServerAsync(handler: StatusHandler): Promise<string> {
  const server = createServer((request, response) => {
    const {
      status = 200,
      headers = {},
      body = '',
      delayMs = 0,
    } = handler({
      url: request.url ?? '',
    });
    response.writeHead(status, { 'Content-Type': 'text/plain', ...headers });
    // Headers first, body later: this is what makes `/status` a wait rather than a poll.
    response.flushHeaders();
    // Unreferenced, so a body this test never waits for — the timeout and abort cases — cannot
    // hold the vitest worker open for the delay it was given.
    setTimeout(() => response.end(body), delayMs).unref();
  });
  server.unref();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe(waitForBundlerReadyAsync, () => {
  it(`reports a dev server that is ready now`, async () => {
    const url = await startServerAsync(() => ({ body: PACKAGER_STATUS_READY }));

    const result = await waitForBundlerReadyAsync(url, { timeoutMs: 2000 });

    expect(result.ready).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(result.waitedMs).toBeGreaterThanOrEqual(0);
  });

  it(`waits for a dev server that answers after a delay`, async () => {
    const url = await startServerAsync(() => ({ body: PACKAGER_STATUS_READY, delayMs: 150 }));

    const result = await waitForBundlerReadyAsync(url, { timeoutMs: 5000 });

    // One long-lived request, not a poll: the wait ends when the bundler does.
    expect(result.ready).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(100);
  });

  it(`reports a body that is not the packager status`, async () => {
    const url = await startServerAsync(() => ({ body: '<html>not metro</html>' }));

    const result = await waitForBundlerReadyAsync(url, { timeoutMs: 2000 });

    expect(result.ready).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.reason).toContain('not an Expo dev server');
  });

  it(`reports a status endpoint that answers with an error code`, async () => {
    const url = await startServerAsync(() => ({ status: 404, body: 'nope' }));

    const result = await waitForBundlerReadyAsync(url, { timeoutMs: 2000 });

    expect(result.ready).toBe(false);
    expect(result.reason).toContain('404');
  });

  it(`matches the project root the dev server names`, async () => {
    const url = await startServerAsync(() => ({
      body: PACKAGER_STATUS_READY,
      headers: { 'X-React-Native-Project-Root': encodeURI('/tmp/my app') },
    }));

    const result = await waitForBundlerReadyAsync(url, {
      timeoutMs: 2000,
      projectRoot: '/tmp/my app',
    });

    // The header is URI-encoded upstream, so a project root with a space still matches.
    expect(result.ready).toBe(true);
    expect(result.projectRootMatched).toBe(true);
    expect(result.reportedProjectRoot).toBe('/tmp/my app');
  });

  it(`reports a mismatched project root, which is another project's dev server`, async () => {
    const url = await startServerAsync(() => ({
      body: PACKAGER_STATUS_READY,
      headers: { 'X-React-Native-Project-Root': '/tmp/some-other-app' },
    }));

    const result = await waitForBundlerReadyAsync(url, {
      timeoutMs: 2000,
      projectRoot: '/tmp/my-app',
    });

    // Ready and wrong: the bundle is finished, but it is not this project's bundle.
    expect(result.ready).toBe(true);
    expect(result.projectRootMatched).toBe(false);
    expect(result.reportedProjectRoot).toBe('/tmp/some-other-app');
  });

  it(`cannot decide the project root when the dev server names none`, async () => {
    const url = await startServerAsync(() => ({ body: PACKAGER_STATUS_READY }));

    const result = await waitForBundlerReadyAsync(url, {
      timeoutMs: 2000,
      projectRoot: '/tmp/my-app',
    });

    expect(result.projectRootMatched).toBeNull();
  });

  it(`cannot decide the project root when the caller names none`, async () => {
    const url = await startServerAsync(() => ({
      body: PACKAGER_STATUS_READY,
      headers: { 'X-React-Native-Project-Root': '/tmp/my-app' },
    }));

    const result = await waitForBundlerReadyAsync(url, { timeoutMs: 2000 });

    expect(result.projectRootMatched).toBeNull();
  });

  it(`times out on a dev server that is still bundling`, async () => {
    const url = await startServerAsync(() => ({
      body: PACKAGER_STATUS_READY,
      delayMs: 5000,
    }));

    const result = await waitForBundlerReadyAsync(url, { timeoutMs: 150 });

    expect(result.ready).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.reason).toContain('150ms');
  });

  // The headers are flushed before the bundler is awaited, so the request that expires has still
  // answered "whose dev server is this" — which is what `status` reports without ever waiting.
  it(`still answers the project root on a wait that expired`, async () => {
    const url = await startServerAsync(() => ({
      body: PACKAGER_STATUS_READY,
      headers: { 'X-React-Native-Project-Root': '/tmp/my-app' },
      delayMs: 5000,
    }));

    const result = await waitForBundlerReadyAsync(url, {
      timeoutMs: 150,
      projectRoot: '/tmp/my-app',
    });

    expect(result.timedOut).toBe(true);
    expect(result.projectRootMatched).toBe(true);
    expect(result.reportedProjectRoot).toBe('/tmp/my-app');
  });

  it(`stops on an abort from the caller, without calling it a timeout`, async () => {
    const url = await startServerAsync(() => ({ body: PACKAGER_STATUS_READY, delayMs: 5000 }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await waitForBundlerReadyAsync(url, {
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    // A caller that gave up is not a bundler that took too long, and the two need different
    // exit codes (llp/0010 §Exit codes).
    expect(result.ready).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it(`reports a URL nothing could even be asked at, instead of throwing`, async () => {
    // Port 1 is not a refused connection — `undici` rejects it as `bad port` before it opens a
    // socket [observed, 2026-09-04]. That is a settled answer rather than something to wait for,
    // which is why this returns at once and does not retry.
    const result = await waitForBundlerReadyAsync('http://127.0.0.1:1', { timeoutMs: 2000 });

    expect(result.ready).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  // @ref ../waitReady §waitForBundlerReadyAsync — "a refused connection is not an answer".
  //
  // The bug these cases exist for, and it cost a real run: `expo run:ios` publishes the dev-server
  // lock at the **start** of its step, so `--wait-ready` asked a port that Xcode had not opened
  // yet, was refused in about ten milliseconds, and reported the wait as over. `smoke --ios` on a
  // project needing a development build failed in 23 seconds having built nothing
  // [observed — Kudo, local run, 2026-09-04].
  //
  // The old design was one request and no loop, because `/status` answers only once the bundler has
  // finished — so the request *is* the wait. True while something is listening; false in exactly
  // the expensive case.
  describe('a port nothing is listening on yet', () => {
    /** A port that is free now, so the first requests to it are refused. */
    async function freePortAsync(): Promise<number> {
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
      const { port } = probe.address() as AddressInfo;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      return port;
    }

    it(`keeps asking until the dev server opens the port, then reads it`, async () => {
      const port = await freePortAsync();
      // Nothing is listening for the first while, which is the state a native build leaves the
      // port in. The wait has to survive it rather than call it an answer.
      const opening = setTimeout(() => {
        const server = createServer((_request, response) => {
          response.writeHead(200, { 'Content-Type': 'text/plain' });
          response.end(PACKAGER_STATUS_READY);
        });
        server.unref();
        server.listen(port, '127.0.0.1');
        servers.push(server);
      }, 1500);
      opening.unref?.();

      const result = await waitForBundlerReadyAsync(`http://127.0.0.1:${port}`, {
        timeoutMs: 15_000,
      });

      expect(result.ready).toBe(true);
      // The proof that it waited rather than answered: a refused connection comes back in
      // milliseconds, and the server did not exist for the first second and a half.
      expect(result.waitedMs).toBeGreaterThan(1_000);
    }, 20_000);

    // And when nothing ever listens, the budget decides — with a sentence that says which of the
    // two things happened, because "the bundler was still working" would be false: there was no
    // bundler (llp/0021 §The rules).
    it(`times out saying nothing was listening, rather than that the bundler was busy`, async () => {
      const port = await freePortAsync();

      const result = await waitForBundlerReadyAsync(`http://127.0.0.1:${port}`, {
        timeoutMs: 2_500,
      });

      expect(result.ready).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.reason).toContain('nothing was listening');
      expect(result.waitedMs).toBeGreaterThan(2_000);
    }, 10_000);

    // A caller's own signal still ends it at once. A retry loop that outlived the caller's abort
    // would be a wait nobody could stop.
    it(`stops at once when the caller aborts, mid-retry`, async () => {
      const port = await freePortAsync();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300).unref?.();

      const result = await waitForBundlerReadyAsync(`http://127.0.0.1:${port}`, {
        timeoutMs: 30_000,
        signal: controller.signal,
      });

      expect(result.ready).toBe(false);
      // A caller that gave up is not a budget that expired, and the two need different exit codes.
      expect(result.timedOut).toBe(false);
      expect(result.waitedMs).toBeLessThan(5_000);
    }, 10_000);

    // A name that does not resolve is settled, not pending: retrying it would turn a typo into a
    // twenty-minute hang (@ref ../waitReady §isNotListening).
    it(`does not wait out a hostname that does not resolve`, async () => {
      const result = await waitForBundlerReadyAsync('http://nope.invalid.example:8081', {
        timeoutMs: 30_000,
      });

      expect(result.ready).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.waitedMs).toBeLessThan(5_000);
    }, 10_000);
  });
});

describe(waitForAppConnectionAsync, () => {
  it(`returns as soon as a target is listed`, async () => {
    const url = await startServerAsync(() => ({ body: JSON.stringify([{ id: '1' }]) }));

    const result = await waitForAppConnectionAsync(url, { timeoutMs: 2000, intervalMs: 10 });

    expect(result).toMatchObject({ appsConnected: 1, timedOut: false });
  });

  it(`waits for an app that attaches during the window`, async () => {
    let attached = false;
    setTimeout(() => (attached = true), 60);
    const url = await startServerAsync(() => ({
      body: JSON.stringify(attached ? [{ id: '1' }] : []),
    }));

    const result = await waitForAppConnectionAsync(url, { timeoutMs: 2000, intervalMs: 20 });

    expect(result).toMatchObject({ appsConnected: 1, timedOut: false });
  });

  it(`times out when no app ever attaches`, async () => {
    const url = await startServerAsync(() => ({ body: '[]' }));

    const result = await waitForAppConnectionAsync(url, { timeoutMs: 120, intervalMs: 20 });

    expect(result).toMatchObject({ appsConnected: 0, timedOut: true });
  });
});

describe(waitForFreshAppConnectionAsync, () => {
  // The whole reason this exists, and the shape of friction run 4's F39/F45: the reloading app's
  // *old* target is still listed for the first half-second after a reload broadcast [observed —
  // 2026-08-23, live: the target id went `…-1` -> `…-2` at 761 ms, and the pre-reload id was
  // served until 506 ms]. A wait that accepts any target accepts that one.
  it(`ignores a target that was already there before the reload`, async () => {
    let reregistered = false;
    setTimeout(() => (reregistered = true), 80);
    const url = await startServerAsync(() => ({
      body: JSON.stringify([{ id: reregistered ? 'device-2' : 'device-1' }]),
    }));

    const result = await waitForFreshAppConnectionAsync(url, {
      timeoutMs: 2000,
      intervalMs: 20,
      knownTargetIds: ['device-1'],
    });

    expect(result).toMatchObject({ appsConnected: 1, freshTargets: 1, timedOut: false });
  });

  it(`times out while only the pre-reload target is listed`, async () => {
    const url = await startServerAsync(() => ({ body: JSON.stringify([{ id: 'device-1' }]) }));

    const result = await waitForFreshAppConnectionAsync(url, {
      timeoutMs: 120,
      intervalMs: 20,
      knownTargetIds: ['device-1'],
    });

    // The count is what the dev server reported, and `freshTargets` is what was proved: reporting
    // `appsConnected: 1` alone is the false success this function exists to make impossible.
    expect(result).toMatchObject({ appsConnected: 1, freshTargets: 0, timedOut: true });
  });

  // An app that was not running before the reload has no id to be new against, so every target is.
  it(`accepts any target when nothing was connected before`, async () => {
    const url = await startServerAsync(() => ({ body: JSON.stringify([{ id: 'device-9' }]) }));

    const result = await waitForFreshAppConnectionAsync(url, {
      timeoutMs: 2000,
      intervalMs: 20,
      knownTargetIds: [],
    });

    expect(result).toMatchObject({ appsConnected: 1, freshTargets: 1, timedOut: false });
  });

  // F45: the app quit during the reload. Zero targets is never a success, however many peers churned.
  it(`reports zero when the app went away and did not come back`, async () => {
    const url = await startServerAsync(() => ({ body: '[]' }));

    const result = await waitForFreshAppConnectionAsync(url, {
      timeoutMs: 120,
      intervalMs: 20,
      knownTargetIds: ['device-1'],
    });

    expect(result).toMatchObject({ appsConnected: 0, freshTargets: 0, timedOut: true });
  });
});
