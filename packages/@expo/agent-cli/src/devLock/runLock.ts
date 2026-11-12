// @ref llp/0004-smart-start-and-project-state.rfc.md §Dev-server lock — the one writer of a run's lock.

import * as Log from '../log';
import type { EasOpenEvidence } from '../dev/devRunTypes';
import { PROGRAM_NAME } from '../programName';
import { lockAddressOrEmpty } from './address';
import { debugEvent, event } from './events';
import { isHeld, nextRunState, type HeldRunState, type RunEvent, type RunState } from './runState';
import { acquireDevServerLockAsync } from './server';
import type { DevServerLockHandle, DevServerLockInfo } from './types';

type Published = Extract<RunEvent, { type: 'published' }>;

/**
 * A run's dev-server lock. Every change goes through {@link nextRunState}; this class does the
 * socket work the new state needs: take, answer, or release. Only a take is async, so
 * `published` has its own entry, {@link RunLock.publishAsync}.
 *
 * Best effort by contract: the dev server is the product and the lock is a convenience, so no
 * method throws, and an illegal event changes nothing.
 */
export class RunLock {
  readonly #projectRoot: string;
  #state: RunState = { phase: 'unlocked' };
  #handle: DevServerLockHandle | null = null;

  constructor(
    projectRoot: string,
    private readonly easOpen?: () => EasOpenEvidence
  ) {
    this.#projectRoot = projectRoot;
  }

  get state(): RunState {
    return this.#state;
  }

  /** The `published` event. Takes the lock first when the run holds none. */
  async publishAsync(published: Published): Promise<void> {
    const next = nextRunState(this.#state, published);
    if (this.#handle || !next || !isHeld(next)) return this.#commit(published);
    const handle = await acquireAsync(
      this.#projectRoot,
      lockInfo(this.#projectRoot, next),
      published.source,
      (info) => projectOpen(info, this.easOpen?.())
    );
    if (!handle) return;
    // The run ended while the take ran: the lock has nothing left to answer for.
    if (this.#state.phase === 'released') return handle.release();
    // A run that ended while the take ran keeps no socket.
    const now = nextRunState(this.#state, published);
    if (!now || !isHeld(now)) {
      handle.release();
      return this.#commit(published);
    }
    this.#handle = handle;
    this.#commit(published);
  }

  /**
   * Record the pid found listening on `port` (`./runRecord`). Nothing when no lock is held, or
   * when the lock answers for another port by now.
   */
  noteServerPid(port: number, serverPid: number): void {
    this.#handle?.noteServerPid(port, serverPid);
  }

  /** Every event but a take. */
  apply(runEvent: Exclude<RunEvent, Published>): void {
    this.#commit(runEvent);
  }

  #commit(runEvent: RunEvent): void {
    const from = this.#state;
    const next = nextRunState(from, runEvent);
    if (!next) {
      debugEvent('dev_lock_illegal_transition', { phase: from.phase, event: runEvent.type });
      return;
    }
    this.#state = next;
    if (runEvent.type === 'foreign-port' && next.phase === 'unlocked') {
      // The only port left to name is another project's dev server, and publishing it would
      // point every command of this project at that project.
      event('dev_lock_skipped', {
        address: lockAddressOrEmpty(this.#projectRoot),
        reason: 'foreign-port',
      });
    }
    const handle = this.#handle;
    if (!handle) return;
    if (isHeld(next)) {
      handle.update(lockInfo(this.#projectRoot, next));
    } else {
      this.#handle = null;
      handle.release();
    }
  }
}

/**
 * Run `run` with a lock of its own, and release that lock when `run` settles.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §Dev-server lock — the lock belongs to the
 * run, from its first step to its end.
 */
export async function withRunLockAsync<T>(
  projectRoot: string,
  run: (lock: RunLock) => Promise<T>,
  easOpen?: () => EasOpenEvidence
): Promise<T> {
  const lock = new RunLock(projectRoot, easOpen);
  try {
    return await run(lock);
  } finally {
    lock.apply({ type: 'run-ended' });
  }
}

/** What the lock answers in a held state. */
function lockInfo(projectRoot: string, state: HeldRunState): DevServerLockInfo {
  return {
    url: `http://127.0.0.1:${state.port}`,
    port: state.port,
    portReported: state.source === 'reported',
    pid: process.pid,
    startedAt: new Date(state.since).toISOString(),
    projectRoot,
    easPlatform: state.easPlatform,
    easOpenFinished: false,
    phase: state.phase,
  };
}

/** Take the lock for a dev server on the published port. Null when it cannot be taken. */
async function acquireAsync(
  projectRoot: string,
  info: DevServerLockInfo,
  source: Published['source'],
  project: (info: DevServerLockInfo) => DevServerLockInfo
): Promise<DevServerLockHandle | null> {
  const address = lockAddressOrEmpty(projectRoot);
  try {
    const result = await acquireDevServerLockAsync(info, project);
    switch (result.status) {
      case 'acquired': {
        if (result.lock.replacedStale) {
          event('dev_lock_zombie_replaced', { address: result.lock.address });
        }
        event('dev_lock_acquired', {
          address: result.lock.address,
          url: info.url,
          port: info.port,
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

function projectOpen(
  info: DevServerLockInfo,
  open: EasOpenEvidence | undefined
): DevServerLockInfo {
  if (!info.easPlatform || !open) return info;
  return {
    ...info,
    easOpenFinished: open.kind === 'settled' && open.accounted,
    phase: open.kind === 'pending' && open.metroExited ? 'finishing' : info.phase,
  };
}
