// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
//
// `@expo/agent-cli dev --detach` through the published bin. Everything worth pinning here is what a unit
// test cannot see: the parent process **returns** while a dev server it started is still running,
// that server survives the parent's exit, its output lands in a file, and `dev:stop` takes the
// whole tree down again.
//
// The dev server is the stub `expo` bin, which holds the lock exactly as the real one does — the
// wrapper is what takes the lock, and the wrapper is real here.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

import { list as listSessions, tap } from '2g/api';

import { PORT_WATCH_TIMEOUT_MS } from '../../src/devLock/port';
import {
  executeAgentCliAsync,
  holdDevLockAsync,
  installStubFingerprintAsync,
  readDevLockAsync,
  readEvents,
  readStubExpoInvocations,
  setupFixtureAsync,
  startStubDevServerAsync,
  stubExpoEnv,
  waitForAsync,
} from '../utils';
import { DETACHED_LOG_PATH, cleanUpDetachedAsync, detachEnv, STUB_ALIVE_MS } from '../detachUtils';

/** A port nothing listens on now, read back from a server bound to port 0. */
async function freePortAsync(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Whether a pid is still alive, without signalling it. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('@expo/agent-cli dev --detach', () => {
  it('retains the Android request for status after stopping its server', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const port = await freePortAsync();
    const env = { ...detachEnv(projectRoot, port), STUB_EXPO_LISTEN: '1' };
    try {
      const started = await executeAgentCliAsync(
        projectRoot,
        [
          'dev',
          '--android',
          '--local',
          '--go',
          '--port',
          String(port),
          '--detach',
          '--wait-ready',
          '--json',
        ],
        { env, reject: false }
      );
      expect(started.exitCode, started.all).toBe(0);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(projectRoot, '.expo', 'agent-cli-last-dev.json'), 'utf8')
        )
      ).toMatchObject({ platform: 'android', port, buildBackend: 'local', runTarget: 'expo-go' });
      await cleanUpDetachedAsync(projectRoot);
      const status = await executeAgentCliAsync(projectRoot, ['status', '--json'], {
        env,
        reject: false,
      });
      expect(status.exitCode, status.all).toBe(0);
      const report = JSON.parse(status.stdout);
      expect(report.next.command).toBe(
        `npx @expo/agent-cli dev --android --local --go --port ${port} --detach --wait-ready`
      );
      expect(report.devServer).toMatchObject({
        url: `http://127.0.0.1:${port}`,
        running: false,
        source: 'last-request',
      });
    } finally {
      await cleanUpDetachedAsync(projectRoot);
    }
  });
  it.each(['foreign', 'hanging'] as const)(
    'follows its lock away from a %s status endpoint before reporting ready',
    async (answer) => {
      const projectRoot = await setupFixtureAsync('go-app');
      const own = await startStubDevServerAsync({ projectRoot, statusDelayMs: 200 });
      let moveTimer: ReturnType<typeof setTimeout> | undefined;
      let oldRequestClosed = false;
      const info = {
        url: '',
        port: 0,
        pid: process.pid,
        projectRoot,
        startedAt: new Date().toISOString(),
      };
      const previous = http.createServer((request, response) => {
        if (request.url !== '/status') {
          response.writeHead(404).end();
          return;
        }
        response.on('close', () => {
          oldRequestClosed = true;
        });
        // Move only after the CLI has actually asked the old port, avoiding a startup-time race
        // in the test itself. The lock payload is read anew for each connection.
        moveTimer ??= setTimeout(() => Object.assign(info, { url: own.url, port: own.port }), 500);
        if (answer === 'foreign') {
          response.writeHead(200, {
            'X-React-Native-Project-Root': encodeURI(path.join(projectRoot, '..', 'sibling')),
          });
          response.end('packager-status:running');
        }
      });
      await new Promise<void>((resolve) => previous.listen(0, '127.0.0.1', resolve));
      info.port = (previous.address() as net.AddressInfo).port;
      info.url = `http://127.0.0.1:${info.port}`;
      const release = await holdDevLockAsync(projectRoot, info);
      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['dev', '--web', '--detach', '--wait-ready', '--json'],
          { env: stubExpoEnv(projectRoot), reject: false }
        );
        expect(result.exitCode, result.all).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          url: own.url,
          port: own.port,
          pid: process.pid,
          alreadyRunning: true,
          ready: true,
          projectRootMatched: true,
        });
        expect(oldRequestClosed).toBe(true);
        expect(readStubExpoInvocations(projectRoot)).toEqual([]);
        // The CLI must neither stop nor reconfigure the foreign server while waiting.
        expect(previous.listening).toBe(true);
      } finally {
        clearTimeout(moveTimer);
        release();
        previous.closeAllConnections();
        await new Promise<void>((resolve) => previous.close(() => resolve()));
        await own.close();
      }
    }
  );

  // The whole finding, in one assertion: the command returns, and a dev server is running.
  it('returns while the dev server it started keeps running', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--detach', '--json'],
        { env: detachEnv(projectRoot, 8399) }
      );

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        url: 'http://127.0.0.1:8399',
        port: 8399,
        alreadyRunning: false,
        // `--wait-ready` was not asked for, so readiness is unknown rather than false.
        ready: null,
      });
      expect(report.pid).toBeGreaterThan(0);
      expect(report.logFile).toContain(DETACHED_LOG_PATH);
      // Line 1 of the child's log names the child, before its plan, so a re-run can tell who wrote it.
      const log = await fs.promises.readFile(path.join(projectRoot, DETACHED_LOG_PATH), 'utf8');
      expect(log.split('\n')[0]).toBe(`Detached dev run, pid ${report.pid}.`);

      // The parent has exited — this test is running — and the child has not.
      expect(isAlive(report.pid)).toBe(true);
      expect(await readDevLockAsync(projectRoot)).toMatchObject({ port: 8399, pid: report.pid });
    } finally {
      await cleanUpDetachedAsync(projectRoot);
    }
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
  // `@expo/cli` 58 reports its port only through `2g`. The detached run owns a `2g` session that
  // outlives this command, and the command returns once that report reaches the lock, not after
  // the `PORT_WATCH_TIMEOUT_MS` fallback.
  it.each(['a 2g session of its own', 'the LOG_EVENTS file of the caller'] as const)(
    'returns once the dev server reports its port through 2g, and keeps its events in %s',
    async (destination) => {
      const projectRoot = await setupFixtureAsync('go-app');
      const port = await freePortAsync();
      const eventsFile = path.join(projectRoot, 'events.jsonl');
      const logEnv = destination === 'a 2g session of its own' ? {} : { LOG_EVENTS: eventsFile };
      try {
        const startedAt = Date.now();
        const result = await executeAgentCliAsync(
          projectRoot,
          ['dev', '--ios', '--detach', '--json'],
          { env: { ...detachEnv(projectRoot, port), ...logEnv } }
        );
        const elapsedMs = Date.now() - startedAt;

        expect(result.exitCode, result.all).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.port).toBe(port);
        expect(elapsedMs).toBeLessThan(PORT_WATCH_TIMEOUT_MS - 5_000);

        const reported: number[] = [];
        if (destination === 'a 2g session of its own') {
          const session = (await listSessions()).find((s) => s.pid === report.pid);
          expect(session?.alive).toBe(true);
          for await (const entry of tap(session!.sessionDir, { filter: 'metro:instantiate' })) {
            reported.push(entry.port as number);
          }
        } else {
          for (const entry of readEvents(eventsFile)) {
            if (entry._e === 'metro:instantiate') reported.push(entry.port);
          }
        }
        expect(reported).toEqual([port]);
      } finally {
        await cleanUpDetachedAsync(projectRoot);
      }
    }
  );

  it('prints one JSON object with a stable set of keys', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--detach', '--json'],
        { env: detachEnv(projectRoot, 8398) }
      );

      expect(Object.keys(JSON.parse(result.stdout)).sort()).toEqual([
        'alreadyRunning',
        'device',
        'eas',
        'followups',
        'logFile',
        'phase',
        'pid',
        'port',
        'portMoved',
        'projectRootMatched',
        'ready',
        'tunnelUrl',
        'url',
        'waitedMs',
      ]);
    } finally {
      await cleanUpDetachedAsync(projectRoot);
    }
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
  // `bare-app`, whose plan is the single step `expo run:ios` (`plan-test.ts`), and a stub that
  // stays alive without ever serving, which is what a compiler looks like from here. The run's lock
  // says `building`, so the detach reports the run at once, with the port the dev server will take.
  it('says the plan is building rather than that a dev server started', async () => {
    const projectRoot = await setupFixtureAsync('bare-app');
    await installStubFingerprintAsync(projectRoot);
    const port = await freePortAsync();

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--detach', '--ios', '--local', '--json', '--port', String(port)],
        {
          env: {
            ...stubExpoEnv(projectRoot),
            // Longer than the port watch, so the step is still running when the lock is published:
            // a build holds the lock for minutes after it appears.
            STUB_EXPO_DELAY_MS: '45000',
          },
        }
      );

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.phase).toBe('building');
      // The port is still reported — it is where the dev server will be — and it is not claimed to
      // be one: `ready` was never asked for, and nothing here says a dev server started.
      expect(report.ready).toBeNull();
      expect(report.url).toBe(`http://127.0.0.1:${port}`);
    } finally {
      await cleanUpDetachedAsync(projectRoot);
    }
  });

  it('says a plain dev-server plan is serving', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--detach', '--json'],
        { env: detachEnv(projectRoot, 8397) }
      );

      expect(JSON.parse(result.stdout).phase).toBe('serving');
    } finally {
      await cleanUpDetachedAsync(projectRoot);
    }
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port
  // can complete — friction run 5, F48-4. The retry happens in the child, whose stderr goes to a
  // log file, so the move was announced on a stream nobody was watching: the parent printed the
  // port it landed on and never said it was not the port that was asked for.
  it('says on stdout when a busy port moved the dev server', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--detach', '--json'],
        {
          env: {
            ...stubExpoEnv(projectRoot),
            STUB_EXPO_DELAY_MS: STUB_ALIVE_MS,
            // The port the plan picks, which the stub then refuses: the race the retry covers.
            RCT_METRO_PORT: '8180',
            STUB_EXPO_PORT_BUSY: '8180',
          },
          reject: false,
        }
      );

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout);
      // The port that was busy, and the one the dev server is actually on — which is the port the
      // lock names, so the report agrees with what every other command will find.
      expect(report.portMoved).toEqual({ from: 8180, to: report.port });
      expect(report.port).not.toBe(8180);
      expect(await readDevLockAsync(projectRoot)).toMatchObject({ port: report.port });
    } finally {
      await cleanUpDetachedAsync(projectRoot);
    }
  });

  it('prints the move in the human report too', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    try {
      const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--detach'], {
        env: {
          ...stubExpoEnv(projectRoot),
          STUB_EXPO_DELAY_MS: STUB_ALIVE_MS,
          RCT_METRO_PORT: '8180',
          STUB_EXPO_PORT_BUSY: '8180',
        },
        reject: false,
      });

      expect(result.stdout).toContain('moved · 8180 was busy, so it took');
    } finally {
      await cleanUpDetachedAsync(projectRoot);
    }
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port.
  // Another project's Metro held `*:8081`, and `expo run:ios` with no terminal skipped its
  // dev server, deep-linked the app to that Metro, and exited 0, so the detached run failed with no
  // lock [observed — live suite, 2026-10-05]. The port is picked before the plan runs and passed
  // as `--port` to every step that serves.
  describe('a port another project holds', () => {
    /**
     * Hold a port on the unspecified address, dual-stack, the way Metro does.
     *
     * Every connection is dropped. A probe of the port from anything else on the machine sends a
     * request this server never reads, and an unread socket never closes, so `close()` would never
     * return.
     */
    async function holdDualStackAsync(port: number): Promise<net.Server | null> {
      const server = net.createServer((socket) => socket.destroy());
      return await new Promise((resolve) => {
        // Already held by something else on this machine, which is the same precondition.
        server.once('error', () => resolve(null));
        server.listen({ port, host: '::', ipv6Only: false }, () => resolve(server));
      });
    }

    function servingEnv(projectRoot: string): Record<string, string> {
      return {
        ...stubExpoEnv(projectRoot),
        STUB_EXPO_LISTEN: '1',
        STUB_EXPO_DELAY_MS: STUB_ALIVE_MS,
      };
    }

    it('runs the plan on the next free port and publishes that port', async () => {
      const projectRoot = await setupFixtureAsync('bare-app');
      await installStubFingerprintAsync(projectRoot);
      const held = await holdDualStackAsync(8081);

      try {
        const planned = await executeAgentCliAsync(
          projectRoot,
          ['dev', '--ios', '--local', '--plan', '--json'],
          { env: stubExpoEnv(projectRoot) }
        );
        const plan = JSON.parse(planned.stdout);
        expect(plan.devServerPort).toEqual({
          port: expect.any(Number),
          movedFrom: 8081,
          state: 'picked',
        });

        // A named port is a requirement: the plan says it is taken, and the run refuses it before
        // any step.
        const namedPlan = await executeAgentCliAsync(
          projectRoot,
          ['dev', '--ios', '--local', '--plan', '--json', '--port', '8081'],
          { env: stubExpoEnv(projectRoot) }
        );
        expect(JSON.parse(namedPlan.stdout)).toMatchObject({
          devServerPort: { port: 8081, movedFrom: null, state: 'named', taken: true },
          reasons: expect.not.arrayContaining([
            'The dev server port is picked again when the plan runs.',
          ]),
        });
        const named = await executeAgentCliAsync(
          projectRoot,
          ['dev', '--ios', '--local', '--json', '--port', '8081'],
          { env: stubExpoEnv(projectRoot), reject: false }
        );
        expect(named.exitCode).toBe(20);
        expect(JSON.parse(named.stdout).error.code).toBe('PORT_IN_USE');

        const result = await executeAgentCliAsync(
          projectRoot,
          // The run builds first, so only --wait-ready waits for the port it serves on.
          ['dev', '--ios', '--local', '--detach', '--wait-ready', '--json'],
          { env: servingEnv(projectRoot), reject: false }
        );

        expect(result.exitCode, result.all).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.port).not.toBe(8081);
        expect(report.portMoved).toEqual({ from: 8081, to: report.port });
        expect(await readDevLockAsync(projectRoot)).toMatchObject({ port: report.port });
        expect(readStubExpoInvocations(projectRoot).map(({ args }) => args)).toEqual([
          ['run:ios', '--port', String(report.port)],
        ]);
        // Said once, by the plan, and not again by the step it moved.
        const log = await fs.promises.readFile(path.join(projectRoot, DETACHED_LOG_PATH), 'utf8');
        expect(log.split('Port 8081 is busy; the dev server uses').length).toBe(2);
      } finally {
        await cleanUpDetachedAsync(projectRoot);
        await new Promise((resolve) => (held ? held.close(resolve) : resolve(null)));
      }
    });

    // Two moves: the plan moved off the held port, and the port it picked was taken before Metro
    // bound it. The report names the port the caller expected, not the one the plan picked.
    it('reports the move from the port the caller expected when the plan moved and the retry moved again', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      const held = await holdDualStackAsync(8481);

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['dev', '--ios', '--detach', '--json'],
          {
            env: {
              ...servingEnv(projectRoot),
              RCT_METRO_PORT: '8481',
              STUB_EXPO_EADDRINUSE_PORT: '8482',
            },
            reject: false,
          }
        );

        expect(result.exitCode, result.all).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.port).toBeGreaterThan(8482);
        expect(report.portMoved).toEqual({ from: 8481, to: report.port });
        const starts = readStubExpoInvocations(projectRoot).filter(
          ({ args }) => args[0] === 'start'
        );
        expect(starts.map(({ args }) => args.at(-1))).toEqual(['8482', String(report.port)]);
      } finally {
        await cleanUpDetachedAsync(projectRoot);
        await new Promise((resolve) => (held ? held.close(resolve) : resolve(null)));
      }
    });

    // The race the probe cannot close: the port it picked is taken while `expo run:ios` compiles,
    // and the Expo CLI stops with "became busy" and exit 1.
    it('retries a run:* step whose port became busy while it compiled', async () => {
      const projectRoot = await setupFixtureAsync('bare-app');
      await installStubFingerprintAsync(projectRoot);

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['dev', '--ios', '--local', '--detach', '--wait-ready', '--json'],
          {
            env: {
              ...servingEnv(projectRoot),
              RCT_METRO_PORT: '8471',
              STUB_EXPO_PORT_BUSY: '8471',
            },
            reject: false,
          }
        );

        expect(result.exitCode, result.all).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.port).not.toBe(8471);
        expect(report.portMoved).toEqual({ from: 8471, to: report.port });
        expect(await readDevLockAsync(projectRoot)).toMatchObject({ port: report.port });
        expect(readStubExpoInvocations(projectRoot).map(({ args }) => args)).toEqual([
          ['run:ios', '--port', '8471'],
          ['run:ios', '--port', String(report.port)],
        ]);
      } finally {
        await cleanUpDetachedAsync(projectRoot);
      }
    });

    // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — a plain detach of a run
    // that builds reports at once, so its port is the plan's, not the one a busy-port retry takes
    // later. A re-run once the lock says `serving` reports where the dev server is.
    it('reports a building run at once, and a re-run reports the port the retry took', async () => {
      const projectRoot = await setupFixtureAsync('bare-app');
      await installStubFingerprintAsync(projectRoot);
      const env = {
        ...servingEnv(projectRoot),
        RCT_METRO_PORT: '8473',
        STUB_EXPO_PORT_BUSY: '8473',
        STUB_EXPO_BUILD_DELAY_MS: '2000',
      };

      try {
        const first = await executeAgentCliAsync(
          projectRoot,
          ['dev', '--ios', '--local', '--detach', '--json'],
          { env, reject: false }
        );
        expect(first.exitCode, first.all).toBe(0);
        expect(JSON.parse(first.stdout)).toMatchObject({ phase: 'building', ready: null });

        const deadline = Date.now() + 20_000;
        let lock = await readDevLockAsync(projectRoot);
        while (lock?.phase !== 'serving' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          lock = await readDevLockAsync(projectRoot);
        }
        expect(lock).toMatchObject({ phase: 'serving' });

        const again = await executeAgentCliAsync(
          projectRoot,
          ['dev', '--ios', '--local', '--detach', '--json'],
          { env, reject: false }
        );
        expect(again.exitCode, again.all).toBe(0);
        const report = JSON.parse(again.stdout);
        expect(report).toMatchObject({ phase: 'serving', alreadyRunning: true, port: lock!.port });
        expect(report.port).not.toBe(8473);
      } finally {
        await cleanUpDetachedAsync(projectRoot);
      }
    });
  });

  it('reports no move when the dev server took the port it was asked for', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--detach', '--json'],
        { env: detachEnv(projectRoot, 8393) }
      );

      expect(JSON.parse(result.stdout)).toMatchObject({ port: 8393, portMoved: null });
    } finally {
      await cleanUpDetachedAsync(projectRoot);
    }
  });

  // The plan's rule: one detached dev server per project. A second one could not hold the lock, so
  // nothing would be able to find it or stop it — which is worse than a second foreground one.
  it('reports the running server and starts nothing on a second --detach', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    try {
      const first = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--detach', '--json'],
        {
          env: detachEnv(projectRoot, 8397),
        }
      );
      const firstPid = JSON.parse(first.stdout).pid;

      const second = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--detach', '--json'],
        { env: detachEnv(projectRoot, 8396) }
      );

      // Idempotent: exit 0, and the report is of the server that is there.
      expect(second.exitCode).toBe(0);
      expect(JSON.parse(second.stdout)).toMatchObject({
        alreadyRunning: true,
        pid: firstPid,
        port: 8397,
      });

      const human = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--detach'], {
        env: detachEnv(projectRoot, 8396),
      });
      expect(human.stdout).toContain('so nothing was started');
    } finally {
      await cleanUpDetachedAsync(projectRoot);
    }
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port
  // A second foreground server could not hold the lock, so `status` and `dev:stop` could not see it.
  it('stops a foreground dev, and lists no steps under --plan, while the server runs', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const port = await freePortAsync();

    try {
      const first = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--detach', '--wait-ready', '--json'],
        { env: { ...detachEnv(projectRoot, port), STUB_EXPO_LISTEN: '1' } }
      );
      const { pid } = JSON.parse(first.stdout);
      const lastRequest = path.join(projectRoot, '.expo', 'agent-cli-last-dev.json');
      const startedBy = fs.readFileSync(lastRequest, 'utf8');

      // Both platforms, so the check suggested is the caller's own; the second is not the one
      // that started the server, so a refused request that replaced the record would show.
      for (const platform of ['ios', 'android']) {
        const foreground = await executeAgentCliAsync(
          projectRoot,
          ['dev', `--${platform}`, '--json'],
          { env: stubExpoEnv(projectRoot), reject: false }
        );

        expect(foreground.exitCode, foreground.all).toBe(20);
        expect(JSON.parse(foreground.stdout).error).toMatchObject({
          code: 'DEV_SERVER_RUNNING',
          data: { port, pid, phase: 'serving' },
          suggestedCommand: `npx @expo/agent-cli smoke --${platform}`,
        });
      }
      const starts = readStubExpoInvocations(projectRoot).filter(({ args }) => args[0] === 'start');
      expect(starts).toHaveLength(1);
      // The recovery `status` reads is the request that started the running server.
      expect(fs.readFileSync(lastRequest, 'utf8')).toBe(startedBy);

      // Whatever the forwarded options make of the last step, the plan does none of them.
      const planned = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--plan', '--json', '--', '--no-bundler'],
        { env: stubExpoEnv(projectRoot) }
      );

      expect(planned.exitCode).toBe(0);
      const plan = JSON.parse(planned.stdout);
      expect(plan).toMatchObject({
        steps: [],
        devServerPort: { port, state: 'running', phase: 'serving' },
      });
      expect(plan.reasons).toContainEqual(
        `This project's dev server is already running on port ${port} (pid ${pid}); the run stops instead of starting a second one.`
      );
      expect(plan.followups.map((followup: { id: string }) => followup.id)).toEqual([
        'dev-server-running',
      ]);
    } finally {
      await cleanUpDetachedAsync(projectRoot);
    }
  });

  // The counterpart of the finding: `dev:stop` has to reach a process this shell never owned.
  it('is stopped by dev:stop, which takes the whole tree with it', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const started = await executeAgentCliAsync(
      projectRoot,
      ['dev', '--ios', '--detach', '--json'],
      {
        env: detachEnv(projectRoot, 8395),
      }
    );
    const { pid } = JSON.parse(started.stdout);

    const result = await executeAgentCliAsync(projectRoot, ['dev:stop', '--json'], {
      env: stubExpoEnv(projectRoot),
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      stopped: true,
      pid,
      port: 8395,
      lockHeld: true,
      signal: 'SIGTERM',
    });
    // The wrapper is gone, and so is the lock it held — the two halves of "no orphan".
    expect(await waitForAsync(() => !isAlive(pid), 5000)).toBe(true);
    expect(await readDevLockAsync(projectRoot)).toBeNull();
  });

  // @ref llp/0021-honest-reports.rfc.md §The rules
  //
  // Friction run 7's F61 and the 2026-08-26 live run's S4, which are one finding: the child had
  // already classified the stop, written the scenario and the what/why/how into its log, and
  // exited — while
  // the parent, the only process the caller is reading, printed `Bundler ready` and exit 0. The
  // verdict was never missing. It was in the wrong process.
  it('hands on the child’s own verdict instead of reporting a dev server that has gone', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        // `--tunnel`, because that is the wait the child died inside of: the parent is still
        // waiting for a tunnel host when the process that would print one exits.
        ['dev', '--ios', '--detach', '--tunnel', '--json'],
        {
          env: {
            ...stubExpoEnv(projectRoot),
            STUB_EXPO_DEV_SERVER_PORT: '8397',
            // Long enough for the lock to be published and read, short enough that the death
            // lands inside the parent's tunnel wait rather than after it.
            STUB_EXPO_DELAY_MS: '2500',
            STUB_EXPO_EXIT_CODE: '1',
            STUB_EXPO_STDERR: "Input is required, but 'npx expo' is in non-interactive mode.",
          },
          reject: false,
        }
      );

      // 7, not 0 and not 1: the CLI worked, and what is left is a step only a person can finish.
      expect(result.exitCode).toBe(7);
      const { error } = JSON.parse(result.stdout);
      expect(error.needsHuman).toMatchObject({
        scenario: 'expo-prompt',
        // Relayed rather than seen: this parent never ran the Expo CLI.
        detectedBy: 'detached-child-log',
      });
      // The two words the finding is about, on neither stream.
      expect(result.stdout).not.toContain('"ready": true');
      expect(result.all).not.toContain('Bundler      ready');
    } finally {
      await cleanUpDetachedAsync(projectRoot);
    }
  });

  // @ref llp/0021-honest-reports.rfc.md §The rules — **F140**, the hole the
  // section above left open and this wave closes.
  //
  // The acceptance walk ran `dev --detach --wait-ready --ios` and was told `Bundler ready`, exit 0,
  // for a dev server that was already on its way out — three times in a row, and then honestly on a
  // fourth identical run, because it is a race. Both halves of it are true at once: the bundler
  // *did* answer, and `expo start --ios` was *about* to be refused permission to drive
  // Simulator.app. The rejection is an un-awaited promise inside the same process, so it lands after
  // the dev server is up and after every check the parent makes [measured 215–263ms later].
  //
  // The stub reproduces exactly that ordering without a simulator, an AppleScript or a race: it
  // binds the port, answers `/status` — which is the readiness probe itself — and dies a fixed time
  // after that answer.
  //
  // The step under test is `expo run:ios` now (`bare-app`'s one-step plan): a plain `expo start`
  // cannot die of the Automation refusal any more, because `dev` keeps the platform flag away from
  // it and opens the app itself (llp/0026). `run:*` still launches through AppleScript, so it is
  // the step the grace window still exists for.
  describe('a dev server that dies just after its bundler answered', () => {
    /** Environment for a stub that comes up, answers `/status`, and then dies the way a launch does. */
    function diesAfterReadyEnv(projectRoot: string, port: number): Record<string, string> {
      return {
        ...stubExpoEnv(projectRoot),
        STUB_EXPO_DEV_SERVER_PORT: String(port),
        STUB_EXPO_LISTEN: '1',
        STUB_EXPO_DELAY_MS: STUB_ALIVE_MS,
        // Comfortably inside the grace window, and after the readiness claim rather than racing it:
        // the answer that starts this clock is the claim.
        STUB_EXPO_DIE_AFTER_STATUS_MS: '400',
      };
    }

    it('refuses to report ready for a child that is about to be gone', async () => {
      const projectRoot = await setupFixtureAsync('bare-app');
      await installStubFingerprintAsync(projectRoot);

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['dev', '--detach', '--wait-ready', '--ios', '--local', '--json'],
          { env: diesAfterReadyEnv(projectRoot, 8393), reject: false }
        );

        // 7, not 0: the CLI worked, and the macOS Automation grant the stub's stderr names is a
        // step only a person can complete. The child classified it and this parent relayed it.
        expect(
          result.exitCode,
          `${result.all}\nDetached child log:\n${await fs.promises
            .readFile(path.join(projectRoot, DETACHED_LOG_PATH), 'utf8')
            .catch(() => '(unavailable)')}`
        ).toBe(7);
        const { error } = JSON.parse(result.stdout);
        expect(error.needsHuman).toMatchObject({
          scenario: 'macos-automation',
          detectedBy: 'detached-child-log',
        });
        // The two words the finding is about, on neither stream.
        expect(result.stdout).not.toContain('"ready": true');
        expect(result.all).not.toContain('Bundler      ready');
      } finally {
        await cleanUpDetachedAsync(projectRoot);
      }
    });

    // The other half, and the one that keeps the grace honest: a `--ios` run whose dev server stays
    // up still reports ready and still exits 0. A check that failed both would only have moved the
    // dishonesty to the other side.
    it('still reports ready for a child that stays up', async () => {
      const projectRoot = await setupFixtureAsync('go-app');

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['dev', '--detach', '--wait-ready', '--ios', '--json'],
          {
            env: {
              ...diesAfterReadyEnv(projectRoot, 8392),
              STUB_EXPO_DIE_AFTER_STATUS_MS: '0',
            },
          }
        );

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          port: 8392,
          ready: true,
          phase: 'serving',
        });
      } finally {
        await cleanUpDetachedAsync(projectRoot);
      }
    });
  });

  it('rejects --wait-ready on its own, which would wait for nothing', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    const result = await executeAgentCliAsync(projectRoot, ['dev', '--wait-ready', '--json'], {
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.message).toContain('only means something with --detach');
  });

  it('says in --help that the plain command blocks and --detach does not', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    const result = await executeAgentCliAsync(projectRoot, ['dev:run', '--help']);

    expect(result.all).toContain('This command blocks');
    expect(result.all).toContain('--detach');
  });
});
