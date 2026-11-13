import fs from 'fs';

import type { DevServerLockInfo } from '../devLock';
import { EXIT_OUTCOME_FAILED, EXIT_OUTCOME_TIMEOUT } from '../exitCodes';
import { needsHumanErrorFrom, needsHumanOf } from '../needsHuman/error';
import { findNeedsHumanScenario } from '../needsHuman/registry';
import { rerunDevCommand } from '../plan/rerun';
import type { PlanPlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import { probeBundlerAsync } from '../runtime/bundlerStatus';
import { wrapUntrustedAppOutput } from '../runtime/untrusted';
import type { BundlerReadyResult } from '../runtime/waitReady';
import { CommandError } from '../utils/errors';
import {
  isRelayedDeviceCode,
  parseDetachedChildVerdict,
  VERDICT_LOG_LINES,
  type DetachedChildVerdict,
} from './childVerdict';
import { easKeptSentence, easStopSentence, type DetachEas } from './detachReport';
import { detachedLogPath, readDetachedLogSync } from './logFile';
import type { DevOptions } from './resolveOptions';
import { RUN_PHASE } from './runPhase';

/**
 * Time to catch an app-open failure after the bundler starts answering. Expo CLI has no
 * app-open success signal, so a later failure can still land after the deadline.
 *
 * @ref llp/0021-honest-reports.rfc.md §The rules — F140
 */
export const OPEN_PLATFORM_GRACE_MS = 1500;

const OPEN_PLATFORM_POLL_MS = 100;

export async function isOwnBundlerAnsweringAsync(
  projectRoot: string,
  url: string
): Promise<boolean> {
  const probe = await probeBundlerAsync(url, { projectRoot });
  return probe.answering && probe.projectRootMatched !== false;
}

/**
 * The app open can fail after the dev server starts, even without `--wait-ready`.
 * An explicit readiness failure needs no grace.
 *
 * @ref llp/0021-honest-reports.rfc.md §The rules
 */
export function needsOpenPlatformGrace({
  ready,
  opensPlatform,
}: {
  ready: boolean | null;
  opensPlatform: boolean;
}): boolean {
  return ready !== false && opensPlatform;
}

type GraceState =
  | { status: 'watching'; failure: null; verdict: DetachedChildVerdict | null }
  | {
      status: 'failed';
      failure: Exclude<DetachFailureKind, 'needs-human'>;
      verdict: DetachedChildVerdict | null;
    }
  | { status: 'handoff'; failure: 'needs-human'; verdict: DetachedChildVerdict };

/** A failure stays failed; only the child's handoff can supersede the first failure. */
function observeGrace(state: GraceState, check: DetachCheck): GraceState {
  if (state.status === 'handoff') return state;
  if (check.verdict?.scenario != null) {
    return { status: 'handoff', failure: 'needs-human', verdict: check.verdict };
  }
  if (state.status === 'failed') return { ...state, verdict: check.verdict };
  if (check.exited || check.statusAnswering === false) {
    return {
      status: 'failed',
      failure: check.exited ? 'child-exited' : 'not-answering',
      verdict: check.verdict,
    };
  }
  return { status: 'watching', failure: null, verdict: check.verdict };
}

/**
 * Keep the first failure, but keep polling for a needs-human verdict. The bundler can stop
 * answering before its wrapper finishes writing the handoff.
 */
export async function watchOpenPlatformGraceAsync(
  projectRoot: string,
  url: string,
  {
    hasExited,
    budgetMs,
    watchStatus,
  }: {
    hasExited: () => boolean;
    budgetMs: number;
    /** Only probe status when the run already established readiness. */
    watchStatus: boolean;
  }
): Promise<{ failure: DetachFailureKind | null; verdict: DetachedChildVerdict | null }> {
  const deadline = Date.now() + budgetMs;
  let state: GraceState = {
    status: 'watching',
    failure: null,
    verdict: readChildVerdictSync(projectRoot),
  };
  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(OPEN_PLATFORM_POLL_MS, deadline - Date.now()))
    );
    const statusAnswering = watchStatus ? await isOwnBundlerAnsweringAsync(projectRoot, url) : null;
    const verdict = readChildVerdictSync(projectRoot);
    state = observeGrace(state, {
      exited: hasExited(),
      verdict,
      statusAnswering,
    });
    if (state.status === 'handoff') return state;
  }

  return state;
}

const VERDICT_WAIT_MS = 2_000;

/**
 * A failure line can reach disk before its handoff or exit code. Wait for either of those
 * or the deadline, then return the last readable verdict.
 */
export async function waitForChildVerdictAsync(
  projectRoot: string,
  since?: number
): Promise<DetachedChildVerdict | null> {
  let verdict = readChildVerdictSync(projectRoot, since);
  const deadline = Date.now() + VERDICT_WAIT_MS;
  // The code row is the last line `logCmdError` writes, so a verdict with one is complete.
  while (verdict?.scenario == null && verdict?.code == null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, OPEN_PLATFORM_POLL_MS));
    verdict = readChildVerdictSync(projectRoot, since) ?? verdict;
  }
  return verdict;
}

/**
 * A device refusal the child raised, rebuilt as the child raised it: code, exit and How line.
 *
 * @ref llp/0035-one-device-per-worktree.rfc.md §Output and errors — the agent's recovery is the
 * child's own `dev` or `dev:stop` command, not `dev:logs`.
 */
export function relayedDeviceError(verdict: DetachedChildVerdict | null): CommandError | null {
  if (verdict == null || !isRelayedDeviceCode(verdict.code)) {
    return null;
  }
  const error = new CommandError(verdict.code, verdict.message.replace(/^[A-Za-z]*Error: /, ''));
  error.exitCode = verdict.exitCode ?? EXIT_OUTCOME_FAILED;
  if (verdict.data) {
    error.data = verdict.data;
  }
  if (verdict.suggestedCommand) {
    error.suggestedCommand = verdict.suggestedCommand;
  }
  return error;
}

/**
 * Let the child's handoff or exit explain a failed readiness wait. Missing status alone
 * can mean a cold build is still in progress.
 *
 * @ref llp/0021-honest-reports.rfc.md §The rules — F153
 */
export async function waitFailureAsync(
  projectRoot: string,
  exited: boolean,
  since?: number
): Promise<{ failure: DetachFailureKind; verdict: DetachedChildVerdict | null } | null> {
  const verdict = exited
    ? await waitForChildVerdictAsync(projectRoot, since)
    : readChildVerdictSync(projectRoot, since);
  const failure = resolveDetachFailure({ exited, verdict, statusAnswering: null });
  return failure ? { failure, verdict } : null;
}

/** Why a detached run that had come up is not something this command may report success for. */
export type DetachFailureKind =
  /** The child stopped at a step only a person can complete, and said which. */
  | 'needs-human'
  /** The child is gone, and its log holds no handoff. */
  | 'child-exited'
  /** The child is alive and the bundler that had answered `/status` no longer does. */
  | 'not-answering';

/** What the checks said at the moment the report was about to be printed. */
export interface DetachCheck {
  /** The child process this run spawned has exited. */
  exited: boolean;
  /** The child's own conclusion, read out of its log. */
  verdict: DetachedChildVerdict | null;
  /**
   * Whether `/status` still answered.
   *
   * Null when readiness was never established — a run without `--wait-ready` claims nothing about
   * the bundler, so a bundler that is still working is not a failure of this run.
   */
  statusAnswering: boolean | null;
}

export function resolveDetachFailure({
  exited,
  verdict,
  statusAnswering,
}: DetachCheck): DetachFailureKind | null {
  // The handoff block is written by `logCmdError` and by nothing else, so a log that has one is the
  // log of a process on its way out — conclusive whether or not its exit has been observed yet.
  if (verdict?.scenario != null) {
    return 'needs-human';
  }
  if (exited) {
    return 'child-exited';
  }
  if (statusAnswering === false) {
    return 'not-answering';
  }
  return null;
}

export function readChildVerdictSync(
  projectRoot: string,
  since?: number
): DetachedChildVerdict | null {
  // A reused foreground server can have an earlier detached run's log beside it. Use the same
  // freshness rule as resolveDevServerReach, rechecking on each read for a newly written handoff.
  if (since != null) {
    try {
      if (fs.statSync(detachedLogPath(projectRoot)).mtimeMs < since) return null;
    } catch {
      return null;
    }
  }
  const read = readDetachedLogSync(projectRoot, VERDICT_LOG_LINES);
  return read == null ? null : parseDetachedChildVerdict(read.lines);
}

export function detachFailureError(
  kind: DetachFailureKind,
  {
    projectRoot,
    lock,
    logFile,
    verdict,
    childExit,
    platform,
    eas,
  }: {
    projectRoot: string;
    lock: DevServerLockInfo;
    logFile: string;
    verdict: DetachedChildVerdict | null;
    childExit: { code: number | null; signal: NodeJS.Signals | null } | null;
    platform: PlanPlatform;
    eas: DetachEas | null;
  }
): CommandError {
  const relayed = relayedDeviceError(verdict);
  if (relayed) {
    return relayed;
  }
  if (kind === 'needs-human' && verdict?.scenario != null) {
    const scenario = findNeedsHumanScenario(verdict.scenario);
    const message = [
      `The detached dev server stopped at a step only a person can complete, so there is no dev server on ${lock.url}.`,
      `Why: the run was started in a process of its own, and that process ran its plan and stopped. This is its own report of why, from ${logFile}:`,
      wrapUntrustedAppOutput(verdict.message),
    ].join('\n');
    return scenario
      ? needsHumanErrorFrom(needsHumanOf(scenario, { detectedBy: 'detached-child-log' }), {
          message,
          code: 'DEV_DETACH_NEEDS_HUMAN',
        })
      : new CommandError('DEV_DETACH_NEEDS_HUMAN', message);
  }

  const easFlag = eas ? ' --eas' : '';
  const error = new CommandError(
    kind === 'child-exited' ? 'DEV_DETACH_DIED' : 'DEV_DETACH_NOT_ANSWERING',
    [
      kind === 'child-exited'
        ? `The dev server is not running any more: the process holding its lock (pid ${lock.pid}) exited${
            childExit?.signal
              ? ` on ${childExit.signal}`
              : childExit?.code != null
                ? ` with code ${childExit.code}`
                : ''
          } before this command could report it.`
        : `The dev server on ${lock.url} stopped answering before this command could report it.`,
      `Why: a detached run is two processes, and only this one is being read. The bundler answered while the other one was starting, and it is not there now — so "ready" would be a claim about a moment that has passed.`,
      `How: read what it printed with "${PROGRAM_PREFIX} dev:logs" (the file is ${logFile}), fix what it names, and start it again with "${PROGRAM_PREFIX} dev --${platform}${easFlag} --detach --wait-ready". Running "${PROGRAM_PREFIX} dev --${platform}${easFlag}" in this terminal shows the same start in the foreground, which is the quickest way to watch it fail.${eas ? ` ${easKeptSentence(eas)}` : ''}${logTail(projectRoot)}`,
    ].join('\n')
  );
  error.exitCode = EXIT_OUTCOME_FAILED;
  error.suggestedCommand = `${PROGRAM_PREFIX} dev:logs`;
  return error;
}

const FAILURE_LOG_LINES = 20;

/**
 * Fence output from Metro, Expo CLI, and the app.
 *
 * @ref llp/0008-guardrails.rfc.md §Untrusted-content marking
 */
function logTail(projectRoot: string): string {
  const read = readDetachedLogSync(projectRoot, FAILURE_LOG_LINES);
  return read?.lines.length
    ? `\n\nWhat the dev server printed:\n${wrapUntrustedAppOutput(read.lines.join('\n'))}`
    : '';
}

export function lostDevServerError(lock: DevServerLockInfo, logFile: string): CommandError {
  const row = RUN_PHASE.finishing;
  const error = new CommandError(
    'DEV_DETACH_FAILED',
    [
      `The detached dev server exited, and its run (pid ${lock.pid}) is finishing its EAS session start.`,
      `Why: ${row.why(lock)}`,
      `How: run "${row.command}". ${row.does} What the run printed is in ${logFile}.`,
    ].join('\n')
  );
  error.suggestedCommand = row.command;
  return error;
}

/**
 * The error for a detached run whose lock still says `building` when the wait ends.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — exit 22: the run is alive,
 * and the same command follows it.
 */
export function stillBuildingOnLockError(
  lock: DevServerLockInfo,
  options: DevOptions,
  waitedMs: number
): CommandError {
  const logFile = detachedLogPath(lock.projectRoot);
  const rerun = rerunDevCommand(options.platform, options.callerArgv);
  const error = new CommandError(
    'DEV_DETACH_STILL_BUILDING',
    [
      `This project's dev run (pid ${lock.pid}) is still building after ${Math.round(waitedMs / 1000)} s, so its dev server is not up yet.`,
      `Why: its plan builds before it serves, and its lock says that it builds. The run keeps going and starts the dev server on ${lock.url} when the build ends.`,
      `How: run "${rerun}" again. It follows this run and starts no second one. "${PROGRAM_PREFIX} dev:logs" shows the build of a detached run. "${PROGRAM_PREFIX} dev:stop" stops the run.`,
    ].join('\n')
  );
  error.exitCode = EXIT_OUTCOME_TIMEOUT;
  error.data = { pid: lock.pid, url: lock.url, logFile, waitedMs };
  error.suggestedCommand = rerun;
  return error;
}

/**
 * The error for a detached run that held a `building` lock and ended before it served.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — the run is gone, so the
 * build failed or was stopped: the log says which.
 */
export function buildEndedError(lock: DevServerLockInfo, exitCode: number | null): CommandError {
  const logFile = detachedLogPath(lock.projectRoot);
  const error = new CommandError(
    'DEV_DETACH_FAILED',
    [
      `The detached dev run (pid ${lock.pid}) ended during its build${exitCode == null ? '' : ` with exit code ${exitCode}`}, so no dev server started.`,
      `Why: its lock said that it was building, and the run is gone. A step before its dev server failed or was stopped.`,
      `How: read what it printed in ${logFile} with "${PROGRAM_PREFIX} dev:logs", fix what stopped it, then run the same command again.${logTail(lock.projectRoot)}`,
    ].join('\n')
  );
  error.data = { pid: lock.pid, exitCode, logFile };
  error.suggestedCommand = `${PROGRAM_PREFIX} dev:logs`;
  return error;
}

export function notStartedError(
  projectRoot: string,
  logFile: string,
  childExit: { code: number | null; signal: NodeJS.Signals | null } | null,
  pid: number | null,
  waitedMs: number,
  platform: PlanPlatform
): CommandError {
  const how = childExit
    ? `it exited ${childExit.signal ? `on ${childExit.signal}` : `with code ${childExit.code}`} before it did`
    : `it was still running ${waitedMs}ms later without having published one`;

  const error = new CommandError(
    'DEV_DETACH_FAILED',
    [
      `The detached dev server did not start${pid == null ? '' : ` (pid ${pid})`}.`,
      `Why: a dev server this CLI starts publishes its port on the project's lock as soon as it is listening, and ${how}. Without that lock nothing can find the dev server, so reporting one here would name a server no other command could reach.`,
      `How: read what it printed in ${logFile}, or run "${PROGRAM_PREFIX} dev --${platform}" in this terminal to watch the same start happen in the foreground.${logTail(projectRoot)}`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} dev:logs`;
  return error;
}

/**
 * An answer from another project means the wait was probing the wrong listener. A longer
 * wait on the same listener cannot help.
 */
export function notReadyError(
  lock: DevServerLockInfo,
  logFile: string,
  result: BundlerReadyResult,
  platform: PlanPlatform | null = null,
  eas: DetachEas | null = null
): CommandError {
  const strangerAnswered = result.projectRootMatched === false;
  const error = new CommandError(
    'DEV_DETACH_NOT_READY',
    [
      `The dev server started on ${lock.url} (pid ${lock.pid}), but --wait-ready gave up before its bundler answered.`,
      `Why: ${result.reason ?? 'GET /status did not answer'}. ${
        strangerAnswered
          ? `That answer came from a dev server serving ${result.reportedProjectRoot}, which is not this project — so the wait was watching somebody else's bundler and this project's may well be ready.`
          : 'The dev server is still running — this is about the wait, not about the server.'
      }`,
      // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
      `Note: this CLI reaches the dev server at ${lock.url}, over IPv4. A port number is not one listener — 127.0.0.1:${lock.port} and [::1]:${lock.port} are different sockets, so another process can be answering this port on the other stack while this project's dev server is fine, and neither will have reported a collision. "lsof -nP -iTCP:${lock.port} -sTCP:LISTEN" lists both.`,
      // @ref llp/0005-runtime-loop-tools.rfc.md §Which platform is the caller's to say
      // The machine-readable follow-up must run without a platform flag.
      `How: read ${logFile} with "${PROGRAM_PREFIX} dev:logs", which says what the bundler is doing. "${PROGRAM_PREFIX} smoke --ios" or "--android" then reports whether this project compiles and runs on that device. ${eas ? easStopSentence(eas) : `Stop it with "${PROGRAM_PREFIX} dev:stop".`}`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} dev:logs`;
  return error;
}
