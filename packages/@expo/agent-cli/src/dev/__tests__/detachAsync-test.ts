import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import { vol } from 'memfs';

import { readDevServerLockAsync } from '../../devLock';
import { waitForBundlerReadyAsync, type BundlerReadyResult } from '../../runtime/waitReady';
import { devDetachAsync, OPEN_PLATFORM_GRACE_MS } from '../detachAsync';
import { detachedLogPath } from '../logFile';
import { isProcessAlive } from '../processLiveness';
import { resolveDevOptions } from '../resolveOptions';

vi.mock('../../devLock', () => ({ readDevServerLockAsync: vi.fn() }));
vi.mock('../../runtime/waitReady', () => ({ waitForBundlerReadyAsync: vi.fn() }));
vi.mock('../processLiveness', () => ({ isProcessAlive: vi.fn() }));
vi.mock('../events', () => ({ event: vi.fn() }));
vi.mock('../../events', () => ({ event: vi.fn() }));

const projectRoot = '/project';
const logFile = detachedLogPath(projectRoot);
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
  vi.mocked(readDevServerLockAsync).mockResolvedValueOnce(null).mockResolvedValue({
    url: 'http://127.0.0.1:8393',
    port: 8393,
    pid: 4242,
    projectRoot,
    startedAt: '2026-09-30T00:00:00.000Z',
  });
  vi.mocked(spawn).mockImplementation(() => {
    fs.writeFileSync(logFile, servingPlan);
    return Object.assign(new EventEmitter(), {
      pid: 4242,
      unref: vi.fn(),
    }) as unknown as ChildProcess;
  });
  vi.mocked(isProcessAlive).mockReturnValue(true);
  vi.mocked(waitForBundlerReadyAsync).mockResolvedValue(readiness());
});

afterEach(() => {
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
