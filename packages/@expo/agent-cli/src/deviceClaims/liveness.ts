// @ref llp/0030-one-device-per-agent.rfc.md §The registry

import fs from 'fs';
import path from 'path';

import { readDevServerLockAsync } from '../devLock';
import type { ClaimLiveness, DeviceClaim } from './types';

/** Covers a worktree whose `dev` stopped while its agent still navigates or takes screenshots. */
export const CLAIM_GRACE_MS = 10 * 60_000;

/** A touch further ahead than this is a wrong clock or a hand edit, and keeps no claim live. */
const FUTURE_TOUCH_MS = 60_000;

/**
 * The worktree was deleted: its directory is gone, its parent is still there, and its dev-server
 * lock does not answer. A missing parent is an unmounted volume, not a deleted worktree.
 *
 * @ref llp/0030-one-device-per-agent.rfc.md §Release and cleanup
 */
export async function isDeletedWorktreeAsync(
  projectRoot: string,
  probeLock: (projectRoot: string) => Promise<unknown> = readDevServerLockAsync
): Promise<boolean> {
  return (
    !fs.existsSync(projectRoot) &&
    fs.existsSync(path.dirname(projectRoot)) &&
    (await probeLock(projectRoot)) == null
  );
}

export async function classifyClaimAsync(
  claim: DeviceClaim,
  {
    now = new Date(),
    probeLock = readDevServerLockAsync,
  }: { now?: Date; probeLock?: (projectRoot: string) => Promise<unknown> } = {}
): Promise<ClaimLiveness> {
  // The grace period does not apply to a deleted worktree: the next claim reaps its claims.
  if (await isDeletedWorktreeAsync(claim.projectRoot, probeLock)) {
    return 'stale';
  }
  // The touch is checked first only because it costs no connection; the socket is the proof.
  const sinceTouchMs = now.getTime() - Date.parse(claim.touchedAt);
  if (sinceTouchMs < CLAIM_GRACE_MS && sinceTouchMs > -FUTURE_TOUCH_MS) {
    return 'live';
  }
  return (await probeLock(claim.projectRoot)) != null ? 'live' : 'stale';
}
