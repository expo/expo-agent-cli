// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// @ref llp/0010-agent-conventions.rfc.md §Exit codes
// Stop this project's dev server.
//
// The friction this replaces is a shell incantation an agent has to compose and get right:
// `lsof -ti tcp:8081 | xargs kill`. Every part of it is a guess — which port, whether the pid on
// it is this project's dev server, whether SIGTERM was enough — and a wrong guess kills something
// the caller did not mean to.
//
// The lock already answers all of it. `src/devLock/` holds a socket for as long as an
// `@expo/agent-cli`-started dev server runs, and the line it answers with carries the wrapper's `pid`
// alongside the URL and port. Signalling that pid is enough for the whole tree: both spawn paths
// install forwarders for `SIGINT`/`SIGTERM` and pass them to the `expo start` child
// [observed — `src/utils/subprocess.ts`, `src/utils/expoCli.ts` `runExpoAsync`], so the wrapper
// takes Metro with it and releases the lock on the way out.
//
// A port with no lock has no ownership proof. The lock may have been lost, so report the
// listener and leave it running rather than claiming this CLI never started it.
//
// **The pid is the primary evidence that the stop worked; the port is secondary.** These answer two
// different questions — "is the process I signalled alive?" and "does something answer 8081?" — and
// this command used to require both before it would say the dev server had stopped. That is wrong
// whenever anything else is on the port, and the case that forces it is a split IPv4/IPv6 stack
// (llp/0005 §Stopping the app): the lock publishes `http://127.0.0.1:<port>`, so
// every check here is over IPv4, while a dev server that bound `::1` is a different listener on the
// same port number. A stranger on `127.0.0.1:8081` therefore kept `dev:stop` reporting
// `still-running` — exit 20 — about a process that was already gone, with a `How:` line offering
// `--signal SIGKILL` for a pid nothing could signal.

import { stopCloudSessionsAsync } from './stopCloudSessions';
import chalk from 'chalk';

import type { CloudPlatform } from '../device/cloudSimulator';
import type { ReleasedDevice } from '../deviceBinding';
import {
  isDevServerLockHeldAsync,
  readDevServerLockAsync,
  type DevServerLockInfo,
} from '../devLock';
import { event as cliEvent } from '../events';
import { EXIT_OK, EXIT_OUTCOME_FAILED } from '../exitCodes';
import { followUpsEnabled, reportFollowUps, type FollowUp } from '../followups';
import { easStopFollowUp } from '../followups/start';
import * as Log from '../log';
import { PROGRAM_PREFIX } from '../programName';
import { devCommand, hostPlatform } from '../smoke/suggest';
import { PACKAGER_STATUS_READY } from '../runtime/waitReady';
import { spawnCaptureAsync } from '../utils/spawnCapture';
import { windowsTaskkillCommand } from '../utils/windowsShim';
import { debugEvent, event } from './events';
import { findPortListenerAsync, isPortInUseAsync, type PortListener } from './portListener';
import { isProcessAlive } from './processLiveness';
import { stopDevicesAsync, type StoppedDevices } from './stopDevices';
import type { DevStopOptions } from './resolveStopOptions';

/** How often to re-check whether the dev server has gone. */
const POLL_INTERVAL_MS = 150;

/**
 * Why a dev server was not stopped.
 *
 * A closed set rather than a sentence, because the three cases need three different next actions
 * and an agent must not have to read English to tell them apart.
 */
export type DevStopSkipReason =
  /** Nothing was running: no lock answered and nothing listens on the port. */
  | 'not-running'
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
  /** One sentence of detail for {@link reason}. Null exactly when {@link stopped} is true. */
  detail: string | null;
  /** How long the whole stop took, in milliseconds. */
  waitedMs: number;
  followups: FollowUp[];
}

export interface DevStopReportOptions {
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

/**
 * Stop this project's dev server.
 *
 * @returns the exit code: `0` stopped, or nothing was running; `20` something is still there.
 */
export async function devStopAsync(
  projectRoot: string,
  options: DevStopOptions,
  { print = true, onReport }: DevStopReportOptions = {}
): Promise<number> {
  const startedAt = Date.now();
  const lock = await readDevServerLockAsync(projectRoot);

  // `--port` names the target, and a lock is only evidence about the port it holds.
  //
  // This used to be `lock ? locked : unlocked`, which meant `--port 8195` signalled the pid of the
  // dev server on 8190 and reported `Stopped yes` naming a port the caller never asked about
  // [observed — friction run 7, F60]. It is the one destructive verb in this surface, so a target
  // it was not given is the one thing it must never act on: when `--port` disagrees with the lock,
  // the lock is set aside and the port is answered for on its own evidence.
  // @ref llp/0021-honest-reports.rfc.md §How they show up
  const lockOwnsTarget = lock != null && (options.port == null || lock.port === options.port);
  debugEvent('stop_lock_read', {
    held: lock != null,
    pid: lock?.pid ?? null,
    ownsTarget: lockOwnsTarget,
  });

  const { report, finishing } =
    lock != null && lockOwnsTarget
      ? await stopLockedDevServerAsync(lock, options, startedAt)
      : { report: await stopUnlockedDevServerAsync(options, startedAt, lock), finishing: false };

  // @ref llp/0027-everything-on-eas.rfc.md §dev:stop — after the dev server and whatever it
  // answered: a session that will not stop is reported beside a dev server that did, not instead.
  if (options.eas && finishing && lock != null) {
    await waitForEasOpenAsync(projectRoot, lock.pid, startedAt + options.timeoutMs);
  }
  const cloud = options.eas ? await stopCloudSessionsAsync(projectRoot) : null;
  if (cloud) report.session = cloud.session;
  const devServerOk = report.stopped || report.reason === 'not-running';
  Object.assign(report, await stopDevicesAsync(projectRoot, options, report, cloud));
  report.followups = followUpsEnabled(options.followups) ? buildFollowUps(report, finishing) : [];

  event('stop_done', {
    stopped: report.stopped,
    pid: report.pid,
    reason: report.reason,
  });
  cliEvent('dev_stop', {
    stopped: report.stopped,
    pid: report.pid,
    port: report.port,
    lockHeld: report.lockHeld,
    reason: report.reason,
  });

  // A session that was asked to stop and did not is a thing still running — and billing.
  const sessionOk = report.session == null || report.session.stopped || report.session.id == null;
  const exitCode = devServerOk && sessionOk && !report.deviceError ? EXIT_OK : EXIT_OUTCOME_FAILED;
  onReport?.(report);

  // The event above is emitted whatever happens: a caller that suppresses the report is still
  // stopping a dev server, and the stream is how that is visible to anything watching.
  if (print) {
    if (options.json) {
      Log.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report, finishing);
    }
    if (exitCode !== EXIT_OK) {
      // A failed stop drops the device How line, so the stop's How is the one next action.
      Log.error(
        devServerOk && report.deviceError
          ? report.deviceError
          : [report.deviceError?.split('\n')[0], explainFailure(report, options)]
              .filter(Boolean)
              .join('\n')
      );
    }
    reportFollowUps('dev:stop', report.followups, { json: options.json });
  }
  return exitCode;
}

/** The ordinary path: a lock answers, so the pid to signal is known and so is what it owns. */
async function stopLockedDevServerAsync(
  lock: DevServerLockInfo,
  options: DevStopOptions,
  startedAt: number
): Promise<{ report: DevStopResultJson; finishing: boolean }> {
  const base: DevStopResultJson = {
    stopped: false,
    pid: lock.pid,
    port: lock.port,
    url: lock.url,
    lockHeld: true,
    signal: null,
    forced: false,
    forceRefusedBy: null,
    processStillRunning: false,
    portStillAnswering: false,
    easPlatform: lock.easPlatform,
    reason: null,
    detail: null,
    waitedMs: 0,
    followups: [],
  };

  // @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions — the dev server is already
  // gone, and the pid waits for its session start to return the id it binds. Nothing is signalled:
  // SIGKILL would lose that id.
  if (lock.phase === 'finishing') {
    base.stopped = true;
    base.processStillRunning = isProcessAlive(lock.pid);
    base.portStillAnswering = !(await isPortFreeAsync(lock.port));
    base.waitedMs = Date.now() - startedAt;
    return { report: base, finishing: true };
  }

  // A signal that cannot be delivered is not a failure to stop: a lock answering for a pid that
  // is gone is the one case the socket cannot produce on its own, but a lock held by a *different*
  // user's process can, and `ESRCH` there means the thing is already not running.
  const sent = await signalProcessAsync(lock.pid, options.signal);
  base.signal = sent.delivered ? options.signal : null;
  debugEvent('stop_signalled', { pid: lock.pid, signal: options.signal, ok: sent.delivered });

  const outcome = await waitForStopAsync(lock, options.timeoutMs);
  base.waitedMs = Date.now() - startedAt;
  base.processStillRunning = !outcome.processGone;
  base.portStillAnswering = !outcome.portFree;
  debugEvent('stop_outcome', outcome);

  // The two facts that are about the thing this command signalled. The port is not one of them.
  if (outcome.processGone && outcome.lockGone) {
    base.stopped = true;
    return { report: base, finishing: false };
  }
  // @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions — the run's lock says
  // `finishing`: its dev server is gone, and the pid waits for its session start.
  if (outcome.finishing) {
    base.stopped = true;
    return { report: base, finishing: true };
  }

  base.reason = 'still-running';
  base.detail = !outcome.processGone
    ? sent.delivered
      ? `${options.signal} was sent to ${lock.pid}, and that process was still running ${options.timeoutMs}ms later`
      : `${options.signal} could not be delivered to ${lock.pid} (${sent.error ?? 'no reason given'}), and that process is still running`
    : // The pid went and the lock did not. The socket is held by something, so the dev server this
      // project would be found at is not this command's to have stopped.
      `pid ${lock.pid} is gone, but this project's dev-server lock is still answering, so something else is holding it`;
  return { report: base, finishing: false };
}

/**
 * No lock answered *for the target*. A listener may still exist, but its ownership is unknown.
 *
 * The two are told apart by the port, and the difference matters more than it looks: killing a
 * listener nobody asked about is the one thing this command must not do by accident. So the
 * default is to report it, name its pid if the machine will say, and stop.
 *
 * @param elsewhereLock a lock this project holds for a *different* port than `--port` named. It is
 * reported and never acted on: naming it is what tells a caller their own dev server is on another
 * port, and acting on it is F60.
 */
async function stopUnlockedDevServerAsync(
  options: DevStopOptions,
  startedAt: number,
  elsewhereLock: DevServerLockInfo | null = null
): Promise<DevStopResultJson> {
  const port = options.port ?? null;
  const base: DevStopResultJson = {
    stopped: false,
    pid: null,
    port,
    url: null,
    lockHeld: false,
    signal: null,
    forced: false,
    forceRefusedBy: null,
    processStillRunning: null,
    easPlatform: null,
    portStillAnswering: null,
    reason: 'not-running',
    detail: 'no dev-server lock answered for this project, and nothing was listening for it',
    waitedMs: Date.now() - startedAt,
    followups: [],
  };

  if (port == null) {
    base.detail =
      'no dev-server lock answered for this project; whether an untracked server is running is unknown. Pass --port to inspect a specific port';
    return base;
  }

  const listener = await findPortListenerAsync(port);
  const isDevServer = await isExpoDevServerAsync(port);
  base.pid = listener?.pid ?? null;
  base.url = isDevServer ? `http://127.0.0.1:${port}` : null;

  // A null listener means one of two things — the port is quiet, or the port is busy and this
  // machine would not say by whom — and only the first is "nothing was running" (F72). The bind
  // attempt is what tells them apart, and it is only needed when nothing else has already answered.
  const inUse = isDevServer || listener != null || (await isPortInUseAsync(port));
  base.portStillAnswering = inUse;
  base.processStillRunning = listener ? isProcessAlive(listener.pid) : inUse ? null : false;

  if (!inUse) {
    base.detail = `no dev-server lock answered for this project, and nothing is listening on port ${port}${lockElsewhereClause(elsewhereLock)}`;
    base.waitedMs = Date.now() - startedAt;
    return base;
  }

  // @ref llp/0005 §Stopping the app — both proofs, or nothing is killed.
  if (options.force && isDevServer && listener != null && looksLikeDevServerProcess(listener)) {
    const sent = await signalProcessAsync(listener.pid, options.signal);
    base.signal = sent.delivered ? options.signal : null;
    // The pid, again, rather than the port. `--force` proved *this process* was the dev server on
    // the port, so this process going away is what "forced" means; a port that keeps answering
    // afterwards is a second listener, and reporting a failed kill for it would be a lie about the
    // one thing this command did do.
    const outcome = await waitForForcedStopAsync(listener.pid, port, options.timeoutMs);
    base.waitedMs = Date.now() - startedAt;
    base.processStillRunning = !outcome.processGone;
    base.portStillAnswering = !outcome.portFree;
    if (outcome.processGone) {
      base.stopped = true;
      base.forced = true;
      base.reason = null;
      base.detail = null;
      return base;
    }
    base.reason = 'still-running';
    base.detail = `${options.signal} was sent to ${listener.pid}, and that process was still running ${options.timeoutMs}ms later`;
    return base;
  }

  base.reason = 'foreign-dev-server';
  // Which proof was missing, for a run that asked for `--force` and did not get it. Ordered by
  // which one is read first: a port that does not answer as a dev server settles it whatever the
  // process is, and an unnamed process is a different next step than a named foreign one.
  base.forceRefusedBy = options.force
    ? !isDevServer
      ? 'not-a-dev-server'
      : listener == null
        ? 'unnamed-process'
        : 'foreign-process'
    : null;
  // Two sentences, because they are two different facts and the old one blurred them: a dev server
  // this CLI did not start is not the same thing as a stranger on the port, and only the first is
  // something `--force` could ever stop.
  base.detail = isDevServer
    ? [
        `port ${port} is answering as an Expo dev server`,
        listener != null
          ? `run by pid ${listener.pid} (${listener.command})`
          : 'run by a process this machine would not name',
        `and no lock answers for it, so this project's ownership could not be verified`,
      ].join(' ') + lockElsewhereClause(elsewhereLock)
    : `no Expo dev server answered on port ${port}; ` +
      (listener != null
        ? `pid ${listener.pid} (${listener.command}) is listening and is not one`
        : `something is listening and is not one — this machine would not name the process holding the port`) +
      lockElsewhereClause(elsewhereLock);
  base.waitedMs = Date.now() - startedAt;
  return base;
}

/**
 * The clause that names this project's dev server when it is somewhere other than `--port`.
 *
 * Reported so that the caller who mistyped a port learns where their own dev server actually is,
 * rather than being told only that the port they named holds a stranger.
 */
function lockElsewhereClause(lock: DevServerLockInfo | null): string {
  return lock == null
    ? ''
    : `. This project's own dev-server lock is on port ${lock.port} (pid ${lock.pid}), which is not the port this run named — nothing there was signalled`;
}

/**
 * Send a signal to a pid, without letting a delivery failure become an exception.
 *
 * On Windows `process.kill` maps every signal onto an immediate terminate, and it reaches only the
 * process named — a dev server started through a batch shim has its bundler in a child that would
 * survive. `taskkill /T` covers the tree, so that is what is used there. It is best effort and
 * untested on that platform, which is why the result says whether the call was made rather than
 * whether it worked.
 */
export async function signalProcessAsync(
  pid: number,
  signal: NodeJS.Signals
): Promise<{ delivered: boolean; error?: string }> {
  if (process.platform === 'win32') {
    const result = await spawnCaptureAsync(
      windowsTaskkillCommand(),
      ['/PID', String(pid), '/T', '/F'],
      {
        timeoutMs: 5000,
      }
    );
    return result.spawnError
      ? { delivered: false, error: result.spawnError.message }
      : { delivered: result.exitCode === 0, error: result.stderr.trim() || undefined };
  }
  try {
    process.kill(pid, signal);
    return { delivered: true };
  } catch (error: unknown) {
    return { delivered: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** What the three checks said the last time they were asked. */
interface StopOutcome {
  /** The pid the lock named no longer exists. The primary evidence that the signal worked. */
  processGone: boolean;
  /** The project's dev-server lock no longer answers, so nothing holds it. */
  lockGone: boolean;
  /** Nothing answered `/status` on the port. Secondary: the port is not the process. */
  portFree: boolean;
  /** The pid's lock answers `finishing`: its dev server is gone, and it binds its session. */
  finishing: boolean;
}

/**
 * Poll until the signalled process and the lock have both gone, the lock says `finishing`, or the
 * budget runs out.
 *
 * For an ordinary run the port never gates the answer. It used to: "stopped" meant the lock and
 * the port had both gone quiet, which reads as caution and is a wrong answer whenever anything else
 * is on the port — including this CLI's own IPv4-only check meeting a listener the dev server never
 * knew about (llp/0005 §Stopping the app). The pid is what the signal was sent to,
 * so the pid is what says whether it worked.
 *
 * The lock stays in the condition because it is about this project rather than about the port
 * number: while it answers, another command would still be pointed at a dev server here.
 *
 * A lock of the same pid that answers `finishing` ends the wait too: the run's dev server is gone,
 * and the pid binds the session its start returns.
 * @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
 */
async function waitForStopAsync(lock: DevServerLockInfo, timeoutMs: number): Promise<StopOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [lockGone, current, portFree] = await Promise.all([
      isDevServerLockHeldAsync(lock.projectRoot).then((held) => !held),
      readDevServerLockAsync(lock.projectRoot),
      isPortFreeAsync(lock.port),
    ]);
    const processGone = !isProcessAlive(lock.pid);
    const atDeadline = Date.now() + POLL_INTERVAL_MS >= deadline;
    const finishing = current?.pid === lock.pid && current.phase === 'finishing';
    const outcome = { processGone, lockGone, portFree, finishing };
    if ((processGone && lockGone) || finishing || atDeadline) {
      return outcome;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** Poll until the pid `--force` signalled has gone, or the budget runs out. */
async function waitForForcedStopAsync(
  pid: number,
  port: number,
  timeoutMs: number
): Promise<{ processGone: boolean; portFree: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const processGone = !isProcessAlive(pid);
    if (processGone) {
      return { processGone, portFree: await isPortFreeAsync(port) };
    }
    if (Date.now() + POLL_INTERVAL_MS >= deadline) {
      return { processGone, portFree: await isPortFreeAsync(port) };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Wait until the finishing run `pid` says its EAS open returned, or lets go of its lock.
 *
 * @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions — the run binds the session
 * inside its open, so after this a `--eas` stop finds that session. At the deadline it stops what
 * it finds.
 */
async function waitForEasOpenAsync(projectRoot: string, pid: number, deadline: number) {
  for (;;) {
    const current = await readDevServerLockAsync(projectRoot);
    if (current?.pid !== pid || current.easOpenFinished) return;
    if (Date.now() + POLL_INTERVAL_MS >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** Whether nothing listens on the port: a refused connection, not a slow answer. */
async function isPortFreeAsync(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(400),
    });
    return false;
  } catch (error: unknown) {
    // A listener that does not answer in time is still a listener.
    return !(error instanceof Error && error.name === 'TimeoutError');
  }
}

/**
 * Whether the port answers the way a Metro dev server answers.
 *
 * This is the first of the two proofs `--force` requires. It is about the *port*: something that
 * writes `packager-status:running` is a Metro dev server, whatever its command line says.
 */
export async function isExpoDevServerAsync(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(800),
    });
    return (await response.text()).trim() === PACKAGER_STATUS_READY;
  } catch {
    return false;
  }
}

/**
 * Whether a listener's command line names a program that runs a dev server.
 *
 * This is the second of the two proofs, and it is about the *process*. Both are required because
 * each alone can be wrong in a way that ends with the wrong process killed: a `/status` answer
 * proves a dev server is there but not which pid owns it, and a pid lookup can race a port that
 * was closed and reopened between the two reads.
 */
export function looksLikeDevServerProcess(listener: PortListener): boolean {
  return /\b(node|expo|metro|bun|deno)\b/i.test(listener.command);
}

/**
 * @param finishing the stopped `dev --eas` run's lock answers `finishing`: its dev server is gone,
 * and it binds the session its start returns after this report.
 */
export function buildFollowUps(report: DevStopResultJson, finishing = false): FollowUp[] {
  const cloudRows = report.devices?.filter((d) => d.backend === 'cloud') ?? [];
  const kept = keptSessionFollowUp(report, cloudRows, finishing);
  const keptSession = kept ? [kept] : [];
  if (report.stopped) {
    const followups: FollowUp[] = [];
    // First, because it contradicts the line above it: the dev server stopped and the port is
    // still busy, and an agent that reads only "Stopped yes" will start the next one into a
    // collision. This command run again against the port is what names whose listener it is —
    // the unlocked path reports its pid and its command line.
    if (report.portStillAnswering && report.port != null) {
      followups.push({
        id: 'dev-stop-port',
        command: `${PROGRAM_PREFIX} dev:stop --port ${report.port}`,
        why: `Port ${report.port} still answers, and it is not the process that was just stopped. This asks what is on it and names the pid.`,
      });
    }
    // The run's own EAS platform, else the platform of a session this worktree has or had: a kept
    // session is reused by the next dev --eas.
    const easPlatform =
      report.easPlatform ?? report.session?.platform ?? cloudRows[0]?.platform ?? null;
    followups.push(...keptSession, {
      id: 'dev',
      command: easPlatform ? devCommand(easPlatform, '--eas') : devCommand(hostPlatform()),
      why: 'The dev server is stopped, so this is what starts one again when the app is needed.',
    });
    return followups;
  }
  if (report.reason === 'foreign-dev-server') {
    return [
      {
        id: 'status',
        command: `${PROGRAM_PREFIX} status --json`,
        why: 'Reports which dev server this project would talk to, so the one on that port can be told apart from this project’s.',
      },
    ];
  }
  if (report.reason === 'not-running' && report.session?.stopped && report.session.platform) {
    return [
      ...keptSession,
      {
        id: 'dev',
        command: devCommand(report.session.platform, '--eas'),
        why: 'The EAS session is stopped, and no dev-server lock answered for this project. This starts a dev server and a session again when the app is needed.',
      },
    ];
  }
  return keptSession;
}

/** The `dev:stop --eas` follow-up for a session that may still bill, or null. */
function keptSessionFollowUp(
  report: DevStopResultJson,
  cloudRows: ReleasedDevice[],
  finishing: boolean
): FollowUp | null {
  const failedStop =
    report.session?.id && !report.session.stopped
      ? { id: report.session.id, reason: report.session.reason }
      : cloudRows.find((d) => d.released === false);
  if (failedStop)
    return easStopFollowUp(
      `The stop of EAS Simulator session ${failedStop.id} failed${failedStop.reason ? `: ${failedStop.reason.split('\n')[0]}` : ''}. If it still runs, it bills until this ends it.`
    );
  const unchecked = cloudRows.find((d) => d.released == null);
  if (unchecked)
    return easStopFollowUp(
      `EAS Simulator session ${unchecked.id} is recorded for this worktree and was not checked. If it still runs, it bills until this ends it.`
    );
  // @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions — a finishing `dev --eas`
  // process binds the session its start returns after this report, so no binding names it yet.
  // A `dev:stop --eas` that already ran reported a session and asked the listing.
  if (finishing && report.session == null)
    return easStopFollowUp(
      `pid ${report.pid} is still starting its EAS Simulator session and binds it to this worktree when the start returns. A session it keeps bills until this ends it.`
    );
  return null;
}

function printHumanReport(report: DevStopResultJson, finishing: boolean): void {
  for (const device of report.devices ?? []) {
    Log.log(
      `${device.released ? 'Released' : device.released === false ? 'Could not release' : 'Kept'} ${device.name}${device.reason ? `: ${device.reason}` : '.'}`
    );
  }
  const lines = [
    chalk`{bold Stopped} ${report.stopped ? chalk.green('yes') : chalk.red('no')}${
      report.forced ? chalk.dim(' · forced') : ''
    }`,
  ];
  if (report.session) {
    lines.push(
      report.session.id == null
        ? chalk`{bold Session} ${chalk.dim('none in progress for this project')}`
        : chalk`{bold Session} ${report.session.id}${
            report.session.stopped
              ? chalk.dim(' · stopped')
              : chalk.red(` · still running — ${report.session.reason ?? 'no reason given'}`)
          }`
    );
  }
  if (report.pid != null) {
    lines.push(
      chalk`{bold Process} ${report.pid}${report.signal ? chalk.dim(` · sent ${report.signal}`) : chalk.dim(' · not signalled')}`
    );
  }
  if (report.url != null || report.port != null) {
    lines.push(
      chalk`{bold Dev server} ${report.url ?? `port ${report.port}`}${chalk.dim(
        report.lockHeld ? ' · via lock' : ' · no lock answered'
      )}`
    );
  }
  // Said out loud on the success path too, because "Stopped yes" and a port that still answers is
  // the one combination a reader would otherwise take for a contradiction.
  if (report.stopped && report.portStillAnswering && report.port != null) {
    lines.push(
      chalk`{bold Port} ${report.port}${chalk.dim(' · still answering, by something else')}`
    );
    lines.push(
      chalk.dim(
        ` The process this command signalled is gone. Another listener has that port number — a second project's dev server, or one on the other IP stack, since this check is over 127.0.0.1 and a listener on ::1 is a different socket.`
      )
    );
  }
  if (finishing && report.pid != null) {
    lines.push(
      chalk.dim(
        ` pid ${report.pid} has no dev server any more, and is finishing its EAS session start (it can take minutes). It exits by itself.`
      )
    );
  }
  if (report.detail != null) {
    lines.push(chalk.dim(` ${report.detail}`));
  }
  lines.push(chalk`{bold Took} ${report.waitedMs}ms`);
  Log.log(lines.join('\n'));
}

/** The what / why / how for a dev server that is still running. */
function explainFailure(report: DevStopResultJson, options: DevStopOptions): string {
  if (report.reason === 'foreign-dev-server') {
    // `url` is set on this path exactly when the port answered `packager-status:running`, which is
    // the difference between "someone else's dev server" and "not a dev server at all". They need
    // different advice: `--force` can stop the first and will always decline the second.
    const answeredAsDevServer = report.url != null;
    return [
      chalk.red(
        answeredAsDevServer
          ? `The dev server on port ${report.port} was not stopped.`
          : `Nothing was stopped on port ${report.port}.`
      ),
      answeredAsDevServer
        ? `Why: ${report.detail}. Stopping a process this CLI did not start would be killing something nobody in this command asked about — a second project's dev server on that port is the ordinary case.`
        : `Why: ${report.detail}. This command stops Expo dev servers, so it will not signal a process that has not shown it is one.`,
      report.forceRefusedBy
        ? forceRefusedHow(report, report.forceRefusedBy)
        : answeredAsDevServer
          ? `How: stop it where it was started, or run this command again with --force, which stops it only when the port answers as an Expo dev server ${report.pid != null ? `and pid ${report.pid} looks like one` : 'and its process can be identified'}.`
          : `How: stop whatever holds that port where it was started, or name the port your dev server is really on with --port. --force would be declined here for the same reason, and "${PROGRAM_PREFIX} status --json" reports which dev server this project would talk to.`,
    ].join('\n');
  }
  // Two failures wear this reason, and only one of them is answered by a bigger hammer. Sending
  // SIGKILL to a pid that is already gone is a next action that cannot work, which is the same
  // mistake the `--force` refusal used to make [friction run 5, F48-1].
  if (!report.processStillRunning) {
    return [
      chalk.red(`This project's dev-server lock is still answering.`),
      `Why: ${report.detail}. The signal did its job — pid ${report.pid} is gone — so what is left is a second holder of the lock, which is what happens when this project has two dev servers running and only one of them was this one.`,
      `How: run "${PROGRAM_PREFIX} status --json" to see which dev server this project would now talk to, and stop that one where it was started. Nothing here is waiting on a longer --timeout, and --signal SIGKILL has nothing left to signal.`,
    ].join('\n');
  }
  return [
    chalk.red(`The dev server is still running.`),
    `Why: ${report.detail}.`,
    `How: run this command again with a longer --timeout, or with --signal SIGKILL, which the process cannot decline. A dev server that ignores ${options.signal} is usually mid-shutdown rather than stuck.`,
  ].join('\n');
}

/**
 * The `How:` line for a `--force` that was passed and declined.
 *
 * It never names `--force` as the recovery, because the caller already passed it — the old line
 * did, which is a next action guaranteed to fail again [observed — friction run 5, F48-1]. What it
 * names instead is the proof that was missing and the one thing that would supply it.
 */
function forceRefusedHow(report: DevStopResultJson, refusal: DevStopForceRefusal): string {
  const port = report.port;
  switch (refusal) {
    case 'not-a-dev-server':
      return `How: --force was passed and declined, because the first of its two proofs did not hold — port ${port} answered, but not with "${PACKAGER_STATUS_READY}", so nothing has shown a Metro dev server is on it. --force never kills a listener on that evidence. Stop whatever is on the port where it was started, or name the right port with --port.`;
    case 'unnamed-process':
      return `How: --force was passed and declined, because the second of its two proofs did not hold — the port answers as an Expo dev server, and this machine named no process holding it, so there is no pid to signal. Run "lsof -ti tcp:${port}" yourself to see whether your user owns it; a listener owned by another user is not visible here.`;
    case 'foreign-process':
      return `How: --force was passed and declined, because the second of its two proofs did not hold — the program pid ${report.pid} runs, named above, is not one that runs a dev server, so the pid on the port and the dev server answering on it disagree. That usually means something in front of a dev server elsewhere: stop it where it was started, or point this command at the real port with --port.`;
  }
}
