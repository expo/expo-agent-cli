import { isDevServerLockHeldAsync, readDevServerLockAsync } from '../../devLock';
import { EXIT_OK, EXIT_OUTCOME_FAILED } from '../../exitCodes';
import { discoverDevServerAsync } from '../../runtime/devServer';
import { probeBundlerAsync } from '../../runtime/bundlerStatus';
import { findPortListenerAsync, isPortInUseAsync } from '../portListener';
import type { DevStopOptions } from '../resolveStopOptions';
import { PROGRAM_PREFIX } from '../../programName';
import {
  buildFollowUps,
  devStopAsync,
  looksLikeDevServerProcess,
  type DevStopResultJson,
} from '../stopAsync';
import type { MockInstance } from 'vitest';
import { vol } from 'memfs';
import { cloudProbe } from '../../device/__tests__/fakeCloudProbe';
import { readCloudBindings } from '../../deviceBinding/cloud';
import { bindingPathFor } from '../../deviceBinding/registry';
import { writeCloudBinding } from '../../deviceBinding/__tests__/fakeCloudBinding';
import { lockInfo } from '../../devLock/__tests__/fakeLock';
import type { DevServerLockInfo } from '../../devLock/types';

vi.mock('../../devLock', () => {
  const readDevServerLockAsync = vi.fn(async (_projectRoot: string): Promise<unknown> => null);
  return {
    readDevServerLockAsync,
    // Held when the mocked read answers, so a test sets one answer for both.
    isDevServerLockHeldAsync: vi.fn(
      async (projectRoot: string) => (await readDevServerLockAsync(projectRoot)) != null
    ),
  };
});
vi.mock('../../runtime/devServer', async (importActual) => ({
  ...(await importActual<typeof import('../../runtime/devServer')>()),
  discoverDevServerAsync: vi.fn(),
}));
vi.mock('../../runtime/bundlerStatus', () => ({
  probeBundlerAsync: vi.fn(),
}));
vi.mock('../portListener', () => ({
  findPortListenerAsync: vi.fn(async () => null),
  isPortInUseAsync: vi.fn(async () => false),
}));

const projectRoot = '/project';
const realPlatform = process.platform;

function mockPlatform(value: typeof process.platform) {
  Object.defineProperty(process, 'platform', { value });
}

function lock(overrides: Partial<DevServerLockInfo> = {}) {
  return lockInfo(overrides);
}

function options(overrides: Partial<DevStopOptions> = {}): DevStopOptions {
  return {
    eas: false,
    port: null,
    signal: 'SIGTERM',
    force: false,
    timeoutMs: 300,
    json: true,
    followups: false,
    ...overrides,
  };
}

/** Answer `/status` as an Expo dev server, or refuse the connection. */
function mockPort({ answering }: { answering: boolean }) {
  globalThis.fetch = (async () => {
    if (!answering) {
      throw new Error('connect ECONNREFUSED');
    }
    return { ok: true, text: async () => 'packager-status:running' };
  }) as unknown as typeof fetch;
}

function printed(): string {
  return vi.mocked(console.log).mock.calls.flat().join('\n');
}

/** What reached stderr: the what / why / how of a refusal, which is where the guard is named. */
function printedErrors(): string {
  return vi.mocked(console.error).mock.calls.flat().join('\n');
}

/** What `status` reads as `projectRootMatched` for a dev server that answers. */
function projectRootMatch(projectRootMatched: boolean | null) {
  return { answering: true, projectRootMatched, reportedProjectRoot: null };
}

let originalFetch: typeof fetch | undefined;
let killed: { pid: number; signal: string }[] = [];
let killSpy: MockInstance;

/**
 * Processes that exist on this fake machine.
 *
 * Empty by default, so a pid nothing added is a pid that is gone — which is the state after a
 * signal that worked, and the state the ordinary stop is asserted against. A test that needs a
 * process to survive its signal puts the pid in here and clears {@link signalKills}.
 */
let livePids = new Set<number>();

/** Whether a signal ends the process it is delivered to. */
let signalKills = true;

beforeEach(() => {
  vi.mocked(isDevServerLockHeldAsync).mockImplementation(
    async (root) => (await readDevServerLockAsync(root)) != null
  );
  vi.mocked(discoverDevServerAsync).mockResolvedValue({
    reachable: false,
    targets: [],
    devServerUrl: 'http://127.0.0.1:8081',
    source: 'default',
    discovered: false,
  });
  vi.mocked(probeBundlerAsync).mockResolvedValue(projectRootMatch(null));
  mockPlatform('darwin');
  originalFetch = globalThis.fetch;
  killed = [];
  livePids = new Set();
  signalKills = true;
  killSpy = vi.spyOn(process, 'kill').mockImplementation(((
    pid: number,
    signal: string | number
  ) => {
    // Signal 0 is the existence check `isProcessAlive` uses, and delivers nothing.
    if (signal === 0) {
      if (!livePids.has(pid)) {
        const error: NodeJS.ErrnoException = new Error('kill ESRCH');
        error.code = 'ESRCH';
        throw error;
      }
      return true;
    }
    killed.push({ pid, signal: String(signal) });
    if (signalKills) {
      livePids.delete(pid);
    }
    return true;
  }) as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  mockPlatform(realPlatform);
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
  killSpy.mockRestore();
});

describe(devStopAsync, () => {
  describe('observations when no stop is authorized', () => {
    beforeEach(() => {
      vi.mocked(readDevServerLockAsync).mockResolvedValue(null);
      vi.mocked(findPortListenerAsync).mockResolvedValue(null);
      vi.mocked(isPortInUseAsync).mockResolvedValue(false);
      mockPort({ answering: false });
    });

    it.each([false, true])(
      'reports a live foreign process without signalling it (force=%s)',
      async (force) => {
        vi.mocked(findPortListenerAsync).mockResolvedValue({ pid: 777, command: 'nginx' });
        livePids.add(777);
        mockPort({ answering: true });

        await expect(devStopAsync(projectRoot, options({ port: 8195, force }))).resolves.toBe(
          EXIT_OUTCOME_FAILED
        );

        expect(JSON.parse(printed())).toMatchObject({
          stopped: false,
          signal: null,
          pid: 777,
          processStillRunning: true,
          portStillAnswering: true,
        });
        expect(JSON.parse(printed()).detail).not.toContain('was not started by this CLI');
        expect(killed).toEqual([]);
      }
    );

    it('does not invent a process state for an unnamed busy port', async () => {
      vi.mocked(isPortInUseAsync).mockResolvedValue(true);
      await devStopAsync(projectRoot, options({ port: 8195 }));
      expect(JSON.parse(printed())).toMatchObject({
        processStillRunning: null,
        portStillAnswering: true,
      });
      expect(killed).toEqual([]);
    });

    it('reports unknown state when no port or lock identifies a target', async () => {
      await devStopAsync(projectRoot, options());
      expect(JSON.parse(printed())).toMatchObject({
        processStillRunning: null,
        portStillAnswering: null,
      });
      expect(JSON.parse(printed()).detail).not.toContain(
        'no dev server started by this CLI is running'
      );
    });

    it('reports a measured free port as quiet', async () => {
      await devStopAsync(projectRoot, options({ port: 8195 }));
      expect(JSON.parse(printed())).toMatchObject({
        processStillRunning: false,
        portStillAnswering: false,
      });
    });
  });
  // The ordinary path. The lock names the pid, and signalling that pid is enough for the whole
  // tree because both spawn paths forward terminal signals to the `expo start` child.
  it(`should signal the pid the lock names, and report it stopped`, async () => {
    vi.mocked(readDevServerLockAsync)
      .mockResolvedValueOnce(lock() as never)
      .mockResolvedValue(null as never);
    mockPort({ answering: false });

    await expect(devStopAsync(projectRoot, options())).resolves.toBe(EXIT_OK);
    expect(killed).toEqual([{ pid: 4242, signal: 'SIGTERM' }]);
    expect(JSON.parse(printed())).toMatchObject({
      stopped: true,
      pid: 4242,
      port: 8081,
      url: 'http://127.0.0.1:8081',
      lockHeld: true,
      signal: 'SIGTERM',
      forced: false,
      reason: null,
      detail: null,
    });
  });

  it(`should print a stable set of top-level keys with --json`, async () => {
    vi.mocked(readDevServerLockAsync)
      .mockResolvedValueOnce(lock() as never)
      .mockResolvedValue(null as never);
    mockPort({ answering: false });

    await devStopAsync(projectRoot, options());

    expect(Object.keys(JSON.parse(printed())).sort()).toEqual([
      'detail',
      'deviceError',
      'devices',
      'easPlatform',
      'followups',
      'forceRefusedBy',
      'forced',
      'lockHeld',
      'pid',
      'port',
      'portStillAnswering',
      'processStillRunning',
      'reaped',
      'reason',
      'signal',
      'stopped',
      'untracked',
      'url',
      'waitedMs',
    ]);
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — friction run 5,
  // F48-10. The pid answers "did my signal work"; the port answers "is that number in use", and
  // only the first is what this command was asked about.
  describe('the pid is the evidence, and the port is not', () => {
    it(`should keep waiting while the process it signalled is still running`, async () => {
      vi.mocked(readDevServerLockAsync)
        .mockResolvedValueOnce(lock() as never)
        .mockResolvedValue(null as never);
      mockPort({ answering: true });
      livePids.add(4242);
      signalKills = false;

      await expect(devStopAsync(projectRoot, options({ timeoutMs: 200 }))).resolves.toBe(
        EXIT_OUTCOME_FAILED
      );
      expect(JSON.parse(printed())).toMatchObject({
        stopped: false,
        reason: 'still-running',
        processStillRunning: true,
      });
      expect(printedErrors()).toContain('SIGKILL');
    });

    // The split-stack case, and every other "something else has that port number" case with it:
    // the checks here are over 127.0.0.1, so a dev server on ::1 and a stranger on 127.0.0.1 share
    // a port and neither sees the other. This used to be exit 20 about a process already gone.
    it(`should report it stopped when the process is gone and the port still answers`, async () => {
      vi.mocked(readDevServerLockAsync)
        .mockResolvedValueOnce(lock() as never)
        .mockResolvedValue(null as never);
      mockPort({ answering: true });

      await expect(devStopAsync(projectRoot, options({ timeoutMs: 200 }))).resolves.toBe(EXIT_OK);
      expect(JSON.parse(printed())).toMatchObject({
        stopped: true,
        processStillRunning: false,
        portStillAnswering: true,
        reason: null,
      });
    });

    it(`should say whose listener the port is not, rather than leaving the contradiction`, async () => {
      vi.mocked(readDevServerLockAsync)
        .mockResolvedValueOnce(lock() as never)
        .mockResolvedValue(null as never);
      mockPort({ answering: true });

      await devStopAsync(projectRoot, options({ timeoutMs: 200, json: false, followups: true }));

      expect(printed()).toContain('still answering, by something else');
      expect(printed()).toContain('::1');
      // The rung comes first, because it is what settles which listener that is.
      expect(printed()).toContain('npx @expo/agent-cli dev:stop --port 8081');
    });

    // The other half of "the pid is primary": the signal worked, and what did not go away is the
    // project's own lock. `--signal SIGKILL` has nothing left to signal, so it must not be offered.
    it(`should not offer SIGKILL when the pid is gone and the lock still answers`, async () => {
      vi.mocked(readDevServerLockAsync).mockResolvedValue(lock() as never);
      mockPort({ answering: false });

      await expect(devStopAsync(projectRoot, options({ timeoutMs: 200 }))).resolves.toBe(
        EXIT_OUTCOME_FAILED
      );
      expect(JSON.parse(printed())).toMatchObject({
        stopped: false,
        reason: 'still-running',
        processStillRunning: false,
      });
      // Named to be ruled out, never offered: the recovery is the other dev server.
      expect(printedErrors()).toContain('SIGKILL has nothing left to signal');
      expect(printedErrors()).not.toContain('which the process cannot decline');
      expect(printedErrors()).toContain('npx @expo/agent-cli status --json');
    });

    it(`should report a live pid as still running when it released its lock and the port is free`, async () => {
      vi.mocked(readDevServerLockAsync)
        .mockResolvedValueOnce(lock() as never)
        .mockResolvedValue(null as never);
      mockPort({ answering: false });
      livePids.add(4242);
      signalKills = false;

      await expect(
        devStopAsync(projectRoot, options({ timeoutMs: 200, followups: true }))
      ).resolves.toBe(EXIT_OUTCOME_FAILED);
      const report = JSON.parse(printed());
      expect(report).toMatchObject({
        stopped: false,
        processStillRunning: true,
        reason: 'still-running',
        easPlatform: null,
      });
      expect(report.followups).toEqual([]);
      expect(printedErrors()).toContain('SIGKILL');
    });

    it(`should not call a silent lock holder or a slow /status a finished dev --eas run`, async () => {
      vi.mocked(readDevServerLockAsync)
        .mockResolvedValueOnce(lock({ easPlatform: 'ios' }) as never)
        .mockResolvedValue(null as never);
      vi.mocked(isDevServerLockHeldAsync).mockResolvedValue(true);
      globalThis.fetch = (async () => {
        throw new DOMException('timed out', 'TimeoutError');
      }) as unknown as typeof fetch;
      livePids.add(4242);
      signalKills = false;

      await expect(devStopAsync(projectRoot, options({ timeoutMs: 2_500 }))).resolves.toBe(
        EXIT_OUTCOME_FAILED
      );
      expect(JSON.parse(printed())).toMatchObject({ stopped: false, reason: 'still-running' });
    });

    it(`should not call a slow /status a free port for a finishing dev --eas run`, async () => {
      vi.mocked(readDevServerLockAsync)
        .mockResolvedValueOnce(lock({ easPlatform: 'ios' }) as never)
        .mockResolvedValue(null as never);
      globalThis.fetch = (async () => {
        throw new DOMException('timed out', 'TimeoutError');
      }) as unknown as typeof fetch;
      livePids.add(4242);
      signalKills = false;

      await expect(devStopAsync(projectRoot, options({ timeoutMs: 2_500 }))).resolves.toBe(
        EXIT_OUTCOME_FAILED
      );
      expect(JSON.parse(printed())).toMatchObject({ stopped: false });
    });

    describe('the finishing grace period', () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
        vi.mocked(readDevServerLockAsync)
          .mockResolvedValueOnce(lock({ easPlatform: 'ios' }) as never)
          .mockResolvedValue(null as never);
        mockPort({ answering: false });
        livePids.add(4242);
        signalKills = false;
      });
      afterEach(() => vi.useRealTimers());

      it(`should end the wait of a finishing dev --eas run after the grace period, not the timeout`, async () => {
        const code = devStopAsync(projectRoot, options({ timeoutMs: 60_000 }));
        await vi.advanceTimersByTimeAsync(3_000);

        await expect(code).resolves.toBe(EXIT_OK);
        const report = JSON.parse(printed());
        expect(report).toMatchObject({ stopped: true, processStillRunning: true });
        expect(report.waitedMs).toBeGreaterThanOrEqual(2_000);
        expect(report.waitedMs).toBeLessThan(3_000);
      });

      it(`should report a dev --eas process that exits inside the grace period as gone`, async () => {
        setTimeout(() => livePids.delete(4242), 500);
        const code = devStopAsync(projectRoot, options({ timeoutMs: 60_000 }));
        await vi.advanceTimersByTimeAsync(3_000);

        await expect(code).resolves.toBe(EXIT_OK);
        const report = JSON.parse(printed());
        expect(report).toMatchObject({ stopped: true, processStillRunning: false });
        expect(report.waitedMs).toBeLessThan(2_000);
      });
    });

    it(`should keep the run's EAS platform and --eas on the next dev while the process finishes`, async () => {
      vi.mocked(readDevServerLockAsync)
        .mockResolvedValueOnce(lock({ easPlatform: 'android' }) as never)
        .mockResolvedValue(null as never);
      mockPort({ answering: false });
      livePids.add(4242);
      signalKills = false;

      await expect(
        devStopAsync(projectRoot, options({ timeoutMs: 200, followups: true }))
      ).resolves.toBe(EXIT_OK);

      const report = JSON.parse(printed());
      expect(report).toMatchObject({ stopped: true, processStillRunning: true });
      expect(report.easPlatform).toBe('android');
      expect(report.followups.map((f: { id: string }) => f.id)).toEqual(['stop-session', 'dev']);
      expect(report.followups[1].command).toBe(`${PROGRAM_PREFIX} dev --android --eas`);
    });

    it(`should say the stopped dev --eas run's process is finishing its exit work`, async () => {
      vi.mocked(readDevServerLockAsync)
        .mockResolvedValueOnce(lock({ easPlatform: 'ios' }) as never)
        .mockResolvedValue(null as never);
      mockPort({ answering: false });
      livePids.add(4242);
      signalKills = false;

      await devStopAsync(projectRoot, options({ timeoutMs: 200, json: false, followups: true }));

      expect(printed()).toContain('finishing its exit work');
      expect(printed()).not.toContain('SIGKILL');
    });
  });

  // @ref llp/0010-agent-conventions.rfc.md §Exit codes. The end state the caller asked for is the
  // state it is already in, so a second `dev:stop` must not read as a failure.
  it(`should exit 0 when nothing was running`, async () => {
    vi.mocked(readDevServerLockAsync).mockResolvedValue(null as never);

    await expect(devStopAsync(projectRoot, options())).resolves.toBe(EXIT_OK);
    expect(JSON.parse(printed())).toMatchObject({
      stopped: false,
      pid: null,
      lockHeld: false,
      reason: 'not-running',
    });
    expect(killed).toEqual([]);
  });

  it(`should say to pass --port when there is no lock and no port to look at`, async () => {
    vi.mocked(readDevServerLockAsync).mockResolvedValue(null as never);

    await devStopAsync(projectRoot, options());

    expect(JSON.parse(printed()).detail).toContain('--port');
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — a dev child killed with
  // SIGKILL leaves Metro running with no lock. `status` finds it by the scan and matches its project
  // root; dev:stop finds it the same way and stops it.
  describe('no lock, and the scan finds a dev server', () => {
    beforeEach(() => {
      vi.mocked(readDevServerLockAsync).mockResolvedValue(null as never);
      vi.mocked(discoverDevServerAsync).mockResolvedValue({
        reachable: true,
        targets: [],
        devServerUrl: 'http://127.0.0.1:8082',
        source: 'scan',
        discovered: true,
      });
      vi.mocked(findPortListenerAsync).mockResolvedValue({ pid: 9191, command: 'node' });
      livePids.add(9191);
      mockPort({ answering: true });
    });

    it(`should stop it without --force when status matches it to this project`, async () => {
      vi.mocked(probeBundlerAsync).mockResolvedValue(projectRootMatch(true));

      await expect(devStopAsync(projectRoot, options())).resolves.toBe(EXIT_OK);

      expect(probeBundlerAsync).toHaveBeenCalledWith(
        'http://127.0.0.1:8082',
        expect.objectContaining({ projectRoot })
      );
      expect(killed).toEqual([{ pid: 9191, signal: 'SIGTERM' }]);
      expect(JSON.parse(printed())).toMatchObject({
        stopped: true,
        untracked: true,
        forced: false,
        port: 8082,
        pid: 9191,
        lockHeld: false,
        reason: null,
      });
    });

    it(`should say the stopped server had no lock`, async () => {
      vi.mocked(probeBundlerAsync).mockResolvedValue(projectRootMatch(true));

      await devStopAsync(projectRoot, options({ json: false }));

      expect(printed()).toContain("This project's dev server had no lock: its CLI process ended.");
    });

    it(`should name it and signal nothing when this machine will not name its process`, async () => {
      vi.mocked(probeBundlerAsync).mockResolvedValue(projectRootMatch(true));
      vi.mocked(findPortListenerAsync).mockResolvedValue(null);

      await expect(devStopAsync(projectRoot, options())).resolves.toBe(EXIT_OUTCOME_FAILED);

      expect(killed).toEqual([]);
      const report = JSON.parse(printed());
      expect(report).toMatchObject({
        stopped: false,
        untracked: true,
        port: 8082,
        reason: 'untracked-dev-server',
      });
      expect(report.detail).toContain('its CLI process ended');
    });

    // A foreground `dev --port 8095` writes no log; `status` finds it by the last request's port.
    it(`should look at the port of the last dev request first, as status does`, async () => {
      vol.fromJSON({
        [`${projectRoot}/.expo/agent-cli-last-dev.json`]: JSON.stringify({
          version: 1,
          platform: 'web',
          port: 8095,
          buildBackend: null,
          runTarget: null,
        }),
      });
      vi.mocked(discoverDevServerAsync).mockImplementation(async (url) =>
        url === 'http://127.0.0.1:8095'
          ? { reachable: true, targets: [], devServerUrl: url, source: 'flag', discovered: false }
          : {
              reachable: false,
              targets: [],
              devServerUrl: '',
              source: 'default',
              discovered: false,
            }
      );
      vi.mocked(probeBundlerAsync).mockImplementation(async (url) =>
        projectRootMatch(url === 'http://127.0.0.1:8095' ? true : null)
      );

      await expect(devStopAsync(projectRoot, options())).resolves.toBe(EXIT_OK);

      expect(JSON.parse(printed())).toMatchObject({ stopped: true, untracked: true, port: 8095 });
    });

    it.each([
      ['names another project', false],
      ['names no project', null],
    ] as const)(`should name nothing when its /status %s`, async (_, matched) => {
      vi.mocked(probeBundlerAsync).mockResolvedValue(projectRootMatch(matched));

      await expect(devStopAsync(projectRoot, options())).resolves.toBe(EXIT_OK);

      expect(killed).toEqual([]);
      const report = JSON.parse(printed());
      expect(report).toMatchObject({ port: null, pid: null, untracked: false });
      expect(report.detail).toContain('--port');
    });
  });

  // The same proof when the caller names the port: a dev server status matches to this project
  // stops without --force, and another project's still needs it.
  describe('--port with no lock', () => {
    beforeEach(() => {
      vi.mocked(readDevServerLockAsync).mockResolvedValue(null as never);
      vi.mocked(findPortListenerAsync).mockResolvedValue({ pid: 9191, command: 'node' });
      livePids.add(9191);
      mockPort({ answering: true });
    });

    it(`should stop this project's dev server without --force`, async () => {
      vi.mocked(probeBundlerAsync).mockResolvedValue(projectRootMatch(true));

      await expect(devStopAsync(projectRoot, options({ port: 8081 }))).resolves.toBe(EXIT_OK);

      expect(killed).toEqual([{ pid: 9191, signal: 'SIGTERM' }]);
      expect(JSON.parse(printed())).toMatchObject({ stopped: true, untracked: true, port: 8081 });
    });

    it(`should still refuse another project's dev server without --force`, async () => {
      vi.mocked(probeBundlerAsync).mockResolvedValue(projectRootMatch(false));

      await expect(devStopAsync(projectRoot, options({ port: 8081 }))).resolves.toBe(
        EXIT_OUTCOME_FAILED
      );

      expect(killed).toEqual([]);
      expect(JSON.parse(printed())).toMatchObject({
        stopped: false,
        untracked: false,
        reason: 'foreign-dev-server',
      });
    });
  });

  // @ref llp/0021-honest-reports.rfc.md §How they show up — friction run 7,
  // F60. The one destructive verb in the surface acted on a port the caller did not name.
  describe('--port names the target, and the lock does not overrule it', () => {
    beforeEach(() => {
      vi.mocked(readDevServerLockAsync).mockResolvedValue(
        lock({ port: 8190, url: 'http://127.0.0.1:8190', pid: 4242 }) as never
      );
      livePids.add(4242);
    });

    it(`should not signal the lock's pid when --port names another port`, async () => {
      mockPort({ answering: false });
      vi.mocked(findPortListenerAsync).mockResolvedValue({ pid: 777, command: 'python3' });

      await expect(devStopAsync(projectRoot, options({ port: 8195 }))).resolves.toBe(
        EXIT_OUTCOME_FAILED
      );

      expect(killed).toEqual([]);
      const report = JSON.parse(printed());
      expect(report).toMatchObject({
        stopped: false,
        port: 8195,
        pid: 777,
        lockHeld: false,
        reason: 'foreign-dev-server',
      });
      // The lock is named so the caller can tell the two dev servers apart, and never acted on.
      expect(report.detail).toContain('8190');
    });

    it(`should signal the lock's pid when --port names the port the lock holds`, async () => {
      vi.mocked(readDevServerLockAsync)
        .mockResolvedValueOnce(lock({ port: 8190, url: 'http://127.0.0.1:8190' }) as never)
        .mockResolvedValue(null as never);
      mockPort({ answering: false });

      await expect(devStopAsync(projectRoot, options({ port: 8190 }))).resolves.toBe(EXIT_OK);

      expect(killed).toEqual([{ pid: 4242, signal: 'SIGTERM' }]);
      expect(JSON.parse(printed())).toMatchObject({
        stopped: true,
        port: 8190,
        lockHeld: true,
      });
    });
  });

  // @ref llp/0021-honest-reports.rfc.md §How they show up — friction run 7,
  // F72. "Nothing is listening" is a claim, and it was made about a port something was on.
  describe('a port this machine will not name a listener for', () => {
    beforeEach(() => {
      vi.mocked(readDevServerLockAsync).mockResolvedValue(null as never);
      vi.mocked(findPortListenerAsync).mockResolvedValue(null);
      mockPort({ answering: false });
    });

    it(`should report it as a foreign listener when the port cannot be bound`, async () => {
      vi.mocked(isPortInUseAsync).mockResolvedValue(true);

      await expect(devStopAsync(projectRoot, options({ port: 8195 }))).resolves.toBe(
        EXIT_OUTCOME_FAILED
      );

      const report = JSON.parse(printed());
      expect(report).toMatchObject({ stopped: false, reason: 'foreign-dev-server' });
      expect(report.detail).toContain('no Expo dev server answered on port 8195');
      expect(report.detail).not.toContain('nothing is listening');
    });

    it(`should report nothing running only when the port is free`, async () => {
      vi.mocked(isPortInUseAsync).mockResolvedValue(false);

      await expect(devStopAsync(projectRoot, options({ port: 8195 }))).resolves.toBe(EXIT_OK);

      const report = JSON.parse(printed());
      expect(report).toMatchObject({ stopped: false, reason: 'not-running' });
      expect(report.detail).toContain('nothing is listening on port 8195');
    });

    it(`should name the listener's pid rather than claiming the port is quiet`, async () => {
      vi.mocked(findPortListenerAsync).mockResolvedValue({ pid: 63465, command: 'python3' });

      await expect(devStopAsync(projectRoot, options({ port: 8195 }))).resolves.toBe(
        EXIT_OUTCOME_FAILED
      );

      const report = JSON.parse(printed());
      expect(report.detail).toContain('pid 63465 (python3) is listening and is not one');
    });
  });

  describe('a dev server this CLI did not start', () => {
    beforeEach(() => {
      vi.mocked(readDevServerLockAsync).mockResolvedValue(null as never);
      mockPort({ answering: true });
      vi.mocked(findPortListenerAsync).mockResolvedValue({ pid: 777, command: 'node' });
    });

    // The one thing this command must not do by accident: kill a listener nobody asked about. A
    // second project's dev server on the port is the ordinary case.
    it(`should report it and leave it running`, async () => {
      await expect(devStopAsync(projectRoot, options({ port: 8081 }))).resolves.toBe(
        EXIT_OUTCOME_FAILED
      );
      expect(killed).toEqual([]);
      const report = JSON.parse(printed());
      expect(report).toMatchObject({
        stopped: false,
        pid: 777,
        lockHeld: false,
        reason: 'foreign-dev-server',
      });
      expect(report.detail).toContain('777');
    });

    it(`should stop it with --force, when both proofs agree`, async () => {
      let statusCalls = 0;
      globalThis.fetch = (async () => {
        // Answering while the proof is taken, gone once the signal has landed.
        if (statusCalls++ < 2) {
          return { ok: true, text: async () => 'packager-status:running' };
        }
        throw new Error('connect ECONNREFUSED');
      }) as unknown as typeof fetch;

      await expect(devStopAsync(projectRoot, options({ port: 8081, force: true }))).resolves.toBe(
        EXIT_OK
      );
      expect(killed).toEqual([{ pid: 777, signal: 'SIGTERM' }]);
      expect(JSON.parse(printed())).toMatchObject({ stopped: true, forced: true, reason: null });
    });

    // Both proofs, or nothing is killed: a `/status` answer says a dev server is there but not
    // which pid owns it, and a pid lookup can race a port closed and reopened between the reads.
    it(`should refuse --force when the process does not look like a dev server`, async () => {
      vi.mocked(findPortListenerAsync).mockResolvedValue({ pid: 777, command: 'nginx' });

      await expect(devStopAsync(projectRoot, options({ port: 8081, force: true }))).resolves.toBe(
        EXIT_OUTCOME_FAILED
      );
      expect(killed).toEqual([]);
    });

    it(`should refuse --force when the port does not answer as a dev server`, async () => {
      globalThis.fetch = (async () => ({
        ok: true,
        text: async () => '<!DOCTYPE html>',
      })) as unknown as typeof fetch;

      await expect(devStopAsync(projectRoot, options({ port: 8081, force: true }))).resolves.toBe(
        EXIT_OUTCOME_FAILED
      );
      expect(killed).toEqual([]);
    });

    it(`should refuse --force when the machine will not name the process`, async () => {
      vi.mocked(findPortListenerAsync).mockResolvedValue(null);

      await expect(devStopAsync(projectRoot, options({ port: 8081, force: true }))).resolves.toBe(
        EXIT_OUTCOME_FAILED
      );
      expect(killed).toEqual([]);
      expect(JSON.parse(printed()).detail).toContain('would not name');
    });

    // @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port — friction run 5,
    // F48-1. A refusal that answers "run it again with --force" to a caller who passed --force is
    // a next action that cannot work, and it hides the only thing worth knowing: which of the two
    // proofs did not hold.
    describe('a refused --force', () => {
      it(`should report which proof failed when the process is not a dev server's`, async () => {
        vi.mocked(findPortListenerAsync).mockResolvedValue({ pid: 777, command: 'nginx' });

        await devStopAsync(projectRoot, options({ port: 8081, force: true }));

        expect(JSON.parse(printed()).forceRefusedBy).toBe('foreign-process');
        expect(printedErrors()).toContain('nginx');
        expect(printedErrors()).not.toContain('again with --force');
      });

      it(`should report which proof failed when the port is not a dev server`, async () => {
        globalThis.fetch = (async () => ({
          ok: true,
          text: async () => '<!DOCTYPE html>',
        })) as unknown as typeof fetch;

        await devStopAsync(projectRoot, options({ port: 8081, force: true }));

        expect(JSON.parse(printed()).forceRefusedBy).toBe('not-a-dev-server');
        expect(printedErrors()).toContain('packager-status:running');
        expect(printedErrors()).not.toContain('again with --force');
      });

      it(`should report which proof failed when the machine names no process`, async () => {
        vi.mocked(findPortListenerAsync).mockResolvedValue(null);

        await devStopAsync(projectRoot, options({ port: 8081, force: true }));

        expect(JSON.parse(printed()).forceRefusedBy).toBe('unnamed-process');
        expect(printedErrors()).not.toContain('again with --force');
      });

      // Null when the flag was not passed: the field says which proof `--force` failed on, and
      // there is no such proof to report for a run that never asked for one.
      it(`should be null when --force was not passed`, async () => {
        await devStopAsync(projectRoot, options({ port: 8081 }));

        expect(JSON.parse(printed()).forceRefusedBy).toBeNull();
        expect(printedErrors()).toContain('--force');
      });
    });
  });
});

describe(looksLikeDevServerProcess, () => {
  it.each(['node', '/usr/local/bin/node', 'expo', 'metro', 'bun'])(
    `should recognize %s`,
    (command) => {
      expect(looksLikeDevServerProcess({ pid: 1, command })).toBe(true);
    }
  );

  it.each(['nginx', 'Docker', 'python3', ''])(`should not recognize %s`, (command) => {
    expect(looksLikeDevServerProcess({ pid: 1, command })).toBe(false);
  });
});

// @ref llp/0027-everything-on-eas.rfc.md §dev:stop
describe('dev:stop --eas', () => {
  const cloud = () =>
    require('../../device/cloudSimulator') as typeof import('../../device/cloudSimulator');
  const eas = () => require('../../device/eas') as typeof import('../../device/eas');

  beforeEach(() => {
    vi.spyOn(cloud(), 'probeCloudSessionAsync');
    vi.spyOn(eas(), 'stopEasSessionAsync');
  });

  it(`ends the session in progress by id, and says so beside the dev server`, async () => {
    vi.mocked(cloud().probeCloudSessionAsync).mockResolvedValue(
      cloudProbe.active({ id: 'sess-1', platform: 'ios' })
    );
    vi.mocked(eas().stopEasSessionAsync).mockResolvedValue({ ok: true, reason: null });

    const code = await devStopAsync(projectRoot, options({ eas: true }));

    expect(code).toBe(EXIT_OK);
    expect(eas().stopEasSessionAsync).toHaveBeenCalledWith(projectRoot, 'sess-1');
    const report = JSON.parse(printed());
    expect(report.session).toEqual({ id: 'sess-1', stopped: true, reason: null, platform: 'ios' });
  });

  it(`reports no session as an answer, and exits 0`, async () => {
    vi.mocked(cloud().probeCloudSessionAsync).mockResolvedValue(
      cloudProbe.none({ reason: 'nothing listed' })
    );

    const code = await devStopAsync(projectRoot, options({ eas: true }));

    expect(code).toBe(EXIT_OK);
    expect(eas().stopEasSessionAsync).not.toHaveBeenCalled();
    expect(JSON.parse(printed()).session).toEqual({
      id: null,
      stopped: false,
      reason: null,
      platform: null,
    });
  });

  it(`exits 20 when the session would not stop — it is still billing`, async () => {
    vi.mocked(cloud().probeCloudSessionAsync).mockResolvedValue(
      cloudProbe.active({ id: 'sess-1', platform: 'ios' })
    );
    vi.mocked(eas().stopEasSessionAsync).mockResolvedValue({
      ok: false,
      reason: '"npx --yes eas-cli simulator:stop --id sess-1 --non-interactive" exited 1: refused',
    });

    const code = await devStopAsync(projectRoot, options({ eas: true }));

    expect(code).toBe(EXIT_OUTCOME_FAILED);
    expect(JSON.parse(printed()).session).toMatchObject({ id: 'sess-1', stopped: false });
  });

  describe('with a cloud binding on another platform', () => {
    beforeEach(() => {
      vol.reset();
      vol.fromJSON({ [`${projectRoot}/package.json`]: '{}' });
      writeCloudBinding(projectRoot, 'android', 'sess-2');
      vi.mocked(cloud().probeCloudSessionAsync).mockResolvedValue(
        cloudProbe.active({ id: 'sess-1', platform: 'ios' })
      );
      vi.mocked(eas().stopEasSessionAsync).mockImplementation(async (_root, id) =>
        id === 'sess-2' ? { ok: false, reason: 'refused' } : { ok: true, reason: null }
      );
    });

    it(`reports the failed stop as a device row and as the device error`, async () => {
      const code = await devStopAsync(projectRoot, options({ eas: true }));

      expect(code).toBe(EXIT_OUTCOME_FAILED);
      const report = JSON.parse(printed());
      expect(report.session).toEqual({
        id: 'sess-1',
        stopped: true,
        reason: null,
        platform: 'ios',
      });
      expect(report.devices).toEqual([
        {
          backend: 'cloud',
          platform: 'android',
          id: 'sess-2',
          name: 'sess-2',
          released: false,
          shutDown: false,
          reason: 'refused; "npx --yes eas-cli simulator:stop --id sess-2" ends it',
        },
      ]);
      expect(report.deviceError).toBe(
        'refused; "npx --yes eas-cli simulator:stop --id sess-2" ends it'
      );
      expect(readCloudBindings(projectRoot).bindings).toMatchObject([{ device: { id: 'sess-2' } }]);
    });

    it(`prints one line per cloud row`, async () => {
      await devStopAsync(projectRoot, options({ eas: true, json: false }));

      expect(printed()).toContain(
        'Could not release sess-2: refused; "npx --yes eas-cli simulator:stop --id sess-2" ends it'
      );
      expect(printedErrors()).toBe(
        'refused; "npx --yes eas-cli simulator:stop --id sess-2" ends it'
      );
    });
  });

  it(`plain dev:stop reaps a deleted worktree's session and keeps this worktree's own cloud binding`, async () => {
    const gone = '/gone-worktree';
    vol.reset();
    vol.fromJSON({ [`${projectRoot}/package.json`]: '{}', [`${gone}/package.json`]: '{}' });
    const lease = {
      boundAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    writeCloudBinding(gone, 'ios', 'sess-orphan', lease);
    writeCloudBinding(projectRoot, 'android', 'sess-own', lease);
    require('node:fs').rmSync(gone, { recursive: true });
    vi.mocked(eas().stopEasSessionAsync).mockResolvedValue({ ok: true, reason: null });

    const code = await devStopAsync(projectRoot, options());

    expect(code).toBe(EXIT_OK);
    expect(eas().stopEasSessionAsync).toHaveBeenCalledTimes(1);
    expect(eas().stopEasSessionAsync).toHaveBeenCalledWith(projectRoot, 'sess-orphan');
    expect(readCloudBindings(projectRoot).bindings).toMatchObject([{ device: { id: 'sess-own' } }]);
  });

  it(`keeps a failed listing on session.reason and exits 0 when there is nothing to stop`, async () => {
    vi.mocked(cloud().probeCloudSessionAsync).mockResolvedValue(
      cloudProbe.unknown({ reason: 'no Expo account is signed in' })
    );

    const code = await devStopAsync(projectRoot, options({ eas: true }));

    expect(code).toBe(EXIT_OK);
    const report = JSON.parse(printed());
    expect(report.session).toMatchObject({ id: null, reason: 'no Expo account is signed in' });
    expect(report.deviceError).toBeNull();
  });

  it(`keeps the reason of an unavailable account on session.reason`, async () => {
    vi.mocked(cloud().probeCloudSessionAsync).mockResolvedValue(cloudProbe.unavailable());

    const code = await devStopAsync(projectRoot, options({ eas: true }));

    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(printed()).session.reason).toContain('not enabled on this account');
  });

  it(`exits 0 when every bound session stopped though the listing failed`, async () => {
    writeCloudBinding(projectRoot, 'android', 'sess-2');
    vi.mocked(cloud().probeCloudSessionAsync).mockResolvedValue(
      cloudProbe.unknown({ reason: 'listing failed' })
    );
    vi.mocked(eas().stopEasSessionAsync).mockResolvedValue({ ok: true, reason: null });

    const code = await devStopAsync(projectRoot, options({ eas: true }));

    expect(code).toBe(EXIT_OK);
    const report = JSON.parse(printed());
    expect(report.devices).toMatchObject([{ id: 'sess-2', released: true }]);
    expect(report.session.reason).toBe('listing failed');
  });

  it(`reports a stopped session whose binding stayed as kept, with the lock error`, async () => {
    writeCloudBinding(projectRoot, 'android', 'sess-2');
    vi.mocked(cloud().probeCloudSessionAsync).mockResolvedValue(cloudProbe.none({ reason: 'x' }));
    vi.mocked(eas().stopEasSessionAsync).mockResolvedValue({ ok: true, reason: null });
    const registry =
      require('../../deviceBinding/registry') as typeof import('../../deviceBinding/registry');
    const locked = vi
      .spyOn(registry, 'withRegistryLockAsync')
      .mockRejectedValue(new Error('lock wait timed out'));
    const code = await devStopAsync(projectRoot, options({ eas: true, followups: true })).finally(
      () => locked.mockRestore()
    );

    expect(code).toBe(EXIT_OUTCOME_FAILED);
    const report = JSON.parse(printed());
    expect(report.devices).toMatchObject([
      { id: 'sess-2', released: null, shutDown: true, reason: 'lock wait timed out' },
    ]);
    expect(report.followups.map((f: { why: string }) => f.why).join('\n')).toContain('sess-2');
    expect(readCloudBindings(projectRoot).bindings).toMatchObject([{ device: { id: 'sess-2' } }]);
  });

  it(`names an unreadable cloud binding file`, async () => {
    vol.reset();
    vol.fromJSON({ [`${projectRoot}/package.json`]: '{}' });
    const file = bindingPathFor(projectRoot, 'android', 'cloud');
    require('node:fs').mkdirSync(require('node:path').dirname(file), { recursive: true });
    require('node:fs').writeFileSync(file, 'garbage');
    vi.mocked(cloud().probeCloudSessionAsync).mockResolvedValue(cloudProbe.none({ reason: 'x' }));

    await devStopAsync(projectRoot, options({ eas: true }));

    const { deviceError } = JSON.parse(printed());
    expect(deviceError).toContain(`The binding file ${file} does not parse`);
    expect(deviceError).toContain(`How: run "rm -f '${file}'"`);
  });

  it(`asks nothing about a session without the flag`, async () => {
    await devStopAsync(projectRoot, options());
    expect(cloud().probeCloudSessionAsync).not.toHaveBeenCalled();
    expect(JSON.parse(printed()).session).toBeUndefined();
  });
});

// @ref llp/0035-one-device-per-worktree.rfc.md §Session cleanup
describe(buildFollowUps, () => {
  const result = (overrides: Partial<DevStopResultJson>): DevStopResultJson => ({
    stopped: true,
    pid: 1234,
    port: 8081,
    url: 'http://127.0.0.1:8081',
    lockHeld: true,
    signal: 'SIGTERM',
    forced: false,
    forceRefusedBy: null,
    processStillRunning: false,
    portStillAnswering: false,
    easPlatform: null,
    reason: null,
    detail: null,
    untracked: false,
    waitedMs: 0,
    followups: [],
    ...overrides,
  });
  const cloud = (released: boolean | null) => ({
    backend: 'cloud' as const,
    platform: 'android' as const,
    id: 'sess-1',
    name: 'sess-1',
    released,
    shutDown: false,
    reason: null,
  });

  it.each<[string, Partial<DevStopResultJson>, string[], string | null | undefined, boolean?]>([
    [
      'a kept cloud session, on its platform',
      { devices: [cloud(null)] },
      ['stop-session', 'dev'],
      '--android',
    ],
    ['a released cloud session', { devices: [cloud(true)] }, ['dev'], '--android'],
    [
      'nothing running and a kept cloud session',
      { stopped: false, reason: 'not-running', devices: [cloud(null)] },
      ['stop-session'],
      null,
    ],
    [
      "a failed stop of the probe's session",
      { devices: [], session: { id: 'A', stopped: false, reason: 'x', platform: null } },
      ['stop-session', 'dev'],
      undefined,
    ],
    [
      'no session on record',
      { devices: [], session: { id: null, stopped: false, reason: 'unknown', platform: null } },
      ['dev'],
      undefined,
    ],
    [
      "the probe's session stopped, on its platform",
      { devices: [], session: { id: 'A', stopped: true, reason: null, platform: 'android' } },
      ['dev'],
      '--android',
    ],
    [
      'nothing running and this run stopped the session',
      {
        stopped: false,
        reason: 'not-running',
        devices: [],
        session: { id: 's', stopped: true, reason: null, platform: 'ios' },
      },
      ['dev'],
      '--ios',
    ],
    ['a live pid of a run with no EAS platform', { processStillRunning: true }, ['dev'], undefined],
    [
      'a finishing dev --eas process, on its EAS platform',
      { processStillRunning: true, easPlatform: 'android' },
      ['stop-session', 'dev'],
      '--android',
      true,
    ],
    [
      'a finishing dev --eas process when dev:stop --eas already ran',
      {
        processStillRunning: true,
        easPlatform: 'ios',
        session: { id: 'sess-1', stopped: true, reason: null, platform: 'ios' },
      },
      ['dev'],
      undefined,
      true,
    ],
  ])('names the follow-ups after %s', (_name, input, ids, platformFlag, finishing) => {
    const followups = buildFollowUps(result(input), finishing);

    expect(followups.map((f) => f.id)).toEqual(ids);
    if (finishing && ids[0] === 'stop-session') expect(followups[0]!.why).toContain('pid 1234');
    if (platformFlag !== undefined) {
      expect(followups.find((f) => f.id === 'dev')?.command ?? null).toBe(
        platformFlag && `${PROGRAM_PREFIX} dev ${platformFlag} --eas`
      );
    }
  });

  it(`does not say the dev server is stopped when no dev-server lock answered`, () => {
    const followups = buildFollowUps(
      result({
        stopped: false,
        reason: 'not-running',
        devices: [],
        session: { id: 's', stopped: true, reason: null, platform: 'ios' },
      })
    );

    expect(followups.find((f) => f.id === 'dev')?.why).toBe(
      'The EAS session is stopped, and no dev-server lock answered for this project. This starts a dev server and a session again when the app is needed.'
    );
  });

  it(`says the stop failed, not that it was not checked, for a cloud session whose stop failed`, () => {
    const followups = buildFollowUps(
      result({ devices: [{ ...cloud(false), reason: 'refused\nHow: retry' }] })
    );

    expect(followups.map((f) => f.id)).toEqual(['stop-session', 'dev']);
    expect(followups[0]!.why).toBe(
      'The stop of EAS Simulator session sess-1 failed: refused. If it still runs, it bills until this ends it.'
    );
    expect(buildFollowUps(result({ devices: [cloud(null)] }))[0]!.why).toContain('was not checked');
  });

  it(`says the stop failed for the probe's session whose stop failed`, () => {
    const followups = buildFollowUps(
      result({ session: { id: 'A', stopped: false, reason: 'refused', platform: 'ios' } })
    );

    expect(followups[0]!.why).toContain('The stop of EAS Simulator session A failed: refused.');
    expect(followups[0]!.why).not.toContain('not checked');
  });
});
