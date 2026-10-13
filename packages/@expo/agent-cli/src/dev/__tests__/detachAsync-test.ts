import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import { vol } from 'memfs';
import path from 'path';

import { readDevServerLockAsync } from '../../devLock';
import {
  acquireDeviceAsync,
  acquireLine,
  devicesDisabled,
  hostBindsPlatform,
} from '../../deviceBinding';
import { deviceUnavailableError } from '../../deviceBinding/errors';
import { event as cliEvent } from '../../events';
import * as Log from '../../log';
import { waitForBundlerReadyAsync, type BundlerReadyResult } from '../../runtime/waitReady';
import { logCmdError, type CommandError } from '../../utils/errors';
import { fetchAdvertisedUrlAsync } from '../advertisedUrl';
import { devDetachAsync, OPEN_PLATFORM_GRACE_MS } from '../detachAsync';
import { CALLER_ARGV_ENV, explicitRequestOf } from '../deviceOption';
import { detachedLogPath } from '../logFile';
import { isProcessAlive } from '../processLiveness';
import { resolveDevOptions } from '../resolveOptions';

vi.mock('../../devLock', () => ({ readDevServerLockAsync: vi.fn() }));
vi.mock('../../log');
vi.mock('../../exitCodes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../exitCodes')>()),
  exitWithCodeAsync: vi.fn(() => new Promise<never>(() => {})),
}));
vi.mock('../../deviceBinding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../deviceBinding')>()),
  devicesDisabled: vi.fn(() => true),
  hostBindsPlatform: vi.fn(() => false),
  acquireDeviceAsync: vi.fn(),
}));
vi.mock('../../runtime/waitReady', () => ({ waitForBundlerReadyAsync: vi.fn() }));
vi.mock('../processLiveness', () => ({ isProcessAlive: vi.fn() }));
vi.mock('../events', () => ({ event: vi.fn() }));
vi.mock('../../events', () => ({ event: vi.fn() }));
vi.mock('../advertisedUrl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../advertisedUrl')>()),
  fetchAdvertisedUrlAsync: vi.fn(),
}));

const realPlatform = process.platform;
function mockPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value });
}

const projectRoot = '/project';
const logFile = detachedLogPath(projectRoot);
const startLog = path.join(projectRoot, '.expo', 'dev', 'logs', 'start.log');
const servingPlan = '  1. expo run:ios  ~minutes\n› Installing on iPhone\n';

function readiness(ready = true): BundlerReadyResult {
  return {
    ready,
    projectRootMatched: true,
    reportedProjectRoot: projectRoot,
    timedOut: false,
    waitedMs: 0,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.mocked(readDevServerLockAsync)
    .mockResolvedValueOnce(null)
    .mockResolvedValue({
      url: 'http://127.0.0.1:8393',
      port: 8393,
      pid: 4242,
      projectRoot,
      startedAt: new Date(0).toISOString(),
    });
  vi.mocked(spawn).mockImplementation(() => {
    fs.writeFileSync(logFile, servingPlan);
    // Metro's own report of the port the lock names, which is when the parent reports it.
    fs.mkdirSync(path.dirname(startLog), { recursive: true });
    fs.writeFileSync(
      startLog,
      JSON.stringify({ _e: 'metro:instantiate', _t: Date.now(), port: 8393 })
    );
    return Object.assign(new EventEmitter(), {
      pid: 4242,
      unref: vi.fn(),
    }) as unknown as ChildProcess;
  });
  vi.mocked(isProcessAlive).mockReturnValue(true);
  vi.mocked(waitForBundlerReadyAsync).mockResolvedValue(readiness());
});

afterEach(() => {
  mockPlatform(realPlatform);
  vi.useRealTimers();
  vi.resetAllMocks();
  vol.reset();
});

function run() {
  return devDetachAsync(
    projectRoot,
    resolveDevOptions(['--ios', '--detach', '--wait-ready', '--local', '--json']),
    { print: false }
  );
}

/** Fail a status probe after the child exits, optionally before its handoff reaches the log. */
function diesDuringProbe(check: 'final check' | 'grace', handoffDelay: number | null) {
  const probe = vi.mocked(waitForBundlerReadyAsync);
  probe.mockResolvedValueOnce(readiness());
  if (check === 'grace') {
    probe.mockResolvedValueOnce(readiness());
  }
  probe.mockImplementationOnce(async () => {
    setTimeout(() => {
      // The PID is gone even if the parent has not received its exit event yet.
      vi.mocked(isProcessAlive).mockReturnValue(false);
      fs.appendFileSync(logFile, 'NeedsHumanError: macOS refused Automation permission\n');
    }, 400);
    if (handoffDelay != null) {
      setTimeout(() => {
        fs.appendFileSync(logFile, 'Needs a human   macos-automation\n');
      }, handoffDelay);
    }
    // The production liveness probe may retry for two seconds, outlasting the grace window.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return readiness(false);
  });
}

describe.each(['final check', 'grace'] as const)(
  'child exit during the %s status probe',
  (check) => {
    it('relays the handoff written while the status probe was pending', async () => {
      diesDuringProbe(check, 500);

      const result = run().catch((error) => error);
      await vi.runAllTimersAsync();

      expect(await result).toMatchObject({
        code: 'DEV_DETACH_NEEDS_HUMAN',
        exitCode: 7,
        needsHuman: { scenario: 'macos-automation', detectedBy: 'detached-child-log' },
      });
    });

    it('waits for the handoff when only the error line is readable after the probe', async () => {
      diesDuringProbe(check, 2200);

      const result = run().catch((error) => error);
      await vi.runAllTimersAsync();

      expect(await result).toMatchObject({
        code: 'DEV_DETACH_NEEDS_HUMAN',
        exitCode: 7,
        needsHuman: { scenario: 'macos-automation' },
      });
    });

    it('bounds the extra wait when the child exits without a handoff', async () => {
      diesDuringProbe(check, null);

      const result = run().catch((error) => error);
      await vi.runAllTimersAsync();

      expect(await result).toMatchObject({ code: 'DEV_DETACH_DIED', exitCode: 20 });
      // One verdict wait after the failed probe, including the first grace poll if needed.
      expect(Date.now()).toBe(check === 'grace' ? 4100 : 4000);
    });
  }
);

describe('reusing a running server', () => {
  beforeEach(() => {
    vi.mocked(readDevServerLockAsync)
      .mockReset()
      .mockResolvedValue({
        url: 'http://127.0.0.1:8393',
        port: 8393,
        pid: 4242,
        projectRoot,
        startedAt: new Date(0).toISOString(),
      });
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, servingPlan);
    vi.mocked(fetchAdvertisedUrlAsync).mockResolvedValue(null);
  });

  afterEach(() => expect(spawn).not.toHaveBeenCalled());

  function reuse(waitReady = true) {
    return devDetachAsync(
      projectRoot,
      { ...resolveDevOptions(['--ios', '--detach', '--local', '--json']), waitReady },
      { print: false }
    );
  }

  async function failure(waitReady = true) {
    const result = reuse(waitReady).catch((error) => error);
    await vi.runAllTimersAsync();
    expect(cliEvent).not.toHaveBeenCalledWith('dev_detach', expect.anything());
    return result;
  }

  it.each([true, false])('detects death during tunnel lookup (waitReady=%s)', async (waitReady) => {
    vi.mocked(fetchAdvertisedUrlAsync).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      vi.mocked(isProcessAlive).mockReturnValue(false);
      return null;
    });

    expect(await failure(waitReady)).toMatchObject({ code: 'DEV_DETACH_DIED', exitCode: 20 });
    expect(Date.now()).toBe(2100); // Tunnel lookup plus one bounded verdict wait.
    if (!waitReady) expect(waitForBundlerReadyAsync).not.toHaveBeenCalled();
  });

  it.each([100, 300])('relays a readiness failure whose handoff arrives at %sms', async (delay) => {
    fs.utimesSync(logFile, new Date(-1000), new Date(-1000));
    vi.mocked(waitForBundlerReadyAsync).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return readiness(false);
    });
    setTimeout(() => {
      vi.mocked(isProcessAlive).mockReturnValue(false);
      fs.appendFileSync(logFile, 'NeedsHumanError: macOS refused Automation permission\n');
    }, 50);
    setTimeout(() => fs.appendFileSync(logFile, 'Needs a human   macos-automation\n'), delay);

    expect(await failure()).toMatchObject({
      code: 'DEV_DETACH_NEEDS_HUMAN',
      exitCode: 7,
      needsHuman: { scenario: 'macos-automation', detectedBy: 'detached-child-log' },
    });
    expect(Date.now()).toBe(Math.max(200, delay));
  });

  it('reads the handoff after the final status probe', async () => {
    vi.mocked(waitForBundlerReadyAsync)
      .mockResolvedValueOnce(readiness())
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        fs.appendFileSync(logFile, 'Needs a human   macos-automation\n');
        return readiness(false);
      });

    expect(await failure()).toMatchObject({ code: 'DEV_DETACH_NEEDS_HUMAN', exitCode: 7 });
  });

  it.each(['silent', 'foreign'])('rejects a %s final status response', async (response) => {
    vi.mocked(waitForBundlerReadyAsync)
      .mockResolvedValueOnce(readiness())
      .mockResolvedValue({
        ...readiness(response !== 'silent'),
        projectRootMatched: response !== 'foreign',
      });

    expect(await failure()).toMatchObject({ code: 'DEV_DETACH_NOT_ANSWERING', exitCode: 20 });
    expect(Date.now()).toBe(0);
  });

  it.each([
    [true, 'old'],
    [false, 'old'],
    [true, 'missing'],
    [false, 'missing'],
    [true, 'current'],
  ] as const)('reports a healthy server (waitReady=%s, log=%s)', async (waitReady, log) => {
    if (log === 'old') {
      fs.appendFileSync(logFile, 'Needs a human   macos-automation\n');
      fs.utimesSync(logFile, new Date(-1000), new Date(-1000));
    } else if (log === 'missing') {
      fs.unlinkSync(logFile);
    }

    const result = expect(reuse(waitReady)).resolves.toBe(0);
    await vi.runAllTimersAsync();

    await result;
    expect(cliEvent).toHaveBeenCalledWith(
      'dev_detach',
      expect.objectContaining({ alreadyRunning: true, pid: 4242, ready: waitReady ? true : null })
    );
    expect(waitForBundlerReadyAsync).toHaveBeenCalledTimes(waitReady ? 2 : 0);
    expect(Date.now()).toBe(0); // Reuse does not acquire the startup grace period.
  });
});

it('keeps the same grace window for a child that stays healthy', async () => {
  const result = run();
  await vi.runAllTimersAsync();

  await expect(result).resolves.toBe(0);
  expect(Date.now()).toBe(OPEN_PLATFORM_GRACE_MS);
});

it('does not wait for a verdict when the child is alive but the bundler stopped answering', async () => {
  vi.mocked(waitForBundlerReadyAsync)
    .mockResolvedValueOnce(readiness())
    .mockResolvedValueOnce(readiness(false));

  const result = run().catch((error) => error);
  await vi.runAllTimersAsync();

  expect(await result).toMatchObject({ code: 'DEV_DETACH_NOT_ANSWERING', exitCode: 20 });
  expect(Date.now()).toBe(0);
});

// The child publishes its lock at the spawn of a step that names a port, before Metro binds it. A
// retry that moves the dev server republishes, and the report names the port Metro logged.
it('reports the port Metro logged, not the one the lock named before a retry', async () => {
  const { event: cliEvent } = await import('../../events');
  const lock = {
    pid: 4242,
    projectRoot,
    startedAt: new Date(0).toISOString(),
  };
  vi.mocked(readDevServerLockAsync)
    .mockReset()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ ...lock, url: 'http://127.0.0.1:8180', port: 8180 })
    .mockResolvedValue({ ...lock, url: 'http://127.0.0.1:8393', port: 8393 });

  const result = run();
  await vi.advanceTimersByTimeAsync(5000);
  await expect(result).resolves.toBe(0);

  expect(cliEvent).toHaveBeenCalledWith('dev_detach', expect.objectContaining({ port: 8393 }));
});

describe('readiness belongs to this worktree', () => {
  const initialLock = {
    url: 'http://127.0.0.1:8393',
    port: 8393,
    pid: 4242,
    projectRoot,
    startedAt: new Date(0).toISOString(),
  };
  const movedLock = { ...initialLock, url: 'http://127.0.0.1:8394', port: 8394 };
  const foreign = {
    ...readiness(),
    projectRootMatched: false,
    reportedProjectRoot: '/sibling',
  };

  function start() {
    return devDetachAsync(
      projectRoot,
      {
        ...resolveDevOptions(['--ios', '--detach', '--wait-ready', '--local', '--json']),
        detachTimeoutMs: 5000,
      },
      { print: false }
    );
  }

  it('waits past a foreign ready server and reports the port the child moves to', async () => {
    const { event: cliEvent } = await import('../../events');
    vi.mocked(waitForBundlerReadyAsync).mockImplementation(async (url) =>
      url === initialLock.url ? foreign : readiness()
    );
    setTimeout(() => {
      vi.mocked(readDevServerLockAsync).mockResolvedValue(movedLock);
    }, 1000);

    const result = start();
    await vi.advanceTimersByTimeAsync(500);
    expect(cliEvent).not.toHaveBeenCalledWith('dev_detach', expect.anything());
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe(0);
    expect(cliEvent).toHaveBeenCalledWith(
      'dev_detach',
      expect.objectContaining({ port: 8394, url: movedLock.url, ready: true })
    );
  });

  it('cancels a pending status request when the lock moves', async () => {
    let oldSignal: AbortSignal | undefined;
    vi.mocked(waitForBundlerReadyAsync).mockImplementation(async (url, { signal }) => {
      if (url !== initialLock.url) return readiness();
      oldSignal = signal;
      await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve()));
      return readiness(false);
    });
    setTimeout(() => {
      vi.mocked(readDevServerLockAsync).mockResolvedValue(movedLock);
    }, 1000);

    const result = start();
    await vi.advanceTimersByTimeAsync(3000);

    expect(oldSignal?.aborted).toBe(true);
    await expect(result).resolves.toBe(0);
    expect(waitForBundlerReadyAsync).toHaveBeenCalledWith(
      movedLock.url,
      expect.objectContaining({ timeoutMs: expect.any(Number), projectRoot })
    );
  });

  it('fails within the original budget when only a foreign server answers', async () => {
    vi.mocked(waitForBundlerReadyAsync).mockResolvedValue(foreign);

    const result = start().catch((error) => error);
    await vi.runAllTimersAsync();

    expect(await result).toMatchObject({ code: 'DEV_DETACH_NOT_READY' });
    expect((await result).message).toContain('/sibling');
    expect(Date.now()).toBe(5000);
  });

  it('checks readiness even when reusing an existing server', async () => {
    vi.mocked(readDevServerLockAsync).mockReset().mockResolvedValue(initialLock);
    vi.mocked(waitForBundlerReadyAsync).mockResolvedValue(foreign);

    const result = start().catch((error) => error);
    await vi.runAllTimersAsync();

    expect(await result).toMatchObject({ code: 'DEV_DETACH_NOT_READY' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("relays the child's failure instead of waiting on a foreign server until timeout", async () => {
    vi.mocked(waitForBundlerReadyAsync).mockResolvedValue(foreign);
    setTimeout(() => {
      fs.appendFileSync(logFile, 'Needs a human   macos-automation\n');
      vi.mocked(isProcessAlive).mockReturnValue(false);
    }, 1000);

    const result = start().catch((error) => error);
    await vi.runAllTimersAsync();

    expect(await result).toMatchObject({ code: 'DEV_DETACH_NEEDS_HUMAN', exitCode: 7 });
    expect(Date.now()).toBe(1000);
  });

  it.each(['final check', 'grace'])(
    'rejects a foreign server replacing ours during %s',
    async (check) => {
      const probe = vi.mocked(waitForBundlerReadyAsync);
      probe.mockResolvedValueOnce(readiness());
      if (check === 'grace') probe.mockResolvedValueOnce(readiness());
      probe.mockResolvedValue(foreign);

      const result = run().catch((error) => error);
      await vi.runAllTimersAsync();

      expect(await result).toMatchObject({ code: 'DEV_DETACH_NOT_ANSWERING' });
    }
  );
});

// A `run:*` build has not reached Metro yet, so `start.log` names no port. The lock's own
// `startedAt` (the step's spawn) bounds the wait, as the port watch is bounded.
describe('a lock whose port Metro has not logged', () => {
  const pending = {
    url: 'http://127.0.0.1:8180',
    port: 8180,
    pid: 4242,
    projectRoot,
    startedAt: new Date(0).toISOString(),
  };
  let child: EventEmitter;

  beforeEach(() => {
    vi.mocked(readDevServerLockAsync)
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(pending);
    vi.mocked(spawn).mockImplementation(() => {
      fs.writeFileSync(logFile, servingPlan);
      child = Object.assign(new EventEmitter(), { pid: 4242, unref: vi.fn() });
      return child as unknown as ChildProcess;
    });
  });

  it('accepts the lock once 20 s have passed since its spawn, and not before', async () => {
    const { event: cliEvent } = await import('../../events');

    const result = run();
    await vi.advanceTimersByTimeAsync(19_500);
    expect(waitForBundlerReadyAsync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBe(0);
    expect(waitForBundlerReadyAsync).toHaveBeenCalledWith(
      'http://127.0.0.1:8180',
      expect.anything()
    );
    expect(cliEvent).toHaveBeenCalledWith('dev_detach', expect.objectContaining({ port: 8180 }));
  });

  // The budget ends before the 20 s: the unconfirmed lock is still the answer, and the report
  // names its port.
  it('reports the unconfirmed lock when the budget runs out', async () => {
    const { event: cliEvent } = await import('../../events');

    const result = devDetachAsync(
      projectRoot,
      { ...resolveDevOptions(['--ios', '--detach', '--local', '--json']), detachTimeoutMs: 5000 },
      { print: false }
    );
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe(0);
    expect(Date.now()).toBeLessThan(20_000);
    expect(cliEvent).toHaveBeenCalledWith('dev_detach', expect.objectContaining({ port: 8180 }));
  });

  // The child exited with the lock published and unconfirmed: the lock is returned, and the run
  // fails on the dead child rather than on a missing lock.
  it('reports a dead child, not a missing lock, when the child exits first', async () => {
    vi.mocked(isProcessAlive).mockReturnValue(false);

    const result = devDetachAsync(
      projectRoot,
      resolveDevOptions(['--ios', '--detach', '--local', '--json']),
      { print: false }
    ).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1000);
    child.emit('exit', 1, null);
    await vi.runAllTimersAsync();

    expect(await result).toMatchObject({ code: 'DEV_DETACH_DIED', exitCode: 20 });
    expect(Date.now()).toBeLessThan(20_000);
  });
});

// @ref llp/0035-one-device-per-worktree.rfc.md §How `dev` uses it
describe('the bound device', () => {
  const platform = process.platform;
  afterEach(() => Object.defineProperty(process, 'platform', { value: platform }));
  const running = {
    url: 'http://127.0.0.1:8393',
    port: 8393,
    pid: 4242,
    projectRoot,
    startedAt: new Date(0).toISOString(),
  };
  const reused = {
    device: {
      backend: 'local-ios' as const,
      platform: 'ios' as const,
      udid: 'SIM-1',
      name: 'agent-cli 0000',
      origin: 'created' as const,
    },
    justBooted: true,
    action: 'reused' as const,
  };

  beforeEach(() => {
    mockPlatform('darwin');
    vi.mocked(devicesDisabled).mockReturnValue(false);
    // These cases model a host that can run the requested iOS simulator. Other tests below
    // exercise the unsupported-host branch explicitly.
    vi.mocked(hostBindsPlatform).mockImplementation(
      (platform) => platform === 'ios' && process.platform === 'darwin'
    );
    vi.mocked(acquireDeviceAsync).mockResolvedValue(reused);
  });

  // already-running-reuses-only
  it('boots the parked simulator on a running server, reuse only, before the report', async () => {
    vi.mocked(readDevServerLockAsync).mockReset().mockResolvedValue(running);
    const { event: cliEvent } = await import('../../events');

    await expect(
      devDetachAsync(projectRoot, resolveDevOptions(['--ios', '--detach', '--local']), {
        print: false,
        reuseBoundDevice: true,
      })
    ).resolves.toBe(0);

    expect(acquireDeviceAsync).toHaveBeenCalledWith(projectRoot, 'ios', { reuseOnly: true });
    expect(spawn).not.toHaveBeenCalled();
    expect(cliEvent).toHaveBeenCalledWith(
      'dev_detach',
      expect.objectContaining({ alreadyRunning: true })
    );
  });

  it('relays the refusal of a running server with nothing to reuse', async () => {
    vi.mocked(readDevServerLockAsync).mockReset().mockResolvedValue(running);
    vi.mocked(acquireDeviceAsync).mockRejectedValue(
      Object.assign(new Error('nothing to reuse'), { code: 'DEVICE_UNAVAILABLE', exitCode: 20 })
    );

    await expect(
      devDetachAsync(projectRoot, resolveDevOptions(['--ios', '--detach', '--local']), {
        print: false,
        reuseBoundDevice: true,
      })
    ).rejects.toMatchObject({ code: 'DEVICE_UNAVAILABLE', exitCode: 20 });
  });

  it.each(['linux', 'win32'] as const)(
    'reuses the server without acquiring iOS on %s',
    async (platform) => {
      mockPlatform(platform);
      vi.mocked(readDevServerLockAsync).mockReset().mockResolvedValue(running);
      const { event: cliEvent } = await import('../../events');

      await expect(
        devDetachAsync(projectRoot, resolveDevOptions(['--ios', '--detach', '--local']), {
          print: false,
          reuseBoundDevice: true,
        })
      ).resolves.toBe(0);

      expect(acquireDeviceAsync).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(cliEvent).toHaveBeenCalledWith(
        'dev_detach',
        expect.objectContaining({ alreadyRunning: true })
      );
    }
  );

  it('binds nothing when devices are disabled', async () => {
    vi.mocked(devicesDisabled).mockReturnValue(true);
    vi.mocked(readDevServerLockAsync).mockReset().mockResolvedValue(running);
    await expect(
      devDetachAsync(projectRoot, resolveDevOptions(['--ios', '--detach', '--local']), {
        print: false,
        reuseBoundDevice: true,
      })
    ).resolves.toBe(0);
    expect(acquireDeviceAsync).not.toHaveBeenCalled();
  });

  // smoke-never-reaches-already-running-reuse
  it.each([
    ['without reuseBoundDevice', ['--ios', '--detach', '--local'], {}],
    [
      'for --android on a host without Android tools',
      ['--android', '--detach', '--local'],
      { reuseBoundDevice: true },
    ],
    ['for --eas', ['--ios', '--detach', '--eas'], { reuseBoundDevice: true }],
  ])('binds nothing on a running server %s', async (_case, argv, extra) => {
    vi.mocked(readDevServerLockAsync).mockReset().mockResolvedValue(running);

    await expect(
      devDetachAsync(projectRoot, resolveDevOptions(argv), { print: false, ...extra })
    ).resolves.toBe(0);

    expect(acquireDeviceAsync).not.toHaveBeenCalled();
  });

  it('reuses the worktree emulator on a running server when Android tools are available', async () => {
    const reusedAndroid = {
      device: {
        backend: 'local-android' as const,
        platform: 'android' as const,
        serial: 'emulator-5554',
        origin: { kind: 'spawned' as const, avd: 'Pixel_9', port: 5554, emulatorPid: 4242 },
      },
      justBooted: false,
      action: 'reused' as const,
    };
    vi.mocked(hostBindsPlatform).mockReturnValue(true);
    vi.mocked(acquireDeviceAsync).mockResolvedValue(reusedAndroid);
    vi.mocked(readDevServerLockAsync).mockReset().mockResolvedValue(running);

    await expect(
      devDetachAsync(projectRoot, resolveDevOptions(['--android', '--detach', '--local']), {
        print: false,
        reuseBoundDevice: true,
      })
    ).resolves.toBe(0);

    expect(acquireDeviceAsync).toHaveBeenCalledWith(projectRoot, 'android', { reuseOnly: true });
    expect(Log.progress).toHaveBeenCalledWith(acquireLine(reusedAndroid));
  });

  it('does not reuse an iOS simulator when this host cannot run one', async () => {
    vi.mocked(hostBindsPlatform).mockReturnValue(false);
    vi.mocked(readDevServerLockAsync).mockReset().mockResolvedValue(running);

    await expect(
      devDetachAsync(projectRoot, resolveDevOptions(['--ios', '--detach', '--local']), {
        print: false,
        reuseBoundDevice: true,
      })
    ).resolves.toBe(0);

    expect(acquireDeviceAsync).not.toHaveBeenCalled();
  });

  // detached-device-error-relayed
  // detached-device-error-relayed: the child's log is what `logCmdError` writes under
  // `__EXPO_AGENT_CLI_DETACHED=1`, captured off the log module, so the round trip is the real one.
  it("rethrows the child's device refusal unchanged: code, exit, data and Try line", async () => {
    vi.mocked(readDevServerLockAsync).mockReset().mockResolvedValue(null);
    const refusal = deviceUnavailableError('no-ios-runtime', { platform: 'ios' });
    refusal.suggestedCommand = 'xcodebuild -downloadPlatform iOS';
    let child: EventEmitter;
    vi.mocked(spawn).mockImplementation(() => {
      child = Object.assign(new EventEmitter(), { pid: 4242, unref: vi.fn() });
      fs.writeFileSync(logFile, `${childLogOf(refusal).join('\n')}\n`);
      setTimeout(() => child.emit('exit', 7, null), 50);
      return child as unknown as ChildProcess;
    });

    const result = devDetachAsync(
      projectRoot,
      resolveDevOptions(['--ios', '--detach', '--local']),
      { print: false, reuseBoundDevice: true }
    ).catch((error) => error);
    await vi.runAllTimersAsync();

    const error = await result;
    expect(error).toMatchObject({
      code: 'DEVICE_UNAVAILABLE',
      exitCode: 7,
      data: { reason: 'no-ios-runtime' },
      suggestedCommand: 'xcodebuild -downloadPlatform iOS',
    });
    expect(error.message).toBe(refusal.message);
  });

  it("gives the child's --device refusal the caller's flags, --detach and --wait-ready too", async () => {
    vi.mocked(readDevServerLockAsync).mockReset().mockResolvedValue(null);
    const argv = ['--ios', '--device', 'Sim', '--detach', '--wait-ready', '--port', '8092'];
    let spawned: { args: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
    vi.mocked(spawn).mockImplementation(((
      _command: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv }
    ) => {
      spawned = { args, env: options.env };
      const child = Object.assign(new EventEmitter(), { pid: 4242, unref: vi.fn() });
      setTimeout(() => child.emit('exit', 1, null), 50);
      return child as unknown as ChildProcess;
    }) as typeof spawn);

    const result = devDetachAsync(projectRoot, resolveDevOptions(argv), { print: false }).catch(
      () => null
    );
    await vi.runAllTimersAsync();
    await result;

    const childArgv = spawned!.args.slice(spawned!.args.indexOf('dev') + 1);
    vi.stubEnv(CALLER_ARGV_ENV, spawned!.env[CALLER_ARGV_ENV]);
    try {
      expect(explicitRequestOf('Sim', childArgv)?.rerun).toEqual([
        '--ios',
        '--detach',
        '--wait-ready',
        '--port',
        '8092',
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/** The log a detached child writes for `error`, line by line, as `logCmdError` prints it. */
function childLogOf(error: CommandError): string[] {
  vi.mocked(Log.exception).mockClear();
  vi.mocked(Log.warn).mockClear();
  process.env.__EXPO_AGENT_CLI_DETACHED = '1';
  try {
    void logCmdError(error);
  } finally {
    delete process.env.__EXPO_AGENT_CLI_DETACHED;
  }
  return [
    ...vi.mocked(Log.exception).mock.calls.map(([printed]) => String(printed)),
    ...vi.mocked(Log.warn).mock.calls.map((args) => args.join(' ')),
  ];
}

describe('the acquire line', () => {
  it('is printed before the already-running report', async () => {
    mockPlatform('darwin');
    const running = {
      url: 'http://127.0.0.1:8393',
      port: 8393,
      pid: 4242,
      projectRoot,
      startedAt: new Date(0).toISOString(),
    };
    const reused = {
      device: {
        backend: 'local-ios' as const,
        platform: 'ios' as const,
        udid: 'SIM-1',
        name: 'agent-cli 0000',
        origin: 'created' as const,
      },
      justBooted: true,
      action: 'reused' as const,
    };
    vi.mocked(devicesDisabled).mockReturnValue(false);
    vi.mocked(hostBindsPlatform).mockReturnValue(true);
    vi.mocked(acquireDeviceAsync).mockResolvedValue(reused);
    vi.mocked(readDevServerLockAsync).mockReset().mockResolvedValue(running);
    const { event: cliEvent } = await import('../../events');

    await devDetachAsync(projectRoot, resolveDevOptions(['--ios', '--detach', '--local']), {
      print: false,
      reuseBoundDevice: true,
    });

    expect(Log.progress).toHaveBeenCalledWith(acquireLine(reused));
    const printedAt = vi.mocked(Log.progress).mock.invocationCallOrder[0]!;
    const reportedAt = vi.mocked(cliEvent).mock.invocationCallOrder.at(-1)!;
    expect(printedAt).toBeLessThan(reportedAt);
  });
});
