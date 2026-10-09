// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
import { readDevServerLockAsync, type DevServerLockInfo } from '../devLock';
import { waitForBundlerReadyAsync, type BundlerReadyResult } from '../runtime/waitReady';

const LOCK_POLL_MS = 200;

/** Follow this child's lock while Metro starts, including a port retry after a native build. */
export async function waitForDetachedReadyAsync(
  projectRoot: string,
  initialLock: DevServerLockInfo,
  options: { timeoutMs: number; hasExited: () => boolean; signal?: AbortSignal }
): Promise<{ lock: DevServerLockInfo; result: BundlerReadyResult }> {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  let lock = initialLock;
  let lastResult: BundlerReadyResult | undefined;
  let probe: ReturnType<typeof startProbe> | undefined;

  function startProbe() {
    const controller = new AbortController();
    const pending: {
      controller: AbortController;
      result?: BundlerReadyResult;
      promise: Promise<void>;
    } = { controller, promise: Promise.resolve() };
    pending.promise = waitForBundlerReadyAsync(lock.url, {
      projectRoot,
      timeoutMs: Math.max(1, deadline - Date.now()),
      signal: options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal,
    }).then((result) => {
      pending.result = result;
    });
    return pending;
  }

  function failed(reason: string, timedOut = false) {
    const result = probe?.result ?? lastResult;
    return {
      lock,
      result: {
        ready: false,
        projectRootMatched: result?.projectRootMatched ?? null,
        reportedProjectRoot: result?.reportedProjectRoot ?? null,
        timedOut,
        waitedMs: Date.now() - startedAt,
        reason,
      },
    };
  }

  try {
    for (;;) {
      if (options.signal?.aborted || options.hasExited()) {
        return failed("The process holding this project's dev-server lock exited.");
      }
      if (Date.now() >= deadline) {
        return failed(
          `No ready dev server for this project was confirmed within ${options.timeoutMs}ms.`,
          true
        );
      }

      probe ??= startProbe();
      // The lock can disappear briefly while the same child retries on a different port. An
      // absent lock is not permission to report the old URL, or to adopt another child's server.
      const current = await readDevServerLockAsync(projectRoot, {
        timeoutMs: Math.min(2000, Math.max(1, deadline - Date.now())),
      });
      if (current && current.pid !== initialLock.pid) {
        return failed('The dev-server lock changed owners while waiting for readiness.');
      }
      if (current && current.url !== lock.url) {
        probe.controller.abort();
        await probe.promise;
        lock = current;
        lastResult = undefined;
        probe = undefined;
        continue;
      }
      if (current) lock = current;
      if (options.signal?.aborted || options.hasExited() || Date.now() >= deadline) continue;

      const result = probe.result;
      if (result) {
        lastResult = result;
        // Preserve the shared compatibility rule: a missing root header is unknown, not foreign.
        if (current && result.projectRootMatched !== false) {
          return { lock, result: { ...result, waitedMs: Date.now() - startedAt } };
        }
      }

      // Keep one long /status request in flight while watching the lock. A foreign answer is
      // retried at the same bounded cadence, so it cannot end the wait or cause a busy loop.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const poll = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.min(LOCK_POLL_MS, deadline - Date.now()));
        });
        await (result ? poll : Promise.race([probe.promise, poll]));
      } finally {
        clearTimeout(timer);
      }
      if (result) probe = undefined;
    }
  } finally {
    // In particular, cancel the request to an obsolete port before leaving this wait.
    probe?.controller.abort();
    await probe?.promise;
  }
}
