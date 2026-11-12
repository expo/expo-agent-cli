// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// @ref llp/0010-agent-conventions.rfc.md §Exit codes
import { stopCloudSessionsAsync } from './stopCloudSessions';
import { stopLockedDevServerAsync } from './stopLocked';
import { resolveStopTargetAsync } from './stopTarget';
import { stopOwnerAsync, type OwnerStop } from './stopOwner';
import { emptyStopReport, retainedOwnerEvidence } from './stopReport';

import { lockAddressFor, probeDevServerLockAsync, type DevServerLockInfo } from '../devLock';
import { event as cliEvent } from '../events';
import { EXIT_OK, EXIT_OUTCOME_FAILED, EXIT_OUTCOME_TIMEOUT } from '../exitCodes';
import { followUpsEnabled, reportFollowUps } from '../followups';
import * as Log from '../log';
import { PACKAGER_STATUS_READY } from '../runtime/waitReady';
import { event } from './events';
import { discardDetachedRunAsync } from './detachedOwnership';
import { findPortListenerAsync, isPortInUseAsync, type PortListener } from './portListener';
import { isProcessAlive } from './processLiveness';
import { stopDevicesAsync } from './stopDevices';
import type { DevStopReportOptions, DevStopResultJson } from './stopTypes';
import { POLL_INTERVAL_MS, signalAndWaitAsync } from './processStop';
import {
  claimEndedRunAsync,
  servesPortOf,
  stopUntrackedDevServerAsync,
} from './untrackedDevServer';
import type { DevStopOptions } from './resolveStopOptions';
import {
  buildFollowUps,
  printHumanReport,
  explainFailure,
  sessionPendingExplanation,
} from './stopPresentation';

/**
 * Stop this project's dev server.
 *
 * @returns the exit code: `0` stopped, or nothing was running; `20` something is still there.
 */
export async function devStopAsync(
  projectRoot: string,
  options: DevStopOptions,
  { print = true, onReport, target: constraint = { kind: 'project' } }: DevStopReportOptions = {}
): Promise<number> {
  const startedAt = Date.now();
  const target = await resolveStopTargetAsync(
    projectRoot,
    options,
    constraint,
    startedAt + options.timeoutMs
  );
  if (target.kind === 'skip') return EXIT_OK;
  if (target.kind === 'discard')
    return discardRunAsync(projectRoot, target.id, startedAt, options, { print, onReport });
  if (target.kind === 'owner') {
    const { report, status } = await stopOwnerAsync(target, options, startedAt);
    return finishStopReport(report, options, {
      finishing:
        status === 'pending' && target.lock?.easPlatform != null && !target.lock.easOpenFinished,
      sessionPending: false,
      print,
      onReport,
      status,
    });
  }
  const lock = target.kind === 'locked' || target.kind === 'foreground' ? target.lock : null;
  const { report, finishing } = lock
    ? await stopLockedDevServerAsync(lock, options, startedAt)
    : {
        report: await stopUnlockedDevServerAsync(
          projectRoot,
          options,
          startedAt,
          target.kind === 'unlocked' ? target.elsewhereLock : null
        ),
        finishing: false,
      };
  if (target.kind === 'foreground') {
    const retained = retainedOwnerEvidence(target.observation, target.devices, null);
    Object.assign(report, retained, {
      detail: [report.detail, retained.detail].filter(Boolean).join(' '),
      devices: target.devices,
      reaped: [],
      deviceError:
        options.eas || options.release
          ? 'Resources were kept because they may belong to another detached run.'
          : null,
    });
    return finishStopReport(report, options, { finishing, sessionPending: false, print, onReport });
  }
  if (target.kind === 'unlocked' && !target.cleanResources) {
    Object.assign(report, {
      devices: [],
      reaped: [],
      deviceError:
        options.eas || options.release
          ? 'Resources were kept because the requested port does not identify the detached owner.'
          : null,
    });
    return finishStopReport(report, options, { finishing, sessionPending: false, print, onReport });
  }

  // @ref llp/0027-everything-on-eas.rfc.md §dev:stop — after the dev server and whatever it
  // answered: a session that will not stop is reported beside a dev server that did, not instead.
  // @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions — a finishing run binds the
  // session its start returns, so `--eas` waits for that start before it looks for sessions.
  let sessionPending = false;
  if (options.eas && finishing && lock != null) {
    sessionPending = !(await waitForEasOpenAsync(lock, startedAt + options.timeoutMs));
    if (sessionPending) {
      report.session = {
        id: null,
        stopped: false,
        reason: `pid ${lock.pid} is still starting its EAS Simulator session`,
        platform: lock.easPlatform,
      };
    }
  }
  const cloud = options.eas && !sessionPending ? await stopCloudSessionsAsync(projectRoot) : null;
  if (cloud) report.session = cloud.session;
  Object.assign(report, await stopDevicesAsync(projectRoot, options, report, cloud));

  return finishStopReport(report, options, { finishing, sessionPending, print, onReport });
}

function finishStopReport(
  report: DevStopResultJson,
  options: DevStopOptions,
  {
    finishing,
    sessionPending,
    print,
    onReport,
    status = 'complete',
  }: {
    finishing: boolean;
    sessionPending: boolean;
    print: boolean;
    onReport: DevStopReportOptions['onReport'];
    status?: OwnerStop['status'];
  }
): number {
  report.followups = followUpsEnabled(options.followups) ? buildFollowUps(report, finishing) : [];
  const devServerOk = report.stopped || report.reason === 'not-running';
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
  const exitCode =
    sessionPending || status === 'pending'
      ? EXIT_OUTCOME_TIMEOUT
      : status === 'uncertain'
        ? EXIT_OUTCOME_FAILED
        : devServerOk && sessionOk && !report.deviceError
          ? EXIT_OK
          : EXIT_OUTCOME_FAILED;
  onReport?.(report);

  // The event above is emitted whatever happens: a caller that suppresses the report is still
  // stopping a dev server, and the stream is how that is visible to anything watching.
  if (print) {
    if (options.json) {
      Log.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report, finishing);
    }
    if (sessionPending) {
      Log.error(sessionPendingExplanation(report));
    } else if (exitCode !== EXIT_OK) {
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

/** Discard admission evidence without observing or stopping the work it once admitted. */
async function discardRunAsync(
  projectRoot: string,
  id: string,
  startedAt: number,
  options: DevStopOptions,
  { print = true, onReport }: DevStopReportOptions
): Promise<number> {
  const removed = await discardDetachedRunAsync(projectRoot, id);
  const report = emptyStopReport(null, startedAt);
  report.admission = removed ? 'discarded' : null;
  report.discardedRun = removed ? id : null;
  report.reason = 'not-requested';
  report.detail = `${removed ? 'Discarded' : 'No record remains for'} attempt ${id}. No processes were stopped and no EAS sessions or devices were released.`;
  Object.assign(report, { devices: [], reaped: [], deviceError: null });
  onReport?.(report);
  if (print) {
    if (options.json) Log.log(JSON.stringify(report, null, 2));
    else Log.log(report.detail);
  }
  return EXIT_OK;
}

/**
 * No lock answered *for the target*. A dev server a killed run of this project left is stopped as
 * its lock's would be (`stopUntrackedDevServerAsync`); any other listener's ownership is unknown.
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
  projectRoot: string,
  options: DevStopOptions,
  startedAt: number,
  elsewhereLock: DevServerLockInfo | null = null
): Promise<DevStopResultJson> {
  const port = options.port ?? null;
  // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
  const untracked = await claimEndedRunAsync(projectRoot);
  if (untracked != null && servesPortOf(untracked, port)) {
    return {
      ...emptyStopReport(untracked.port, startedAt),
      pid: untracked.listener.pid,
      url: untracked.url,
      untracked: true,
      ...(await stopUntrackedDevServerAsync(projectRoot, untracked, options, startedAt)),
    };
  }
  const base = emptyStopReport(port, startedAt);
  if (port == null) {
    base.detail =
      'no dev-server lock answered for this project, and no dev server a killed run of this project left was found. Pass --port to inspect a specific port';
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
    // The pid, again, rather than the port. `--force` proved *this process* was the dev server on
    // the port, so this process going away is what "forced" means; a port that keeps answering
    // afterwards is a second listener, and reporting a failed kill for it would be a lie about the
    // one thing this command did do.
    const outcome = await signalAndWaitAsync(listener.pid, port, options, startedAt);
    return { ...base, ...outcome, forced: outcome.stopped };
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
 * Wait until the finishing run of `lock` says its EAS open returned, or lets go of its lock.
 *
 * @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions — the run binds the session
 * inside its open, so after this a `--eas` stop finds that session. A holder that accepts the
 * connection and stays silent still holds the lock. The wait ends where the run's own start window
 * ends, and no later than the session wait an agent's command can afford.
 *
 * @returns false when the start still runs at the deadline.
 */
async function waitForEasOpenAsync(lock: DevServerLockInfo, deadline: number): Promise<boolean> {
  const { address } = lockAddressFor(lock.projectRoot);
  let announced = false;
  for (;;) {
    const probe = await probeDevServerLockAsync(address);
    if (
      !probe.connected ||
      (probe.info && (probe.info.pid !== lock.pid || probe.info.easOpenFinished))
    ) {
      return true;
    }
    if (Date.now() + POLL_INTERVAL_MS >= deadline) return false;
    if (!announced) {
      announced = true;
      Log.progress(
        `Waiting up to ${Math.round((deadline - Date.now()) / 1000)} s for pid ${lock.pid} to finish its EAS Simulator session start, so this stop finds the session.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
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
