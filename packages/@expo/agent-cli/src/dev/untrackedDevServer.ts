// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
// This project's dev server that a killed run left: a SIGKILL ends the run before its cleanup, so
// its Metro keeps serving with no lock. `dev:stop` and `dev` decide it by one rule.

import { clearDevRunRecord, readDevRunRecord, type DevRunRecord } from '../devLock/runRecord';
import { matchProjectRoot, readReportedProjectRootAsync } from '../runtime/projectRootHeader';
import { findPortListenersAsync, type PortListener } from './portListener';
import { isProcessRunning } from './processLiveness';
import { signalAndWaitAsync, type SignalOutcome } from './processStop';
import type { DevStopOptions } from './resolveStopOptions';

/** How long the ownership read may take. */
const OWNERSHIP_READ_TIMEOUT_MS = 1500;

export interface UntrackedDevServer {
  port: number;
  url: string;
  /** The process listening on the port: the one the killed run saw listen there. */
  listener: PortListener;
  /** The pid of the run that died, whose record names this port. */
  runPid: number;
}

/**
 * What the record of a dead run proves about its port now.
 * - `orphan`: the run's own dev server still serves there.
 * - `stale`: another process, another project, or nothing answers there; the record is spent.
 */
export type EndedRunVerdict =
  | { kind: 'orphan'; server: UntrackedDevServer }
  | { kind: 'stale'; runPid: number };

/**
 * The record of this project's last run when that run died without its cleanup: the record is
 * still there and its pid is gone. Callers read the lock first; a live holder's record is null here.
 */
export function readEndedDevRun(projectRoot: string): DevRunRecord | null {
  const run = readDevRunRecord(projectRoot);
  return run && !isProcessRunning(run.pid) ? run : null;
}

/**
 * Judge the port of a dead run by four proofs: no live holder (the record's pid is gone), the
 * record names the pid the run saw listen once its dev server reported the port, that pid is the
 * one process listening there now, and its `/status` names this project. A dev server started by hand (`npx expo start`)
 * is another process, even on a port an earlier run used, so it is never an orphan.
 *
 * Reads only. Null when no dead run left a record, or when nothing was proved: the read ran out of
 * time, this machine would not name the listener, or the recorded pid still listens but the rest
 * of the proof failed (another listener beside it, a `/status` that did not name this project).
 */
export async function judgeEndedRunAsync(projectRoot: string): Promise<EndedRunVerdict | null> {
  const run = readEndedDevRun(projectRoot);
  if (run == null) {
    return null;
  }
  const url = `http://127.0.0.1:${run.port}`;
  const [reported, listeners] = await Promise.all([
    readReportedProjectRootAsync(url, OWNERSHIP_READ_TIMEOUT_MS),
    findPortListenersAsync(run.port),
  ]);
  const thisProject = reported.kind === 'header' && matchProjectRoot(reported.root, projectRoot);
  const listener = listeners.find((each) => each.pid === run.serverPid);
  // One listener: a second (`[::1]` beside `127.0.0.1`) may be the one `/status` reached.
  if (thisProject && listener && listeners.length === 1) {
    return { kind: 'orphan', server: { port: run.port, url, runPid: run.pid, listener } };
  }
  const unproved =
    listener != null ||
    (reported.kind === 'unreachable' && reported.timedOut) ||
    (thisProject && listeners.length === 0);
  return unproved ? null : { kind: 'stale', runPid: run.pid };
}

/** The orphan {@link judgeEndedRunAsync} names, or null; a spent record is removed. For the commands that act. */
export async function claimEndedRunAsync(projectRoot: string): Promise<UntrackedDevServer | null> {
  const verdict = await judgeEndedRunAsync(projectRoot);
  if (verdict?.kind === 'stale') {
    clearDevRunRecord(projectRoot, verdict.runPid);
  }
  return verdict?.kind === 'orphan' ? verdict.server : null;
}

/** Whether a command aimed at `port` (none: this project's dev server) is aimed at `server`. */
export function servesPortOf(server: UntrackedDevServer, port: number | null): boolean {
  return port == null || port === server.port;
}

/**
 * Stop the dev server a killed run left: signal the pid its record names and wait for it to go.
 * The record and `/status` are the proof a lock would have given, so no `--force` is asked for.
 * The dev server only: no lock is read and no device is touched.
 */
export async function stopUntrackedDevServerAsync(
  projectRoot: string,
  server: UntrackedDevServer,
  options: Pick<DevStopOptions, 'signal' | 'timeoutMs'>,
  startedAt = Date.now()
): Promise<SignalOutcome> {
  const outcome = await signalAndWaitAsync(server.listener.pid, server.port, options, startedAt);
  if (outcome.stopped) {
    clearDevRunRecord(projectRoot, server.runPid);
  }
  return outcome;
}

/** One sentence that names the server and why no run owns it. */
export function untrackedDevServerClause({ port, listener }: UntrackedDevServer): string {
  return `This project's dev server on port ${port} (pid ${listener.pid}) has no lock: the run that started it was killed`;
}
