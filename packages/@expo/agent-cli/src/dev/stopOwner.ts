// @ref llp/0036-detached-run-ownership.rfc.md §Stopping a starting run
import { cancelDetachedRunAsync, discardRunCommand } from './detachedOwnership';
import type { CapturedCleanup, MetroEvidence } from './devRunTypes';
import { isProcessAlive } from './processLiveness';
import { isPortFreeAsync } from './processStop';
import type { DevStopOptions } from './resolveStopOptions';
import { stopLockedDevServerAsync } from './stopLocked';
import { emptyStopReport } from './stopReport';
import { ownerPortOf, type StopTarget } from './stopTarget';
import type { DevStopResultJson } from './stopTypes';

type OwnerTarget = Extract<StopTarget, { kind: 'owner' }>;
export type OwnerStop = { report: DevStopResultJson; status: 'complete' | 'pending' | 'uncertain' };

export async function stopOwnerAsync(
  target: OwnerTarget,
  options: DevStopOptions,
  startedAt: number
): Promise<OwnerStop> {
  const { observation, lock } = target;
  const report = ownerReport(target, startedAt);
  if (observation.kind !== 'live') {
    if (observation.kind === 'interrupted')
      report.recoveryCommand = discardRunCommand(observation.attempt.id);
    report.detail +=
      observation.kind === 'uncertain'
        ? ` ${observation.detail}`
        : ' The owner ended without releasing admission. Discarding the record stops no processes or sessions.';
    return { report, status: report.stopped ? 'complete' : 'uncertain' };
  }
  if (options.signal === 'SIGKILL') {
    if (!lock) {
      report.detail +=
        ' Forced termination requires a live dev-server lock; the recorded PID is diagnostic only.';
      return { report, status: 'uncertain' };
    }
    const forced = await stopLockedDevServerAsync(lock, options, startedAt, target.forcedRecord);
    forced.report.admission ??= 'retained';
    if (forced.report.admission === 'retained') {
      forced.report.detail ??= report.detail;
      if (!forced.report.processStillRunning && target.forcedRecord)
        forced.report.recoveryCommand = discardRunCommand(target.forcedRecord.id);
    }
    Object.assign(forced.report, { devices: target.devices, reaped: [], deviceError: null });
    if (options.eas || options.release)
      forced.report.deviceError =
        'Forced termination did not perform the requested session or device cleanup.';
    return { report: forced.report, status: 'complete' };
  }
  const outcome = await cancelDetachedRunAsync(observation.attempt, {
    signal: options.signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM',
    deadline: startedAt + options.timeoutMs,
    eas: options.eas,
    release: options.release,
  });
  report.waitedMs = Date.now() - startedAt;
  report.processStillRunning = isProcessAlive(observation.attempt.pid);
  if (lock && !report.processStillRunning) {
    report.stopped = true;
    report.reason = null;
  }
  if (outcome.kind === 'finished') {
    report.signal = options.signal;
    report.admission = 'released';
    setMetroOutcome(report, outcome.metro);
    report.reason = report.stopped ? null : 'not-running';
    report.detail = report.stopped
      ? null
      : 'The starting detached run was canceled before Metro readiness.';
    applyCapturedCleanup(report, outcome.cleanup, options);
  } else if (outcome.kind === 'pending') {
    report.signal = outcome.acknowledged ? options.signal : null;
    if (outcome.last.kind === 'stopping' || outcome.last.kind === 'unaccounted')
      setMetroOutcome(report, outcome.last.metro);
    report.detail += outcome.acknowledged
      ? ' Cancellation was accepted; cleanup has not completed within this wait. Admission was retained.'
      : ' The endpoint did not acknowledge cancellation. No saved PID was signalled; admission was retained.';
  } else {
    if (outcome.kind === 'interrupted')
      report.recoveryCommand = discardRunCommand(outcome.attempt.id);
    report.detail +=
      outcome.kind === 'uncertain'
        ? ` ${outcome.detail}`
        : ' The owner ended without a cleanup outcome.';
  }
  const remaining = startedAt + options.timeoutMs - Date.now();
  if (report.port != null && remaining > 0)
    report.portStillAnswering = !(await isPortFreeAsync(report.port, Math.min(400, remaining)));
  report.waitedMs = Date.now() - startedAt;
  return {
    report,
    status:
      outcome.kind === 'finished'
        ? 'complete'
        : outcome.kind === 'pending' && outcome.acknowledged
          ? 'pending'
          : 'uncertain',
  };
}

function ownerReport(target: OwnerTarget, startedAt: number): DevStopResultJson {
  const { observation, lock, devices } = target;
  const attempt = observation.attempt;
  const port =
    lock?.port ?? (observation.kind === 'live' ? ownerPortOf(observation) : null) ?? null;
  const report = emptyStopReport(port, startedAt);
  report.admission = 'retained';
  report.pid = attempt?.pid ?? null;
  report.processStillRunning = report.pid == null ? null : isProcessAlive(report.pid);
  report.lockHeld = lock != null;
  report.url = lock?.url ?? null;
  report.easPlatform = lock?.easPlatform ?? null;
  report.stopped = lock != null && report.processStillRunning === false;
  report.reason = report.stopped
    ? null
    : report.processStillRunning === false
      ? 'not-running'
      : 'still-running';
  report.devices = devices;
  report.reaped = [];
  report.deviceError = null;
  report.detail = [
    `Detached run ${attempt?.id ?? 'unknown'}; admission was retained.`,
    attempt?.pid ? `Diagnostic pid ${attempt.pid}.` : '',
    attempt?.logFile ? `Log: ${attempt.logFile}.` : '',
    port != null ? `Port ${port}.` : '',
    ...devices
      .filter((device) => device.backend === 'cloud')
      .map((device) => `Session ${device.id} was retained.`),
  ]
    .filter(Boolean)
    .join(' ');
  return report;
}

function setMetroOutcome(report: DevStopResultJson, metro: MetroEvidence): void {
  if (metro.kind === 'awaiting') {
    report.port ??= metro.plannedPort;
    return;
  }
  report.port ??= metro.server?.port ?? null;
  report.url ??= metro.server?.url ?? null;
  report.stopped = metro.kind === 'exited' && metro.server != null;
  if (report.stopped) report.reason = null;
}

function applyCapturedCleanup(
  report: DevStopResultJson,
  cleanup: CapturedCleanup,
  options: DevStopOptions
): void {
  report.devices = [...cleanup.devices];
  for (const entry of cleanup.sessions) {
    if (
      report.devices.some((device) => device.backend === 'cloud' && device.id === entry.session.id)
    )
      continue;
    report.devices.push({
      backend: 'cloud',
      platform: entry.session.platform,
      id: entry.session.id,
      name: entry.session.id,
      released: entry.outcome === 'stopped' ? true : entry.outcome === 'unknown' ? false : null,
      shutDown: entry.outcome === 'stopped',
      reason: entry.detail ?? null,
    });
  }
  if (options.eas) {
    const primary = cleanup.sessions[0];
    report.session = {
      id: primary?.session.id ?? null,
      platform: primary?.session.platform ?? null,
      stopped: primary?.outcome === 'stopped',
      reason: primary?.detail ?? null,
    };
  }
  const failed = report.devices.find((device) => device.released === false);
  report.deviceError = failed ? (failed.reason ?? `Could not release ${failed.name}.`) : null;
}
