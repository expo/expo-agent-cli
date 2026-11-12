// @ref llp/0004-smart-start-and-project-state.rfc.md §Dev-server lock — the transition table.
// What the run's lock says after each event. Pure: the writer (`RunLock`) does the socket work.

import type { ResolvedDevServerPort } from './port';
import type { DevServerLockInfo } from './types';

/** Where the lock points: the last `published` port, or the port Metro reported since. */
export interface LockPort {
  port: number;
  source: ResolvedDevServerPort['source'];
  since: number;
  easPlatform: DevServerLockInfo['easPlatform'];
}

/** A state in which the run holds the lock; its phase is the one the lock answers. */
export type HeldRunState = LockPort & { phase: 'building' | 'serving' };

export type RunState =
  /** The run holds no lock: before the take, after a foreign port, or when the take failed. */
  | { phase: 'unlocked' }
  | HeldRunState
  /** The run ended and let go of its lock. Nothing moves it again. */
  | { phase: 'released' };

export type RunEvent =
  /** The run holds a lock for a step: the take before a build, a dev-server spawn, a port retry. */
  | ({ type: 'published'; phase: 'building' | 'serving' } & LockPort)
  /** The step's only port to name is another project's dev server. */
  | { type: 'foreign-port' }
  /** Metro reported the port it listens on. */
  | { type: 'port-reported'; port: number }
  /** `/status` answers for this project while the step runs. */
  | { type: 'status-answered' }
  | { type: 'run-ended' };

export function isHeld(state: RunState): state is HeldRunState {
  return state.phase !== 'unlocked' && state.phase !== 'released';
}

/** The next state, or null for an illegal pair: one that no caller should produce. */
export function nextRunState(state: RunState, event: RunEvent): RunState | null {
  if (state.phase === 'released') return event.type === 'published' ? null : state;
  switch (event.type) {
    case 'published': {
      const { type: _, ...published } = event;
      return published;
    }
    case 'foreign-port':
      return { phase: 'unlocked' };
    case 'port-reported':
      return isHeld(state) ? { ...state, port: event.port, source: 'reported' } : state;
    case 'status-answered':
      return state.phase === 'building' ? { ...state, phase: 'serving' } : state;
    case 'run-ended':
      return { phase: 'released' };
  }
}
