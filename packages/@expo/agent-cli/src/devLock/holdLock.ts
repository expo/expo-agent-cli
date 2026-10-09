// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// The dev-server wrapper's half of the lock: resolve the port, publish it, hold it, report it.

import * as Log from '../log';
import { PROGRAM_NAME } from '../programName';
import { lockAddressFor } from './address';
import { debugEvent, event } from './events';
import {
  readPortArg,
  resolveDevServerPortAsync,
  servesAnotherProjectAsync,
  type ResolveDevServerPortOptions,
  type ResolvedDevServerPort,
} from './port';
import { acquireDevServerLockAsync } from './server';
import type { DevServerLockHandle, DevServerLockInfo } from './types';

export type HoldDevServerLockOptions = ResolveDevServerPortOptions;

/**
 * Publish where this project's dev server listens, and hold the address until it is released.
 *
 * When the arguments name a port, the lock is published at the spawn with `source: 'arg'`: `dev`
 * passes `--port` on every step that serves, and the Expo CLI either binds that port or exits. A
 * named port that another project's dev server already answers on is never published; the lock
 * then waits for the log, as with no port. The
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
  const servesAnotherProject =
    options.servesAnotherProject ?? ((port) => servesAnotherProjectAsync(projectRoot, port));
  if (named == null || (await servesAnotherProject(named))) {
    return await publishAsync(
      projectRoot,
      options,
      await resolveDevServerPortAsync(projectRoot, args, options)
    );
  }

  const resolved: ResolvedDevServerPort = { port: named, source: 'arg' };
  options.onResolved?.(resolved);
  const lock = await publishAsync(projectRoot, options, resolved);
  const watched = await resolveDevServerPortAsync(projectRoot, args, {
    ...options,
    onResolved: undefined,
  });
  if (watched?.source === 'log') {
    options.onResolved?.(watched);
    if (watched.port !== named) {
      lock?.update(lockInfo(projectRoot, options, watched.port));
    }
  }
  return lock;
}

/** The lock's answer for a dev server on `port`. */
function lockInfo(
  projectRoot: string,
  options: HoldDevServerLockOptions,
  port: number
): DevServerLockInfo {
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    pid: process.pid,
    startedAt: new Date(options.since).toISOString(),
    projectRoot,
  };
}

/** Take the lock for a dev server on the resolved port. */
async function publishAsync(
  projectRoot: string,
  options: Pick<HoldDevServerLockOptions, 'since' | 'isRunning'>,
  resolved: ResolvedDevServerPort | null
): Promise<DevServerLockHandle | null> {
  // Derived once, inside the try, so the catch below has an address to report without being able
  // to fail deriving one — a `catch` that can throw is not a safety net.
  let address = '';
  try {
    address = lockAddressFor(projectRoot).address;
    if (resolved == null) {
      // The only port left to name is another project's dev server, and publishing it would point
      // every command of this project at that project.
      event('dev_lock_skipped', { address, reason: 'foreign-port' });
      return null;
    }
    const { port, source } = resolved;

    if (!options.isRunning()) {
      // The dev server exited before it said where it listens, so there is nothing to point at.
      debugEvent('dev_lock_skipped', { address, reason: 'dev-server-exited' });
      return null;
    }

    const result = await acquireDevServerLockAsync(lockInfo(projectRoot, options, port));

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
        return result.lock;
      }

      case 'in-use':
        // Two dev servers for one project is a thing people do on purpose, and `expo start` says
        // which port it took, so this is reported on the event stream and nowhere else: a warning
        // here would land in the middle of the bundler's output for a situation that is fine.
        event('dev_lock_skipped', {
          address: result.address,
          reason: 'in-use',
          holderUrl: result.holder?.url ?? null,
          holderPid: result.holder?.pid ?? null,
        });
        return null;

      case 'failed':
        event('dev_lock_skipped', {
          address: result.address,
          reason: 'error',
          error: debugEvent.error(result.error),
        });
        Log.warn(
          `Could not publish the dev server port for this project (${result.error.message}). The dev server is unaffected; other ${PROGRAM_NAME} commands may have to scan for its port. Pass --dev-server-url to name it instead.`
        );
        return null;
    }
  } catch (error: unknown) {
    // The lock must never be the reason a dev server run reports a problem.
    debugEvent('dev_lock_skipped', {
      address,
      reason: 'error',
      error: debugEvent.error(error as Error),
    });
    return null;
  }
}
