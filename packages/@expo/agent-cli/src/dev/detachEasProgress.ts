// @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
// The session start of a detached `dev --eas`, as its parent sees it: it runs after the bundler
// answers, and the binding registry decides that a session is up.

import { readDevServerLockAsync, type DevServerLockInfo } from '../devLock';
import { live, readCloudBindings } from '../deviceBinding/cloud';
import { EXIT_OUTCOME_TIMEOUT } from '../exitCodes';
import * as Log from '../log';
import type { NativePlatform } from '../plan/types';
import { env } from '../utils/env';
import { CommandError } from '../utils/errors';

import { readRecoveryFactsAsync } from './readRecovery';
import { decideRecovery, renderRecovery } from './recovery';

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
    timeoutMs = env.AGENT_CLI_EAS_SESSION_WAIT_MS,
  }: {
    platform: NativePlatform;
    lock: DevServerLockInfo;
    tunnelUrl: string | null;
    since: number;
    knownId: string | null;
    hasExited: () => boolean;
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
    if (openFinished) break;
    if (Date.now() >= deadline) break;
  }

  const facts = await readRecoveryFactsAsync(projectRoot, { platform, deviceBackend: 'eas' });
  const recovery = renderRecovery(decideRecovery({ ...facts, needsStart: true }));
  const waitedS = Math.round((Date.now() - waitStarted) / 1000);
  const error = new CommandError(
    'DEV_DETACH_SESSION_PENDING',
    [
      `The dev server is up on ${lock.url}${tunnelUrl ? ` (tunnel ${tunnelUrl})` : ''}, and its EAS Simulator session is not bound after ${waitedS} s.`,
      `Why: ${recovery.why ?? 'There is no usable session binding for this platform.'}`,
      `How: run "${recovery.command}".`,
    ].join('\n')
  );
  error.exitCode = EXIT_OUTCOME_TIMEOUT;
  error.data = {
    pid: lock.pid,
    url: lock.url,
    tunnelUrl,
    platform,
    waitedMs: Date.now() - waitStarted,
    recovery: recovery.recovery,
  };
  error.suggestedCommand = recovery.command;
  throw error;
}
