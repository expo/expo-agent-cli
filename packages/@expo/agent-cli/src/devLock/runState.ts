// @ref llp/0004-smart-start-and-project-state.rfc.md §Dev-server lock — the transition table.
// What the run's lock says after each event. Pure: the writer (`RunLock`) does the socket work.

import type { ResolvedDevServerPort } from './port';
import type { DevServerLockInfo } from './types';

/** The run's EAS open: not started, running, or returned (bound or failed). */
export type EasOpen = 'none' | 'running' | 'returned';

/** Where the lock points: the last `published` port, or the port Metro reported since. */
export interface LockPort {
  port: number;
  source: ResolvedDevServerPort['source'];
  since: number;
  easPlatform: DevServerLockInfo['easPlatform'];
}

/** A state in which the run holds the lock; its phase is the one the lock answers. */
export type HeldRunState = LockPort &
  (
    | { phase: 'building' | 'serving'; easOpen: EasOpen }
    /** Metro exited while the EAS open runs. */
    | { phase: 'finishing'; easOpen: 'running' }
  );

export type RunState =
  /** The run holds no lock: before the take, after a foreign port, or when the take failed. */
  | { phase: 'unlocked'; easOpen: EasOpen }
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
  | { type: 'eas-open-started' }
  | { type: 'eas-open-returned' }
  /** The dev-server step's child exited, and its port watch ended. */
  | { type: 'server-exited' }
  | { type: 'run-ended' };

export function isHeld(state: RunState): state is HeldRunState {
  return state.phase !== 'unlocked' && state.phase !== 'released';
}

/** The next state, or null for an illegal pair: one that no caller should produce. */
export function nextRunState(state: RunState, event: RunEvent): RunState | null {
  if (state.phase === 'released') return event.type === 'published' ? null : state;
  const finishing = state.phase === 'finishing';
  const { easOpen } = state;
  switch (event.type) {
    case 'published': {
      if (finishing) return null;
      const { type: _, ...published } = event;
      return { ...published, easOpen };
    }
    case 'foreign-port':
      return finishing ? null : { phase: 'unlocked', easOpen };
    case 'port-reported':
      return isHeld(state) ? { ...state, port: event.port, source: 'reported' } : state;
    case 'status-answered':
      return state.phase === 'building' ? { ...state, phase: 'serving' } : state;
    case 'eas-open-started':
      return easOpen !== 'none' || finishing ? null : { ...state, easOpen: 'running' };
    case 'eas-open-returned':
      if (easOpen !== 'running') return null;
      return finishing ? { phase: 'released' } : { ...state, easOpen: 'returned' };
    case 'server-exited':
      if (finishing) return null;
      if (state.phase === 'unlocked' || easOpen === 'none') return state;
      return easOpen === 'running'
        ? { ...state, phase: 'finishing', easOpen }
        : { phase: 'released' };
    case 'run-ended':
      return { phase: 'released' };
  }
}
