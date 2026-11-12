import type { ChildProcess } from 'child_process';

import type { CloudPlatform } from '../device/cloudSimulator';
import type { FollowUp } from '../followups';
import type { StoppedDevices } from './stopDevices';

/**
 * Why a dev server was not stopped.
 *
 * A closed set rather than a sentence, because the three cases need three different next actions
 * and an agent must not have to read English to tell them apart.
 */
export type DevStopSkipReason =
  /** Nothing was running: no lock answered and nothing listens on the port. */
  | 'not-running'
  | 'ownership-retained'
  | 'record-discarded'
  /** Something listens, but no lock proves this project's ownership of it. */
  | 'foreign-dev-server'
  /** The signal was sent and the dev server was still there when the wait ran out. */
  | 'still-running';

/**
 * Which of `--force`'s two proofs did not hold.
 *
 * `--force` requires the same fact from two directions — the port answers as a Metro dev server,
 * and the process on the port is a program that runs one — because each alone can be wrong in a
 * way that ends with the wrong process killed (llp/0005 §Stopping the app).
 *
 * Reported because the refusal's own recovery used to be "run this command again with --force"
 * whether or not `--force` had been passed [observed — friction run 5, F48-1]. To a caller that
 * had just passed it, that is a next action that cannot work, and it says nothing about which
 * proof was missing — which is the only thing that decides what to do instead.
 */
export type DevStopForceRefusal =
  /** The port answered, but not with `packager-status:running`, so no Metro is proved to be there. */
  | 'not-a-dev-server'
  /** Something is listening and this machine would not name the process holding the port. */
  | 'unnamed-process'
  /** The process on the port runs a program that does not run a dev server. */
  | 'foreign-process';

/**
 * Machine shape of `@expo/agent-cli dev:stop --json`.
 *
 * @ref llp/0006-agent-native-cli-surface.rfc.md §Output contract — one JSON object on stdout,
 * every key always present, and a fact the run does not have is null.
 */
export interface DevStopResultJson extends Partial<StoppedDevices> {
  /** Admission evidence, independent of whether the process or Metro stopped. */
  admission: 'retained' | 'discarded' | 'released' | null;
  /** Explicit record discard, independent of process termination. */
  discardedRun?: string | null;
  /** Necessary recovery even when optional follow-ups are disabled. */
  recoveryCommand?: string | null;
  /** A dev server was running and is not running now. */
  stopped: boolean;
  /** PID that was signalled, or the listener's PID when one was found but not signalled. */
  pid: number | null;
  /** Port the dev server was on, from the lock or from `--port`. */
  port: number | null;
  /** Origin the dev server listened on, when a lock named one. */
  url: string | null;
  /**
   * The EAS Simulator session `--eas` asked to end, or null when it did not ask.
   *
   * @ref llp/0027-everything-on-eas.rfc.md §dev:stop
   * `stopped: false` with an `id` is a session that is still billing, and the reason says why the
   * stop did not take; `id: null` is a project with no session in progress on record. `platform`
   * is the session's platform, null when the run does not know it.
   */
  session?: {
    id: string | null;
    stopped: boolean;
    reason: string | null;
    platform: CloudPlatform | null;
  } | null;
  /**
   * Whether a lock answered for **the target**: this CLI's dev server or a stranger's.
   *
   * False when this project holds a lock for a different port than `--port` named, because that
   * lock is not evidence about the port this run acted on (F60). The lock's own port is named in
   * {@link detail} instead.
   */
  lockHeld: boolean;
  /** Signal that was sent, or null when nothing was signalled. */
  signal: string | null;
  /** The dev server was killed after `--force`, rather than asked to stop. */
  forced: boolean;
  /**
   * Which of `--force`'s two proofs did not hold, or null.
   *
   * Non-null exactly when `--force` was passed and declined, so a caller can branch on the
   * missing proof instead of reading the sentence that names it.
   */
  forceRefusedBy: DevStopForceRefusal | null;
  /**
   * Whether the reported pid is alive, even when the command refused to signal it.
   * Null when no pid was identified and no free port established that no listener exists.
   *
   * After a signal, this is the primary evidence about the stop. False beside `stopped: false`
   * means the process is gone but something else — the lock, below — remains, so SIGKILL is not
   * the recovery. True beside `stopped: true` and an {@link easPlatform} means the `dev --eas` run's
   * dev server is gone (its lock answers `finishing`) and the process is finishing its session
   * start; it leaves by itself. On a refusal,
   * this is an observation only; it grants no permission to signal.
   */
  processStillRunning: boolean | null;
  /**
   * The EAS platform the lock of the stopped run named, null when no lock answered or the run
   * opened no EAS session.
   *
   * @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions — beside
   * `processStillRunning: true`, it keeps the platform and `--eas` on the next `dev`: the process
   * binds its session only after this report.
   */
  easPlatform: CloudPlatform | null;
  /**
   * Something was still answering or listening on the port when it was checked.
   * Null when no target port was identified.
   *
   * Secondary evidence, reported rather than acted on. True beside `stopped: true` is the split
   * IPv4/IPv6 stack of llp/0005 §Stopping the app, or simply a second project's
   * dev server that was there all along: the process this command signalled is gone, and the port
   * number it was using is in use by something else. A caller that cares which reads it here
   * instead of inferring it from an exit code that has nothing to say about it.
   */
  portStillAnswering: boolean | null;
  /** Why nothing was stopped. Null exactly when {@link stopped} is true. */
  reason: DevStopSkipReason | null;
  /** Detail for the outcome, including surviving-work warnings after force termination. */
  detail: string | null;
  /**
   * No lock answered, and the dev server is the one a killed run left: the run's record names the
   * pid that listens on the port, and its `/status` names this project. That proof lets this run
   * stop it without `--force`.
   */
  untracked: boolean;
  /** How long the whole stop took, in milliseconds. */
  waitedMs: number;
  followups: FollowUp[];
}

export interface DevStopReportOptions {
  /** Internal cleanup: skip all side effects unless this still-live child owns the lock. */
  ownedChild?: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'> | null;
  /**
   * Whether to print the report at all.
   *
   * False for a caller that is *part of* another command's answer, exactly as
   * `devDetachAsync` has it: `smoke` stops the dev server it started as the cleanup of a run that
   * prints one report, and under `--json` a second report printed into that stdout would make the
   * whole run unparseable. The `cli:dev_stop` event is emitted either way, so a suppressed report
   * is never a silent stop.
   */
  print?: boolean;
  /**
   * Handed the report, for a caller that has to say what happened in words of its own.
   *
   * The return value is one exit code, which is all a command needs and not enough for a caller
   * folding this into a bigger answer: `smoke`'s cleanup line names the URL it stopped and quotes
   * the detail when it could not, and neither of those is derivable from `20`.
   */
  onReport?: (report: DevStopResultJson) => void;
}
