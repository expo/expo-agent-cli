// @ref llp/0004-smart-start-and-project-state.rfc.md §Status

/**
 * What the dev-server lock answers with: where the dev server of this project listens, and who
 * is holding the address open.
 *
 * Every field is present in every answer. A reader that gets this object got it from a process
 * that was alive a moment ago, because the answer travelled over a connection to that process —
 * there is no file to read, and so nothing to read out of date.
 */
export interface DevServerLockInfo {
  /** Origin the dev server listens on, e.g. `http://127.0.0.1:8082`. */
  url: string;
  /** Port of {@link url}, split out so a caller does not have to parse it back. */
  port: number;
  /** PID of the `@expo/agent-cli` process holding the lock, for a report that names the owner. */
  pid: number;
  /** When the lock was taken, as an ISO 8601 timestamp. */
  startedAt: string;
  /** Project the dev server was started for, as the lock holder resolved it. */
  projectRoot: string;
  /**
   * The platform of the EAS session this run opens the app on; null when the run opens no EAS
   * session.
   */
  easPlatform: 'ios' | 'android' | null;
  /**
   * Whether this run's EAS open returned, bound or failed. False before that, and for a run with
   * no EAS open.
   */
  easOpenFinished: boolean;
  /**
   * What the run that holds the lock does now.
   *
   * @ref llp/0004-smart-start-and-project-state.rfc.md §Dev-server lock — the phase table.
   */
  phase: DevServerLockPhase;
}

/**
 * `building`: a step before the dev-server step runs. `serving`: the dev-server step runs.
 * `finishing`: the dev-server step exited, and the run's EAS open has not returned.
 */
export type DevServerLockPhase = 'building' | 'serving' | 'finishing';

/** A held lock. Releasing it frees the address for the next dev server of this project. */
export interface DevServerLockHandle {
  /** Address the lock answers on, for reports and assertions. */
  address: string;
  /** Whether a stale socket file of a dead dev server had to be removed to take the address. */
  replacedStale: boolean;
  /** Stop answering and clean up the address. Safe to call more than once. */
  release(): void;
  /** What the lock answers now. */
  readonly info: DevServerLockInfo;
  /** Answer every later connection with `info` instead. */
  update(info: DevServerLockInfo): void;
}
