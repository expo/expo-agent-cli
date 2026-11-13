import type { DevServerLockInfo } from '../devLock';
import { liveCloudBindings } from '../deviceBinding/cloud';
import type { BindingSummary } from '../deviceBinding/summary';
import { event as cliEvent } from '../events';
import { followUpsEnabled, reportFollowUps, type FollowUp } from '../followups';
import * as Log from '../log';
import type { NativePlatform, PlanPlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import { smokeCommand } from '../smoke/suggest';
import { parseDetachedChildPort } from './childVerdict';
import { readDetachedLogSync, type DetachedLogRead } from './logFile';
import { easOpenPlatform, type DevOptions } from './resolveOptions';

/** A dev server that is not on the port the caller expected. */
export interface PortMove {
  /** The port the caller expected: the one the plan moved from, or the one it planned. */
  from: number;
  /** The port the dev server took, as its lock names it. */
  to: number;
}

/**
 * Machine shape of `@expo/agent-cli dev --detach --json`.
 *
 * @ref llp/0006-agent-native-cli-surface.rfc.md §Output contract — one JSON object on stdout,
 * every key always present. Optional facts are null, except an absent log path is empty.
 */
export interface DevDetachResultJson {
  /** Origin the dev server listens on. */
  url: string;
  port: number;
  /** PID of the detached `@expo/agent-cli` process, which is what `dev:stop` signals. */
  pid: number;
  /** Where its output is being written, or an empty string when no log exists. */
  logFile: string;
  /**
   * Whether the bundler answered `/status`. Null when `--wait-ready` was not asked for, which is
   * the difference between "not ready" and "not asked".
   */
  ready: boolean | null;
  /** Whether the dev server serves this project, when readiness was checked. */
  projectRootMatched: boolean | null;
  /** Reused an existing run, including a build. Device or session work may still run. */
  alreadyRunning: boolean;
  /**
   * What the run's lock says: `building` while a step before the dev server, or an `expo run:*`
   * step, still compiles, and `serving` after. While it builds, {@link url} is where the dev server
   * will listen, not one that answers.
   *
   * @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
   */
  phase: 'building' | 'serving';
  /** The port the child planned or retried away from, and the port its lock names. */
  portMoved: PortMove | null;
  /**
   * The advertised tunnel origin for a `--tunnel` run, or null. The tunnel can come up
   * after the bundler answers.
   *
   * @see llp/0005-runtime-loop-tools.rfc.md §Where a device reaches the dev server
   */
  tunnelUrl: string | null;
  /** This worktree's device for the platform, or null when the run binds none. */
  device: BindingSummary | null;
  /**
   * The EAS session of a run that opens the app on EAS, or null for any other run. `sessionId` is
   * null while no session is bound; `--wait-ready` waits for it (llp/0035 §Preserved sessions).
   */
  eas: { sessionId: string | null } | null;
  /** How long the whole thing took, in milliseconds. */
  waitedMs: number;
  followups: FollowUp[];
}

/** The plan is printed before the build output, so a tail can miss it. */
export const WHOLE_LOG = Number.MAX_SAFE_INTEGER;

export function reportDetached(
  projectRoot: string,
  options: DevOptions,
  {
    lock,
    alreadyRunning,
    ready,
    projectRootMatched,
    startedAt,
    print,
    tunnelUrl,
    device,
    log = readDetachedLogSync(projectRoot, WHOLE_LOG),
    smokePlatform,
    eas,
  }: {
    lock: DevServerLockInfo;
    alreadyRunning: boolean;
    /** Set when this run opens the app on EAS; `sessionId` when the command reached a session. */
    eas: DetachEas | null;
    ready: boolean | null;
    projectRootMatched: boolean | null;
    startedAt: number;
    print: boolean;
    tunnelUrl: string | null;
    device: BindingSummary | null;
    /** The platform the `smoke` follow-up names. See {@link detachFollowUps}. */
    smokePlatform: NativePlatform;
    /** Reuse the caller’s full log read to avoid reading compiler output twice. */
    log?: DetachedLogRead | null;
  }
): number {
  const report: DevDetachResultJson = {
    url: lock.url,
    port: lock.port,
    pid: lock.pid,
    // The path only when the file is there. A dev server that was already running may have been
    // started attached, and then its output went to somebody's terminal and there is no log.
    logFile: log?.logFile ?? '',
    ready,
    projectRootMatched,
    alreadyRunning,
    phase: lock.phase === 'building' ? 'building' : 'serving',
    portMoved: alreadyRunning ? null : plannedPortMove(log, lock),
    tunnelUrl,
    device,
    eas,
    waitedMs: Date.now() - startedAt,
    followups: [],
  };
  report.followups = followUpsEnabled(options.followups)
    ? detachFollowUps(report, smokePlatform, eas)
    : [];

  cliEvent('dev_detach', {
    url: report.url,
    port: report.port,
    pid: report.pid,
    ready: report.ready,
    alreadyRunning: report.alreadyRunning,
    phase: report.phase,

    portMovedFrom: report.portMoved?.from ?? null,
    tunnelUrl: report.tunnelUrl,
  });

  // The event above is emitted whatever happens: a caller that suppresses the report is still
  // starting a dev server, and the stream is how that is visible to anything watching.
  if (print) {
    if (options.json) {
      Log.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report, options.platform);
    }
    reportFollowUps('dev', report.followups, { json: options.json });
  }
  return 0;
}

/**
 * The move between the port the child's plan expected and the port its lock names.
 *
 * The plan's `movedFrom` is the port the caller expected when the plan already moved; otherwise it
 * is the planned port. A retry after the plan moves the lock again, and the comparison still starts
 * from what the caller expected.
 */
function plannedPortMove(log: DetachedLogRead | null, lock: DevServerLockInfo): PortMove | null {
  const planned = log == null ? null : parseDetachedChildPort(log.lines);
  if (planned == null) {
    return null;
  }
  const expected = planned.movedFrom ?? planned.port;
  return lock.port === expected ? null : { from: expected, to: lock.port };
}

function printHumanReport(report: DevDetachResultJson, platform: PlanPlatform): void {
  const label = (name: string) => name.padEnd(13);
  // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
  const where =
    report.phase === 'building'
      ? ' · not listening yet — the plan is still building'
      : report.alreadyRunning
        ? ' · already running'
        : ' · detached';
  const lines = [`${label('Dev server')}${report.url}${where}`, `${label('Process')}${report.pid}`];
  if (report.portMoved) {
    lines.push(
      `${label('Port')}moved · ${report.portMoved.from} was busy, so it took ${report.portMoved.to}`
    );
  }
  if (report.logFile) {
    lines.push(`${label('Log')}${report.logFile}`);
  }
  if (report.ready != null) {
    lines.push(`${label('Bundler')}${report.ready ? 'ready' : 'not ready'}`);
  }
  if (report.tunnelUrl) {
    lines.push(`${label('Tunnel')}${report.tunnelUrl}`);
  }
  if (report.device) {
    const { name, id, origin } = report.device;
    lines.push(`${label('Device')}${name} (${id}) · ${origin}`);
  }
  if (report.eas) {
    lines.push(
      `${label('Session')}${
        report.eas.sessionId
          ? `${report.eas.sessionId} · bound to this worktree`
          : `not bound yet · "${PROGRAM_PREFIX} dev --${platform} --eas --detach --wait-ready" waits for it`
      }`
    );
  }
  lines.push(`${label('Took')}${report.waitedMs}ms`);
  if (report.alreadyRunning) {
    const lead = report.eas?.sessionId
      ? `This project already had a dev server; this run bound EAS Simulator session ${report.eas.sessionId}.`
      : 'This project already had a dev server, so nothing was started.';
    lines.push(
      ` ${lead} One detached dev server per project: a second one could not hold the lock, and nothing would be able to find or stop it.`
    );
  }
  Log.log(lines.join('\n'));
}

/** @ref llp/0009-smart-followups.rfc.md §Examples per command */
export function detachFollowUps(
  report: DevDetachResultJson,
  smokePlatform: NativePlatform,
  eas: DetachEas | null = null
): FollowUp[] {
  // On an EAS device run, the gate drives the session and the stop ends it (llp/0027 §Stop hints).
  const onEas = eas ? ' --eas' : '';
  const followups: FollowUp[] = [];
  if (report.ready == null) {
    followups.push({
      id: 'smoke',
      command: `${smokeCommand(smokePlatform)}${onEas}`,
      why: 'The dev server is up, but nothing has said whether its bundler finished, whether this project compiles, or whether the app comes up on it.',
    });
  }
  if (report.logFile) {
    followups.push({
      id: 'dev-logs',
      command: `${PROGRAM_PREFIX} dev:logs`,
      why: 'The dev server writes to a file now rather than to this terminal, and this is what reads it back.',
    });
  }
  // @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
  followups.push(
    eas
      ? {
          id: 'dev-stop',
          command: `${PROGRAM_PREFIX} dev:stop --eas`,
          why: eas.sessionId
            ? `A detached dev server outlives this shell, and EAS Simulator session ${eas.sessionId} stays bound to this worktree after a plain dev:stop; this ends both.`
            : `A detached dev server outlives this shell, and the EAS Simulator session it opens stays bound to this worktree after a plain dev:stop; this ends both. "${PROGRAM_PREFIX} dev:logs" names the session.`,
        }
      : {
          id: 'dev-stop',
          command: `${PROGRAM_PREFIX} dev:stop`,
          why: 'A detached dev server outlives this shell, so this is what ends it.',
        }
  );
  return followups;
}

export type DetachEas = { sessionId: string | null };

/** The EAS session a detached `dev --eas` keeps bound, read from this worktree's bindings. */
export function detachEas(projectRoot: string, options: DevOptions): DetachEas | null {
  if (!easOpenPlatform(options)) {
    return null;
  }
  const bound = liveCloudBindings(projectRoot).find(
    ({ device }) => device.platform === options.platform
  );
  return { sessionId: bound?.device.id ?? null };
}

function easSessionName(eas: DetachEas): string {
  return eas.sessionId
    ? `EAS Simulator session ${eas.sessionId}`
    : 'the EAS Simulator session it may have started';
}

/** The How sentence for a failed detached `dev --eas`: plain `dev:stop` keeps its session. */
export function easStopSentence(eas: DetachEas): string {
  return `Stop it with "${PROGRAM_PREFIX} dev:stop --eas", which also ends ${easSessionName(eas)}; a plain dev:stop keeps that session bound and billing.`;
}

/** The How sentence for a detached `dev --eas` whose dev server failed: the bound session stays. */
export function easKeptSentence(eas: DetachEas): string {
  return `To end ${easSessionName(eas)}, run "${PROGRAM_PREFIX} dev:stop --eas"; a plain dev:stop keeps that session bound and billing.`;
}
