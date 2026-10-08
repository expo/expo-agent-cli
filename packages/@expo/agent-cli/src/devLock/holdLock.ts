// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// The dev-server wrapper's half of the lock: resolve the port, publish it, hold it, report it.

import * as Log from '../log';
import { PROGRAM_NAME } from '../programName';
import { lockAddressFor } from './address';
import { debugEvent, event } from './events';
import {
  readPortArg,
  resolveDevServerPortAsync,
  type ResolveDevServerPortOptions,
  type ResolvedDevServerPort,
} from './port';
import { acquireDevServerLockAsync } from './server';
import type { DevServerLockHandle, DevServerLockInfo } from './types';

export type HoldDevServerLockOptions = ResolveDevServerPortOptions & {
  /** What {@link claimDevServerLockAsync} took before the spawn, used instead of publishing again. */
  claim?: DevServerLockClaim;
};

/** What taking the lock before the spawn found. */
export type DevServerLockClaim =
  /** `lock` is null when publishing failed, which the dev server does not depend on. */
  | { status: 'held'; lock: DevServerLockHandle | null }
  /** Another live process of this project holds the lock, and `holder` is what it answered. */
  | { status: 'in-use'; holder: DevServerLockInfo }
  /** The arguments name no port, so the lock waits for the dev server to report one. */
  | { status: 'unclaimed' };

/**
 * Take the lock before the dev server is spawned, when the arguments name its port.
 *
 * The lock address is derived from the project, so a holder that answers is a live dev server of
 * this project. A second one could not hold the lock, so no `status`, `dev:stop` or reuse could
 * find it: `dev` does not spawn it, and the plain `start` wrapper spawns it without a lock. A
 * holder that does not answer, or that is this process (a Windows pipe still closing after a retry
 * released it), is not that evidence. Every other failure is `held` with no lock, because the lock
 * is a convenience and the dev server is the command.
 */
export async function claimDevServerLockAsync(
  projectRoot: string,
  args: string[],
  options: Pick<HoldDevServerLockOptions, 'since'>
): Promise<DevServerLockClaim> {
  const named = readPortArg(args);
  if (named == null) {
    return { status: 'unclaimed' };
  }
  const claim = await publishAsync(projectRoot, args, options, { port: named, source: 'arg' });
  if (claim.status === 'in-use' && claim.holder != null && claim.holder.pid !== process.pid) {
    return { status: 'in-use', holder: claim.holder };
  }
  return claim.status === 'held' ? claim : { status: 'held', lock: null };
}

/**
 * Publish where this project's dev server listens, and hold the address until it is released.
 *
 * When the arguments name a port, the lock is published at the spawn with `source: 'arg'`, or
 * taken just before it by {@link claimDevServerLockAsync} and passed in as `claim`: `dev`
 * passes `--port` on every step that serves, and the Expo CLI either binds that port or exits. The
 * log watch goes on, so `onResolved` is told again with `source: 'log'` when Metro reports, and a
 * logged port that differs from the named one updates the lock's answer. With no port in the
 * arguments, the lock waits for the log, or for the watch to give up.
 *
 * Best effort by contract: the dev server is the product and the lock is a convenience, so every
 * failure resolves to `null` and the caller has nothing to handle. A caller still has to call
 * `release()` on what it gets, which the wrapper does in its `finally`.
 *
 * @returns the held lock, or null when none was taken.
 */
export async function holdDevServerLockAsync(
  projectRoot: string,
  args: string[],
  options: HoldDevServerLockOptions
): Promise<DevServerLockHandle | null> {
  const named = readPortArg(args);
  if (named == null) {
    const claim = await publishAsync(
      projectRoot,
      args,
      options,
      await resolveDevServerPortAsync(projectRoot, args, options)
    );
    // The dev server already runs here, so a live holder is reported on the event stream only.
    return claim.status === 'held' ? claim.lock : null;
  }

  const resolved: ResolvedDevServerPort = { port: named, source: 'arg' };
  options.onResolved?.(resolved);
  const claim =
    options.claim?.status === 'held'
      ? options.claim
      : await publishAsync(projectRoot, args, options, resolved);
  const lock = claim.status === 'held' ? claim.lock : null;
  const watched = await resolveDevServerPortAsync(projectRoot, args, {
    ...options,
    onResolved: undefined,
  });
  if (watched.source === 'log') {
    options.onResolved?.(watched);
    if (watched.port !== named) {
      lock?.update(lockInfo(projectRoot, args, options, watched.port));
    }
  }
  return lock;
}

/** The lock's answer for a dev server on `port`. */
function lockInfo(
  projectRoot: string,
  args: string[],
  options: HoldDevServerLockOptions,
  port: number
): DevServerLockInfo {
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    pid: process.pid,
    startedAt: new Date(options.since).toISOString(),
    projectRoot,
    args,
  };
}

/** Take the lock for a dev server on the resolved port. */
async function publishAsync(
  projectRoot: string,
  args: string[],
  options: Pick<HoldDevServerLockOptions, 'since' | 'isRunning'>,
  { port, source }: ResolvedDevServerPort
): Promise<
  | Extract<DevServerLockClaim, { status: 'held' }>
  | { status: 'in-use'; holder: DevServerLockInfo | null }
> {
  const none = { status: 'held', lock: null } as const;
  // Derived once, inside the try, so the catch below has an address to report without being able
  // to fail deriving one — a `catch` that can throw is not a safety net.
  let address = '';
  try {
    address = lockAddressFor(projectRoot).address;

    if (options.isRunning?.() === false) {
      // The dev server exited before it said where it listens, so there is nothing to point at.
      debugEvent('dev_lock_skipped', { address, reason: 'dev-server-exited' });
      return none;
    }

    const result = await acquireDevServerLockAsync(lockInfo(projectRoot, args, options, port));

    switch (result.status) {
      case 'acquired': {
        if (result.lock.replacedStale) {
          event('dev_lock_zombie_replaced', { address: result.lock.address });
        }
        event('dev_lock_acquired', {
          address: result.lock.address,
          url: `http://127.0.0.1:${port}`,
          port,
          portSource: source,
          pid: process.pid,
        });
        return { status: 'held', lock: result.lock };
      }

      case 'in-use':
        // Two dev servers for one project is a thing people do on purpose with the plain `start`
        // wrapper, and `expo start` says which port it took, so the event is all that is said: a
        // warning would land in the middle of the bundler's output. `dev` stops on this before
        // its serving step spawns, because it keeps one dev server per project.
        event('dev_lock_skipped', {
          address: result.address,
          reason: 'in-use',
          holderUrl: result.holder?.url ?? null,
          holderPid: result.holder?.pid ?? null,
        });
        return { status: 'in-use', holder: result.holder };

      case 'failed':
        event('dev_lock_skipped', {
          address: result.address,
          reason: 'error',
          error: debugEvent.error(result.error),
        });
        Log.warn(
          `Could not publish the dev server port for this project (${result.error.message}). The dev server is unaffected; other ${PROGRAM_NAME} commands may have to scan for its port. Pass --dev-server-url to name it instead.`
        );
        return none;
    }
  } catch (error: unknown) {
    // The lock must never be the reason a dev server run reports a problem.
    debugEvent('dev_lock_skipped', {
      address,
      reason: 'error',
      error: debugEvent.error(error as Error),
    });
    return none;
  }
}
