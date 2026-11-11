// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// Where a run's lock points: resolve a step's port, publish it on the run's lock, follow Metro's report.

import { lockAddressOrEmpty } from './address';
import { debugEvent } from './events';
import {
  readPortArg,
  resolveDevServerPortAsync,
  servesAnotherProjectAsync,
  type ResolveDevServerPortOptions,
  type ResolvedDevServerPort,
} from './port';
import type { RunLock } from './runLock';
import { isHeld } from './runState';
import type { DevServerLockInfo } from './types';

export type PublishDevServerPortOptions = ResolveDevServerPortOptions & {
  /** The run's lock. The step publishes on it and leaves the release to the run. */
  lock: RunLock;
  /** {@link DevServerLockInfo.easPlatform}; null when omitted. */
  easPlatform?: DevServerLockInfo['easPlatform'];
  /** What the lock answers at the spawn: `building` for a step that compiles before it serves. */
  phase: 'building' | 'serving';
};

/**
 * Publish where this project's dev server listens on the run's lock, and follow Metro's report.
 *
 * When the arguments name a port, the lock is published at the spawn with `source: 'arg'`: `dev`
 * passes `--port` on every step that serves, and the Expo CLI either binds that port or exits. A
 * named port that another project's dev server already answers on is never published; the lock
 * then waits for Metro's report, as with no port. The watch goes on for as long as the dev server
 * runs, so `onResolved` is told again with `source: 'reported'` when Metro reports, and the
 * lock then answers with the reported port and `portReported: true`. With no port in the
 * arguments, the lock waits for the report, or for the watch to give up.
 *
 * Best effort by contract: never rejects, and the run's lock swallows every failure.
 */
export async function publishDevServerPortAsync(
  projectRoot: string,
  args: string[],
  options: PublishDevServerPortOptions
): Promise<void> {
  const publishAsync = async (resolved: ResolvedDevServerPort | null) => {
    if (resolved == null) return options.lock.apply({ type: 'foreign-port' });
    if (!options.isRunning()) {
      // The dev server exited before it said where it listens, so there is nothing to point at.
      if (!isHeld(options.lock.state)) {
        debugEvent('dev_lock_skipped', {
          address: lockAddressOrEmpty(projectRoot),
          reason: 'dev-server-exited',
        });
      }
      return;
    }
    await options.lock.publishAsync({
      type: 'published',
      phase: options.phase,
      port: resolved.port,
      source: resolved.source,
      since: options.since,
      easPlatform: options.easPlatform ?? null,
    });
  };

  const named = readPortArg(args);
  const servesAnotherProject =
    options.servesAnotherProject ?? ((port) => servesAnotherProjectAsync(projectRoot, port));
  if (named == null || (await servesAnotherProject(named))) {
    return await publishAsync(await resolveDevServerPortAsync(projectRoot, args, options));
  }

  const resolved: ResolvedDevServerPort = { port: named, source: 'arg' };
  options.onResolved?.(resolved);
  await publishAsync(resolved);
  // The lock already answers, so nothing waits on this watch: it follows the dev server for as long
  // as it runs, and Metro's report after a long `expo run:*` build still counts.
  const watched = await resolveDevServerPortAsync(projectRoot, args, {
    ...options,
    onResolved: undefined,
    timeoutMs: Infinity,
  });
  if (watched?.source === 'reported') {
    options.onResolved?.(watched);
    options.lock.apply({ type: 'port-reported', port: watched.port });
  }
}

/**
 * Take the run's lock with phase `building` on the port the plan will serve on, before a build
 * step. Nothing is taken when another project's dev server answers on that port: the dev-server
 * step then publishes what it finds.
 */
export async function publishPlannedPortAsync(
  lock: RunLock,
  projectRoot: string,
  port: number,
  easPlatform: DevServerLockInfo['easPlatform']
): Promise<void> {
  if (await servesAnotherProjectAsync(projectRoot, port)) return;
  await lock.publishAsync({
    type: 'published',
    phase: 'building',
    port,
    source: 'arg',
    since: Date.now(),
    easPlatform,
  });
}
