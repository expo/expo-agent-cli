// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
import { readDevServerLockAsync, type DevServerLockInfo } from '../devLock';
import { PORT_WATCH_TIMEOUT_MS } from '../devLock/port';
import { isProcessAlive } from './processLiveness';
import type { DevOptions } from './resolveOptions';
import { stillBuildingOnLockError } from './detachHealth';

/** How often the lock is asked while the parent waits for it. */
const LOCK_POLL_INTERVAL_MS = 200;

/**
 * A serving lock is confirmed by a port report or the port-watch deadline. Without
 * --wait-ready, a building lock can be reported immediately. Read before checking exit:
 * an exited child may still have a lock answer. Only exit recovers the last building lock;
 * a deadline uses the current answer, even when it is null.
 */
async function waitForLockAsync(
  projectRoot: string,
  {
    timeoutMs,
    hasExited,
    acceptBuilding = false,
  }: { timeoutMs: number; hasExited: () => boolean; acceptBuilding?: boolean }
): Promise<DevServerLockInfo | null> {
  const deadline = Date.now() + timeoutMs;
  // A run that ends in its build lets go of its lock; its last `building` answer says it built.
  let building: DevServerLockInfo | null = null;
  for (;;) {
    const lock = await readDevServerLockAsync(projectRoot);
    if (lock?.phase === 'building') building = lock;
    // A `building` lock has no dev server yet. It ends the wait only for a caller that reports it.
    if (lock?.phase === 'building' && acceptBuilding) return lock;
    if (lock && lock.phase !== 'building') {
      const spawnedAt = Date.parse(lock.startedAt);
      if (lock.portReported || Date.now() - spawnedAt >= PORT_WATCH_TIMEOUT_MS) {
        return lock;
      }
    }
    // Checked after the read, not before: a child that started the dev server and exited in the
    // same instant still published a lock, and that lock is the answer.
    if (hasExited()) {
      return lock ?? building;
    }
    if (Date.now() + LOCK_POLL_INTERVAL_MS >= deadline) {
      return lock;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
  }
}

/** What a wait for this project's lock came to, for a run that may still build. */
type DetachedStartup =
  | { kind: 'building'; lock: DevServerLockInfo }
  | { kind: 'serving'; lock: DevServerLockInfo }
  | { kind: 'finishing'; lock: DevServerLockInfo }
  | { kind: 'build-ended'; lock: DevServerLockInfo }
  | { kind: 'unobserved' };

/**
 * Wait for this project's lock, past a run that builds.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — without --wait-ready a run
 * that builds is reported at once (`building`). With it the wait goes on, and a run still building
 * at the deadline is exit 22. A build that ended differs from a run with no observed lock.
 */
export async function waitForDetachedStartupAsync(
  projectRoot: string,
  options: DevOptions,
  startedAt: number,
  hasExited: () => boolean
): Promise<DetachedStartup> {
  const lock = await waitForLockAsync(projectRoot, {
    timeoutMs: options.detachTimeoutMs,
    hasExited,
    acceptBuilding: !options.waitReady,
  });
  if (!lock) return { kind: 'unobserved' };
  if (lock.phase !== 'building') return { kind: lock.phase, lock };
  if (hasExited() || !isProcessAlive(lock.pid)) return { kind: 'build-ended', lock };
  if (options.waitReady) throw stillBuildingOnLockError(lock, options, Date.now() - startedAt);
  return { kind: 'building', lock };
}
