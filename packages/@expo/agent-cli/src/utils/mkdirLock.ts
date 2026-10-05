// @ref llp/0021-honest-reports.rfc.md §How they show up
// A machine-wide lock made of one directory, for the runner warm-up (`./runnerLock.ts`).
//
// `mkdir` is the lock because it is atomic on every platform and fails when the directory exists.
// The holder writes a token into it, so a holder whose stale lock was taken over never removes the
// lock of the holder after it.

import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

const LOCK_OWNER_FILE = 'owner';
const LOCK_RETRY_MIN_MS = 10;
const LOCK_RETRY_MAX_MS = 250;

export interface MkdirLockOptions {
  /** A lock this old has a dead holder. */
  staleMs: number;
  /** A live holder refreshes the lock's mtime this often, so it never looks stale. */
  heartbeatMs: number;
  now?: () => number;
  /** Stop waiting at this time (epoch ms). Unbounded when omitted. */
  deadline?: number;
  onStaleRemoved?: (ageMs: number) => void;
  onLost?: (reason: string) => void;
}

/** A held lock. `release` is idempotent. */
export interface MkdirLock {
  release(): void;
}

/**
 * Take the lock at `lock`, waiting for its holder.
 *
 * @returns the lock, or null when {@link MkdirLockOptions.deadline} passed first.
 */
export async function acquireMkdirLockAsync(
  lock: string,
  { staleMs, heartbeatMs, now = Date.now, deadline, onStaleRemoved, onLost }: MkdirLockOptions
): Promise<MkdirLock | null> {
  const owner = path.join(lock, LOCK_OWNER_FILE);
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  let delay = LOCK_RETRY_MIN_MS;
  while (!tryMkdir(lock)) {
    if (takeOverStaleLock(lock, now(), staleMs, onStaleRemoved)) {
      continue;
    }
    if (deadline != null && now() >= deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
  }
  fs.writeFileSync(owner, token);

  let lost = false;
  const loseLock = (reason: string) => {
    if (!lost) {
      lost = true;
      onLost?.(reason);
    }
  };
  const heartbeat = setInterval(() => {
    if (lost) {
      return;
    }
    try {
      if (fs.readFileSync(owner, 'utf8') !== token) {
        loseLock('another holder took the lock over');
        return;
      }
      const seconds = now() / 1000;
      fs.utimesSync(lock, seconds, seconds);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        loseLock('the lock was removed');
      }
    }
  }, heartbeatMs);
  heartbeat.unref();

  let released = false;
  return {
    release() {
      if (released) {
        return;
      }
      released = true;
      clearInterval(heartbeat);
      if (readLockOwner(owner) === token) {
        fs.rmSync(lock, { recursive: true, force: true });
      }
    },
  };
}

function readLockOwner(owner: string): string | null {
  try {
    return fs.readFileSync(owner, 'utf8');
  } catch {
    return null;
  }
}

function lockAgeMs(directory: string, now: number): number | null {
  try {
    return now - fs.statSync(directory).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Remove the lock when it is older than the limit, so its holder is taken as dead.
 *
 * Only the waiter that holds the takeover guard may judge and remove the lock. Without it, a
 * waiter that saw the stale lock late would remove the fresh lock a faster waiter made in its
 * place. The lock is renamed aside before it is removed, so it vanishes in one step.
 *
 * @returns true when the caller may try `mkdir` again at once.
 */
function takeOverStaleLock(
  lock: string,
  now: number,
  staleMs: number,
  onStaleRemoved: ((ageMs: number) => void) | undefined
): boolean {
  const lockAge = lockAgeMs(lock, now);
  if (lockAge == null) {
    return true;
  }
  if (lockAge <= staleMs) {
    return false;
  }
  const guard = `${lock}.takeover`;
  if (!tryMkdir(guard)) {
    // A guard is held for one stat and one rename; one this old has a dead holder.
    const guardAge = lockAgeMs(guard, now);
    if (guardAge != null && guardAge > staleMs) {
      fs.rmSync(guard, { recursive: true, force: true });
      return true;
    }
    return false;
  }
  try {
    const ageMs = lockAgeMs(lock, now);
    if (ageMs == null || ageMs <= staleMs) {
      return true;
    }
    const aside = `${lock}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(lock, aside);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return true;
      }
      throw error;
    }
    fs.rmSync(aside, { recursive: true, force: true });
    onStaleRemoved?.(ageMs);
    return true;
  } finally {
    fs.rmSync(guard, { recursive: true, force: true });
  }
}

function tryMkdir(directory: string): boolean {
  try {
    fs.mkdirSync(directory);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}
