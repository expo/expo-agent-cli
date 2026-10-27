// @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
// The session start of a detached `dev --eas`, as its parent sees it: it runs after the bundler
// answers, and the binding registry decides that a session is up.

import { readDevServerLockAsync, type DevServerLockInfo } from '../devLock';
import { live, readCloudBindings } from '../deviceBinding/cloud';
import { isExpired } from '../deviceBinding/lease';
import { EXIT_OUTCOME_TIMEOUT } from '../exitCodes';
import * as Log from '../log';
import { rerunDevCommand } from '../plan/rerun';
import type { NativePlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import { env } from '../utils/env';
import { CommandError } from '../utils/errors';
import { parseDetachedChildPid } from './childVerdict';
import { detachedLogPath, readDetachedLogFileSync } from './logFile';
import { EAS_SESSION_START_TIMEOUT_MS, EAS_TUNNEL_WAIT_MS } from './easSession';
import { isProcessAlive } from './processLiveness';

const WHOLE_LOG = Number.MAX_SAFE_INTEGER;

/** How often the binding registry is read while the session starts. */
const EAS_SESSION_POLL_MS = 1_000;

/**
 * The id of this run's live session binding for the platform: one bound at or after `since`, or
 * `knownId`, the binding that was live before the run and that the child reused. The caller passes
 * `knownId` only after the child's open finished: before that, the child may still find it ended.
 */
function boundSessionIdSync(
  projectRoot: string,
  platform: NativePlatform,
  { since, knownId }: { since: number; knownId: string | null }
): string | null {
  const binding = live(readCloudBindings(projectRoot).bindings, new Date()).find(
    ({ device, boundAt }) =>
      device.platform === platform && (Date.parse(boundAt) >= since || device.id === knownId)
  );
  return binding?.device.id ?? null;
}

/**
 * The id of this worktree's cloud binding for the platform at any age, expired or not: the session
 * a child's open reuses, and renews in place when its lease ended. The wait takes it as `knownId`.
 */
export function knownSessionIdSync(projectRoot: string, platform: NativePlatform): string | null {
  const binding = readCloudBindings(projectRoot).bindings.find(
    ({ device }) => device.platform === platform
  );
  return binding?.device.id ?? null;
}

/**
 * Whether the detached child that holds this lock is still starting its session, so a re-run
 * follows it instead of reopening: its lock names the platform and does not say that its EAS open
 * finished, line 1 of the log names its pid, it is alive and inside its start window, and no
 * binding of the platform is live or made since its lock. A finished open, bound or failed, ends
 * the start, also when its binding file is gone: the reopen binds the session again. A binding
 * that the child made ends the start, also when its lease expired: the reopen renews it. The lock
 * of an older child names no flag, so the other checks decide.
 */
export function childStartsSessionSync(
  projectRoot: string,
  lock: DevServerLockInfo,
  platform: NativePlatform,
  logFile = detachedLogPath(projectRoot)
): boolean {
  if (lock.easPlatform !== platform || lock.easOpenFinished) return false;
  // The child's own bounds: the tunnel wait, then the session start.
  const startWindowMs = EAS_TUNNEL_WAIT_MS + EAS_SESSION_START_TIMEOUT_MS;
  if (Date.now() - Date.parse(lock.startedAt) >= startWindowMs) return false;
  const log = readDetachedLogFileSync(logFile, WHOLE_LOG);
  if (log == null || parseDetachedChildPid(log.lines) !== lock.pid || !isProcessAlive(lock.pid)) {
    return false;
  }
  const now = new Date();
  const since = Date.parse(lock.startedAt);
  return !readCloudBindings(projectRoot).bindings.some(
    (binding) =>
      binding.device.platform === platform &&
      (!isExpired(binding, now) || Date.parse(binding.boundAt) >= since)
  );
}

/**
 * Wait for the child's session binding.
 *
 * @returns the session id, or null when the child is gone: the caller reports the child's failure.
 * @throws {CommandError} `DEV_DETACH_SESSION_PENDING`, exit 22, when the budget runs out.
 */
export async function waitForEasSessionAsync(
  projectRoot: string,
  {
    platform,
    lock,
    tunnelUrl,
    since,
    knownId,
    hasExited,
    callerArgv,
    timeoutMs = env.AGENT_CLI_EAS_SESSION_WAIT_MS,
  }: {
    platform: NativePlatform;
    lock: DevServerLockInfo;
    tunnelUrl: string | null;
    since: number;
    knownId: string | null;
    hasExited: () => boolean;
    callerArgv: readonly string[];
    timeoutMs?: number;
  }
): Promise<string | null> {
  // The kept binding counts once the child's lock says its open finished, bound or failed.
  const check = async () => {
    const current = await readDevServerLockAsync(projectRoot);
    const openFinished = current?.pid === lock.pid && current.easOpenFinished === true;
    const id = boundSessionIdSync(projectRoot, platform, {
      since,
      knownId: openFinished ? knownId : null,
    });
    return { id, openFinished };
  };
  const first = boundSessionIdSync(projectRoot, platform, { since, knownId: null });
  if (first) return first;

  const waitStarted = Date.now();
  const deadline = waitStarted + timeoutMs;
  Log.progress(
    `Waiting up to ${Math.round(timeoutMs / 1000)} s for the EAS Simulator session of the detached run (pid ${lock.pid}). A start takes a few minutes.`
  );
  let openReturned = false;
  for (;;) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Math.min(EAS_SESSION_POLL_MS, deadline - Date.now())))
    );
    // The child binds inside its open, before it sets the flag: a finished open without a binding
    // binds none later.
    const { id, openFinished } = await check();
    if (id) {
      Log.progress(`EAS Simulator session ${id} is bound to this worktree.`);
      return id;
    }
    if (hasExited()) return null;
    if (openFinished) {
      openReturned = true;
      break;
    }
    if (Date.now() >= deadline) break;
  }

  const rerun = rerunDevCommand(platform, callerArgv);
  const waitedS = Math.round((Date.now() - waitStarted) / 1000);
  const error = new CommandError(
    'DEV_DETACH_SESSION_PENDING',
    [
      `The dev server is up on ${lock.url}${tunnelUrl ? ` (tunnel ${tunnelUrl})` : ''}, and its EAS Simulator session is not bound after ${waitedS} s.`,
      ...(openReturned
        ? [
            `Why: the open of the detached run (pid ${lock.pid}) already returned without a session binding, so that run binds none later.`,
            `How: inspect "${PROGRAM_PREFIX} dev:logs", then run "${PROGRAM_PREFIX} dev:stop" followed by "${rerun}" to bind the session. Plain dev:stop preserves existing sessions; "${PROGRAM_PREFIX} dev:stop --eas" ends them.`,
          ]
        : [
            `Why: the detached run (pid ${lock.pid}) starts the session after the dev server, and a start takes a few minutes. The run keeps going and binds the session to this worktree when it is up. The session bills from its start.`,
            `How: read "${PROGRAM_PREFIX} dev:logs" and check "${PROGRAM_PREFIX} status" for progress. The original run continues. "${PROGRAM_PREFIX} dev:stop --eas" stops the dev server and the session.`,
          ]),
    ].join('\n')
  );
  error.exitCode = EXIT_OUTCOME_TIMEOUT;
  error.data = {
    pid: lock.pid,
    url: lock.url,
    tunnelUrl,
    platform,
    waitedMs: Date.now() - waitStarted,
  };
  error.suggestedCommand = openReturned
    ? `${PROGRAM_PREFIX} dev:stop`
    : `${PROGRAM_PREFIX} dev:logs`;
  throw error;
}
