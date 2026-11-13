// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import { vol } from 'memfs';
import path from 'path';

import { readDevServerLockAsync, type DevServerLockInfo } from '../../devLock';
import { lockInfo } from '../../devLock/__tests__/fakeLock';
import { deviceUnavailableError } from '../../deviceBinding/errors';
import { event as cliEvent } from '../../events';
import { probeBundlerAsync } from '../../runtime/bundlerStatus';
import { waitForBundlerReadyAsync } from '../../runtime/waitReady';
import { devDetachAsync, type DevDetachOptions } from '../detachAsync';
import { detachedLogPath } from '../logFile';
import { isProcessAlive } from '../processLiveness';
import { reopenEasAsync } from '../reopenEas';
import { resolveDevOptions } from '../resolveOptions';
import { devServerRunningError } from '../runningDevServer';
import { childLogOf } from './childLog';

vi.mock('../../devLock', () => ({ readDevServerLockAsync: vi.fn() }));
vi.mock('../../log');
vi.mock('../../deviceBinding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../deviceBinding')>()),
  devicesDisabled: vi.fn(() => true),
  hostBindsPlatform: vi.fn(() => false),
}));
vi.mock('../../runtime/waitReady', () => ({ waitForBundlerReadyAsync: vi.fn() }));
vi.mock('../../runtime/bundlerStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../runtime/bundlerStatus')>()),
  probeBundlerAsync: vi.fn(),
}));
vi.mock('../reopenEas', () => ({ reopenEasAsync: vi.fn() }));
vi.mock('../openAppEas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../openAppEas')>()),
  otherPlatformSessionAsync: vi.fn(),
}));
vi.mock('../processLiveness', () => ({ isProcessAlive: vi.fn() }));
vi.mock('../events', () => ({ event: vi.fn() }));
vi.mock('../../events', () => ({ event: vi.fn() }));
vi.mock('../advertisedUrl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../advertisedUrl')>()),
  fetchAdvertisedUrlAsync: vi.fn(),
}));

const projectRoot = '/project';
const logFile = detachedLogPath(projectRoot);
const lastRequestFile = path.join(projectRoot, '.expo', 'agent-cli-last-dev.json');
const CHILD_PID = 4242;
const OTHER_PID = 9999;

function lock(pid: number, phase: DevServerLockInfo['phase'] = 'serving'): DevServerLockInfo {
  return {
    ...lockInfo({ phase }),
    url: 'http://127.0.0.1:8393',
    port: 8393,
    pid,
    projectRoot,
    portReported: true,
    startedAt: new Date(Date.now()).toISOString(),
  };
}

/** A spawned child that writes `log` and exits with `code`; null keeps it running. */
function spawnChild(log: string[], code: number | null) {
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: CHILD_PID, unref: vi.fn() });
    fs.writeFileSync(logFile, log.length ? `${log.join('\n')}\n` : '');
    if (code != null) setTimeout(() => child.emit('exit', code, null), 50);
    return child as unknown as ChildProcess;
  });
}

function run(argv: string[], detach: DevDetachOptions = {}) {
  return devDetachAsync(projectRoot, resolveDevOptions(['--ios', '--detach', ...argv]), {
    print: false,
    ...detach,
  }).catch((error) => error);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  vi.mocked(isProcessAlive).mockReturnValue(true);
  vi.mocked(probeBundlerAsync).mockResolvedValue({
    answering: true,
    projectRootMatched: true,
  } as Awaited<ReturnType<typeof probeBundlerAsync>>);
  vi.mocked(waitForBundlerReadyAsync).mockResolvedValue({
    ready: true,
    projectRootMatched: true,
    reportedProjectRoot: projectRoot,
    timedOut: false,
    waitedMs: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vol.reset();
});

describe('a local run beside a lock it reads', () => {
  it.each(['serving', 'building', 'finishing'] as const)(
    'stops on a %s lock and spends nothing',
    async (phase) => {
      vi.mocked(readDevServerLockAsync).mockResolvedValue(lock(OTHER_PID, phase));

      const result = run(['--local']);
      await vi.advanceTimersByTimeAsync(0);

      expect(await result).toMatchObject({
        code: 'DEV_SERVER_RUNNING',
        exitCode: 20,
        data: { phase, pid: OTHER_PID },
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(reopenEasAsync).not.toHaveBeenCalled();
      expect(cliEvent).not.toHaveBeenCalledWith('dev_detach', expect.anything());
      expect(fs.existsSync(lastRequestFile)).toBe(false);
    }
  );
});

describe('a lock another run takes after the spawn', () => {
  beforeEach(() => {
    vi.mocked(readDevServerLockAsync)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(lock(OTHER_PID));
  });

  const childRefusal = () =>
    childLogOf(devServerRunningError({ lock: lock(OTHER_PID), phase: 'serving' }, 'ios'));

  it("relays the child's DEV_SERVER_RUNNING to a local run", async () => {
    spawnChild(childRefusal(), 20);

    const result = run(['--local']);
    await vi.runAllTimersAsync();

    expect(await result).toMatchObject({
      code: 'DEV_SERVER_RUNNING',
      exitCode: 20,
      data: { pid: OTHER_PID, phase: 'serving' },
    });
    expect(cliEvent).not.toHaveBeenCalledWith('dev_detach', expect.anything());
  });

  it('builds the refusal from the lock when the child exits 20 with an empty log', async () => {
    spawnChild([], 20);

    const result = run(['--local']);
    await vi.runAllTimersAsync();

    expect(await result).toMatchObject({
      code: 'DEV_SERVER_RUNNING',
      exitCode: 20,
      data: { pid: OTHER_PID },
    });
  });

  it('relays a device refusal of the child unchanged', async () => {
    spawnChild(childLogOf(deviceUnavailableError('no-ios-runtime', { platform: 'ios' })), 7);

    const result = run(['--local']);
    await vi.runAllTimersAsync();

    expect(await result).toMatchObject({ code: 'DEVICE_UNAVAILABLE' });
  });

  it('names no server of another run while the child still runs', async () => {
    spawnChild([], null);

    const result = run(['--local']);
    await vi.runAllTimersAsync();

    const error = await result;
    expect(error).toMatchObject({ code: 'DEV_DETACH_FAILED' });
    expect(error.message).not.toContain(`pid ${OTHER_PID}`);
  });

  it('reuses that server for smoke', async () => {
    spawnChild(childRefusal(), 20);

    const result = run(['--local', '--wait-ready'], { reuseRunning: true });
    await vi.runAllTimersAsync();

    expect(await result).toBe(0);
    expect(cliEvent).toHaveBeenCalledWith(
      'dev_detach',
      expect.objectContaining({ alreadyRunning: true, pid: OTHER_PID })
    );
  });

  it('opens the EAS session on that server for dev --eas', async () => {
    spawnChild(childRefusal(), 20);

    const result = run(['--eas']);
    await vi.runAllTimersAsync();

    await result;
    expect(reopenEasAsync).toHaveBeenCalledTimes(1);
  });
});

describe('a followed build that ends', () => {
  it("relays no verdict an earlier detached child wrote before the followed run's start", async () => {
    fs.writeFileSync(
      logFile,
      `${childLogOf(deviceUnavailableError('no-ios-runtime', { platform: 'ios' })).join('\n')}\n`
    );
    vi.setSystemTime(200_000);
    const building = lock(OTHER_PID, 'building');
    vi.mocked(readDevServerLockAsync).mockResolvedValueOnce(building).mockResolvedValue(null);
    vi.mocked(isProcessAlive).mockReturnValue(false);

    const result = run(['--local', '--wait-ready'], { reuseRunning: true });
    await vi.runAllTimersAsync();

    expect(await result).toMatchObject({ code: 'DEV_DETACH_FAILED' });
  });
});
