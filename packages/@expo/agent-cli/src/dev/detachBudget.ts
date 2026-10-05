// @ref llp/0026-dev-owns-the-open.rfc.md §The detach budget follows the plan
// How long `dev --detach` waits for its child, decided by the plan the child runs.
//
// A fixed 120 s gave up on a run that was succeeding: the child was in `pod install`, and later
// built, started Metro, published its lock and opened the app [observed — live, 2026-10-05]. A plan
// with a build step therefore keeps waiting after the base budget, while the child is alive and its
// log keeps growing, up to a ceiling. A plan that only serves keeps the base budget.

import fs from 'fs';

import type { DevServerLockInfo } from '../devLock';
import { parsePlanBuildsNative } from './childVerdict';
import { detachedLogPath, readDetachedLogSync } from './logFile';

export interface DetachWaitPolicy {
  /** How long every run may take. */
  baseMs: number;
  /** How long a run whose plan builds may take, while its log grows. */
  ceilingMs: number;
  /** How long a building run's log may stay the same size before the wait gives up on it. */
  stallMs: number;
  /** How often a waiting run reports what its child printed last. */
  progressEveryMs: number;
}

/** A building run's log may be quiet this long: `pod install` and a link step print little. */
export const DETACH_STALL_MS = 5 * 60_000;

export const DETACH_PROGRESS_EVERY_MS = 15_000;

/** `wait`, or why the wait is over while the child is still alive. */
export type DetachWaitVerdict = 'wait' | 'timeout' | 'stalled' | 'ceiling';

/** The wait's decision for one moment. Pure, so every boundary is a row in a test table. */
export function judgeDetachWait(
  {
    elapsedMs,
    buildsNative,
    quietMs,
  }: { elapsedMs: number; buildsNative: boolean; quietMs: number },
  { baseMs, ceilingMs, stallMs }: DetachWaitPolicy
): DetachWaitVerdict {
  if (elapsedMs < baseMs) {
    return 'wait';
  }
  if (!buildsNative) {
    return 'timeout';
  }
  if (elapsedMs >= ceilingMs) {
    return 'ceiling';
  }
  return quietMs >= stallMs ? 'stalled' : 'wait';
}

/** The three reads the budget takes of the child's log. */
export interface DetachLogView {
  sizeBytes(): number | null;
  lines(): string[] | null;
  lastLine(): string | null;
}

/** The log of this project's detached run, read from disk. */
export function detachedLogView(projectRoot: string): DetachLogView {
  return {
    sizeBytes() {
      try {
        return fs.statSync(detachedLogPath(projectRoot)).size;
      } catch {
        return null;
      }
    },
    lines: () => readDetachedLogSync(projectRoot, Number.MAX_SAFE_INTEGER)?.lines ?? null,
    lastLine: () => readDetachedLogSync(projectRoot, 1)?.lines[0] ?? null,
  };
}

export interface DetachProgress {
  elapsedMs: number;
  lastLine: string | null;
}

export interface DetachBudget {
  /** Read the log, report progress when it is due, and judge. */
  check(): DetachWaitVerdict;
  /** What is left of the budget this run has: the ceiling for a plan that builds, else the base. */
  remainingMs(): number;
  buildsNative(): boolean;
}

export function createDetachBudget({
  policy,
  startedAt,
  log,
  now = Date.now,
  onProgress,
}: {
  policy: DetachWaitPolicy;
  startedAt: number;
  log: DetachLogView;
  now?: () => number;
  onProgress?: (progress: DetachProgress) => void;
}): DetachBudget {
  let buildsNative = false;
  let lastSize: number | null = null;
  let grewAt = startedAt;
  let progressAt = startedAt;

  return {
    check() {
      const at = now();
      const size = log.sizeBytes();
      if (size !== lastSize) {
        lastSize = size;
        grewAt = at;
        // Only `true` is kept: a read can land while the plan table is half written.
        buildsNative ||= parsePlanBuildsNative(log.lines() ?? []) === true;
      }
      if (onProgress && at - progressAt >= policy.progressEveryMs) {
        progressAt = at;
        onProgress({ elapsedMs: at - startedAt, lastLine: log.lastLine() });
      }
      return judgeDetachWait(
        { elapsedMs: at - startedAt, buildsNative, quietMs: at - grewAt },
        policy
      );
    },
    remainingMs() {
      const limit = buildsNative ? Math.max(policy.baseMs, policy.ceilingMs) : policy.baseMs;
      return limit - (now() - startedAt);
    },
    buildsNative: () => buildsNative,
  };
}

/**
 * Poll the project's lock until it answers, the child exits, or the budget says stop.
 *
 * @returns the lock, or null with the verdict that ended the wait (`wait` when the child exited).
 */
export async function waitForLockAsync({
  readLock,
  hasExited,
  verdict,
  pollMs,
}: {
  readLock: () => Promise<DevServerLockInfo | null>;
  hasExited: () => boolean;
  verdict: () => DetachWaitVerdict;
  pollMs: number;
}): Promise<{ lock: DevServerLockInfo | null; verdict: DetachWaitVerdict }> {
  for (;;) {
    const lock = await readLock();
    if (lock) {
      return { lock, verdict: 'wait' };
    }
    // Checked after the read, not before: a child that started the dev server and exited in the
    // same instant still published a lock, and that lock is the answer.
    if (hasExited()) {
      return { lock: null, verdict: 'wait' };
    }
    const judged = verdict();
    if (judged !== 'wait') {
      return { lock: null, verdict: judged };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
