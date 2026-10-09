import { readDevServerLockAsync } from '../../devLock';
import { waitForBundlerReadyAsync, type BundlerReadyResult } from '../../runtime/waitReady';
import { waitForDetachedReadyAsync } from '../waitForDetachedReady';

vi.mock('../../devLock', () => ({ readDevServerLockAsync: vi.fn() }));
vi.mock('../../runtime/waitReady', () => ({ waitForBundlerReadyAsync: vi.fn() }));

const lock = {
  url: 'http://127.0.0.1:8081',
  port: 8081,
  pid: 1234,
  projectRoot: '/project',
  startedAt: new Date(0).toISOString(),
};
const moved = { ...lock, url: 'http://127.0.0.1:8082', port: 8082 };
const ready: BundlerReadyResult = {
  ready: true,
  projectRootMatched: true,
  reportedProjectRoot: '/project',
  timedOut: false,
  waitedMs: 0,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.mocked(readDevServerLockAsync).mockResolvedValue(lock);
  vi.mocked(waitForBundlerReadyAsync).mockResolvedValue(ready);
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

function wait(options: { signal?: AbortSignal; hasExited?: () => boolean } = {}) {
  return waitForDetachedReadyAsync('/project', lock, {
    timeoutMs: 1000,
    hasExited: () => false,
    ...options,
  });
}

it('preserves the older-Metro missing-header compatibility rule', async () => {
  vi.mocked(waitForBundlerReadyAsync).mockResolvedValue({
    ...ready,
    projectRootMatched: null,
    reportedProjectRoot: null,
  });
  expect((await wait()).result).toMatchObject({ ready: true, projectRootMatched: null });
});

it('does not accept a ready response from the old URL after the lock moves', async () => {
  vi.mocked(readDevServerLockAsync).mockResolvedValue(moved);
  vi.mocked(waitForBundlerReadyAsync).mockImplementation(async (url) => {
    if (url === lock.url) return ready;
    return { ...ready, projectRootMatched: false, reportedProjectRoot: '/sibling' };
  });
  const result = wait();
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ lock: moved, result: { ready: false, timedOut: true } });
});

it('does not reset the deadline when the port changes', async () => {
  vi.mocked(waitForBundlerReadyAsync).mockResolvedValue({
    ...ready,
    projectRootMatched: false,
    reportedProjectRoot: '/sibling',
  });
  setTimeout(() => vi.mocked(readDevServerLockAsync).mockResolvedValue(moved), 600);
  const result = wait();
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ lock: moved, result: { ready: false, waitedMs: 1000 } });
  expect(waitForBundlerReadyAsync).toHaveBeenCalledWith(
    moved.url,
    expect.objectContaining({ timeoutMs: 400 })
  );
  expect(vi.getTimerCount()).toBe(0);
});

it('waits through a gap in the lock instead of accepting the old URL', async () => {
  vi.mocked(readDevServerLockAsync).mockResolvedValue(null);
  setTimeout(() => vi.mocked(readDevServerLockAsync).mockResolvedValue(moved), 400);
  const result = wait();
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ lock: moved, result: { ready: true, waitedMs: 400 } });
});

it('does not silently adopt a replacement lock owner', async () => {
  vi.mocked(readDevServerLockAsync).mockResolvedValue({ ...moved, pid: 5678 });
  expect((await wait()).result).toMatchObject({
    ready: false,
    reason: expect.stringContaining('changed owners'),
  });
});

it('aborts a hanging status request when the child dies without an exit event', async () => {
  let alive = true;
  let signal: AbortSignal | undefined;
  vi.mocked(waitForBundlerReadyAsync).mockImplementation(async (_, options) => {
    signal = options.signal;
    await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve()));
    return { ...ready, ready: false };
  });
  setTimeout(() => {
    alive = false;
  }, 200);
  const result = wait({ hasExited: () => !alive });
  await vi.runAllTimersAsync();
  expect((await result).result).toMatchObject({ ready: false, timedOut: false, waitedMs: 200 });
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not start a request for an already aborted caller', async () => {
  const controller = new AbortController();
  controller.abort();
  expect((await wait({ signal: controller.signal })).result.ready).toBe(false);
  expect(waitForBundlerReadyAsync).not.toHaveBeenCalled();
});
