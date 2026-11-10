// @ref llp/0004-smart-start-and-project-state.rfc.md §Dev-server lock — the transition table.
// What the run's lock says after each event. Pure: the writer (`RunLock`) does the socket work.

import type { ResolvedDevServerPort } from './port';
import type { DevServerLockInfo, DevServerLockPhase } from './types';

/** The run's EAS open: not started, running, or returned (bound or failed). */
export type OpenState = 'none' | 'running' | 'returned';

export type RunState =
  /** The run holds no lock: before the take, after a foreign port, or when the take failed. */
  | { phase: 'unlocked'; open: OpenState }
  /** The phase the lock answers. */
  | { phase: DevServerLockPhase; open: OpenState }
  /** The run ended and let go of its lock. Nothing moves it again. */
  | { phase: 'released' };

export type RunEvent =
  /** The run holds a lock for a step: the take before a build, a dev-server spawn, a port retry. */
  | {
      type: 'published';
      phase: 'building' | 'serving';
      port: number;
      source: ResolvedDevServerPort['source'];
      since: number;
      easPlatform: DevServerLockInfo['easPlatform'];
    }
  /** The step's only port to name is another project's dev server. */
  | { type: 'foreign-port' }
  /** Metro reported the port it listens on. */
  | { type: 'port-reported'; port: number }
  /** `/status` answers for this project while the step runs. */
  | { type: 'status-answered' }
  | { type: 'open-started' }
  | { type: 'open-returned' }
  /** The dev-server step's child exited. */
  | { type: 'server-exited' }
  | { type: 'run-ended' };

/** The next state, or `illegal` for a pair no caller should produce. */
export type RunTransition = { state: RunState } | { illegal: true };

export function nextRunState(_state: RunState, _event: RunEvent): RunTransition {
  throw new Error('not implemented');
}
