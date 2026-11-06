// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// Which port the dev server actually listens on.
//
// The wrapper cannot know: `expo start` walks past a taken port, and `expo run:ios` starts a dev
// server the wrapper passed no port to at all. What it can do is read Metro's `metro:instantiate`
// event, which the Expo CLI sends to this process's `2g` event log, and only trust events the
// current run sent.

import { getEventLoggerInfo } from '2g';
import { tap } from '2g/api';
import fs from 'fs';
import path from 'path';

import { matchProjectRoot, readReportedProjectRootAsync } from '../runtime/projectRootHeader';

/** Where `npx expo start` listens when nothing says otherwise. */
export const DEFAULT_DEV_SERVER_PORT = 8081;

/** How often the event log is read again while waiting for the port. */
export const PORT_WATCH_INTERVAL_MS = 500;

/** How long the dev server gets to report its port before the fallbacks are used. */
export const PORT_WATCH_TIMEOUT_MS = 20_000;

/** Structured log `expo start` writes its `metro:instantiate` event into, relative to a project. */
const START_LOG_SEGMENTS = ['.expo', 'dev', 'logs', 'start.log'];

/**
 * Last `metro:instantiate` port in `projectRoot/.expo/dev/logs/start.log`, or null.
 *
 * Only `@expo/cli` 57 writes this file. The dev-server lock does not read it; discovery and the
 * port-collision check still do.
 *
 * The log outlives the dev server that wrote it, so an entry alone proves nothing: without
 * `since` the port is a candidate a caller still has to probe, and with `since` an entry from an
 * earlier run is dropped outright. `2g` timestamps every line in the `_t` field, in epoch
 * milliseconds, which is what makes the cutoff possible.
 *
 * @param since Epoch milliseconds; entries written before this are ignored, as is an entry with
 * no timestamp at all — a line that cannot prove it belongs to this run does not get to.
 */
export function readLastLoggedDevServerPort(
  projectRoot: string,
  { since }: { since?: number } = {}
): number | null {
  return portsInEventFile(path.join(projectRoot, ...START_LOG_SEGMENTS), since).at(-1) ?? null;
}

/**
 * The ports Metro reports in this process's own `2g` event log at or after `since`, as they
 * arrive, until `signal` aborts.
 *
 * The Expo CLI, a child of this process, sends its events to that log: a `2g` session, followed
 * live through `2g/api`, or a `LOG_EVENTS` file, read again every `intervalMs`. A file can be shared
 * with other runs, so a port from it is only a candidate; the caller checks whose dev server answers
 * there. A log this process cannot read back (a file descriptor, or a parent's IPC socket) reports
 * nothing.
 */
async function* reportedPorts(
  since: number,
  signal: AbortSignal,
  intervalMs: number
): AsyncGenerator<number> {
  const info = getEventLoggerInfo();
  if (info?.sessionDir) {
    try {
      const events = tap(info.sessionDir, {
        since,
        follow: true,
        filter: 'metro:instantiate',
        signal,
      });
      for await (const entry of events) {
        if (typeof entry.port === 'number') {
          yield entry.port;
        }
      }
    } catch {
      // A session that cannot be read reports nothing; the caller falls back.
    }
    return;
  }
  if (info?.file) {
    let seen = 0;
    while (!signal.aborted) {
      const ports = portsInEventFile(info.file, since);
      yield* ports.slice(seen);
      seen = ports.length;
      await waitAsync(intervalMs, signal);
    }
  }
}

/** The `metro:instantiate` ports in a `2g` JSONL file, in order, written at or after `since` when given. */
function portsInEventFile(file: string, since: number | undefined): number[] {
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const ports: number[] = [];
  for (const line of contents.split('\n')) {
    if (!line.includes('"metro:instantiate"')) {
      continue;
    }
    let entry: { _e?: string; _t?: unknown; port?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      // A torn write is not an answer; keep scanning.
      continue;
    }
    if (entry._e !== 'metro:instantiate' || typeof entry.port !== 'number') {
      continue;
    }
    if (since != null && (typeof entry._t !== 'number' || entry._t < since)) {
      continue;
    }
    ports.push(entry.port);
  }
  return ports;
}

/**
 * The `--port` (or `-p`) value of an `expo` invocation, or null when it names none.
 *
 * Scanning stops at `--`: `expo start` forwards everything after the separator, so a `--port`
 * there belongs to something else.
 */
export function readPortArg(args: string[]): number | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') {
      return null;
    }
    const value =
      arg === '--port' || arg === '-p'
        ? args[index + 1]
        : /^(--port|-p)=/.test(arg)
          ? arg.slice(arg.indexOf('=') + 1)
          : undefined;
    if (value == null) {
      continue;
    }
    const port = Number(value);
    if (Number.isInteger(port) && port > 0) {
      return port;
    }
  }
  return null;
}

export interface ResolvedDevServerPort {
  port: number;
  /** `reported`: Metro reported it in its event log. `arg`: the command line asked for it. `default`: neither. */
  source: 'reported' | 'arg' | 'default';
}

export interface ResolveDevServerPortOptions {
  /** Epoch milliseconds of the spawn; log entries older than this belong to an earlier run. */
  since: number;
  /**
   * Whether the dev server is still running. Waiting stops as soon as it is not. Required: the
   * watch that follows a foreign fallback port has no deadline but this one.
   */
  isRunning: () => boolean;
  /**
   * Settles when the dev server has stopped, which cuts the wait between two reads short.
   *
   * Without it a dev server that fails immediately would still cost a full `intervalMs` before
   * `isRunning` is consulted again, and that delay is added to every failed start.
   */
  stopped?: Promise<unknown>;
  intervalMs?: number;
  timeoutMs?: number;
  /**
   * Called with the answer as soon as there is one, before the lock does anything with it.
   *
   * For a caller that has to say something about the dev server it started — where to open it, in
   * the follow-ups — and must not say it about a port nothing reported. `source` is the whole
   * point: `default` means neither the dev server nor the command line named a port, so there is
   * nothing to vouch for.
   */
  onResolved?: (resolved: ResolvedDevServerPort) => void;
  /** Whether a dev server of another project answers on this port. Read off `/status` by default. */
  servesAnotherProject?: (port: number) => Promise<boolean>;
}

/** How long the fallback port's `/status` may take to name its project. */
const FOREIGN_CHECK_TIMEOUT_MS = 1000;

/**
 * Wait for the dev server to report its port, then fall back to what the command line asked for.
 *
 * A reported port whose `/status` names another project is never the answer: it is another run's
 * report in a shared `LOG_EVENTS` file. Neither is such a fallback port [observed — live suite,
 * 2026-10-05: a lock on 8081 pointed at another project's Metro]; the report is then waited for
 * for as long as the dev server runs.
 *
 * @returns the port, or null when the dev server stopped and the only port left to name serves
 * another project.
 */
export async function resolveDevServerPortAsync(
  projectRoot: string,
  args: string[],
  {
    since,
    isRunning,
    stopped,
    intervalMs = PORT_WATCH_INTERVAL_MS,
    timeoutMs = PORT_WATCH_TIMEOUT_MS,
    onResolved,
    servesAnotherProject = (port) => servesAnotherProjectAsync(projectRoot, port),
  }: ResolveDevServerPortOptions
): Promise<ResolvedDevServerPort | null> {
  const answer = (resolved: ResolvedDevServerPort): ResolvedDevServerPort => {
    onResolved?.(resolved);
    return resolved;
  };
  const done = new AbortController();
  const untilStopped = (deadline: number) =>
    whileRunningAsync({ deadline, isRunning, stopped, intervalMs, signal: done.signal });

  try {
    const reports = reportedPorts(since, done.signal, intervalMs);
    const ownReport = (async () => {
      for await (const port of reports) {
        if (!(await servesAnotherProject(port))) {
          return port;
        }
      }
      return null;
    })();

    const reported = await Promise.race([ownReport, untilStopped(Date.now() + timeoutMs)]);
    if (reported != null) {
      return answer({ port: reported, source: 'reported' });
    }

    const requested = readPortArg(args);
    const fallback: ResolvedDevServerPort =
      requested != null
        ? { port: requested, source: 'arg' }
        : { port: DEFAULT_DEV_SERVER_PORT, source: 'default' };
    if (!(await servesAnotherProject(fallback.port))) {
      return answer(fallback);
    }
    const late = await Promise.race([ownReport, untilStopped(Infinity)]);
    return late != null ? answer({ port: late, source: 'reported' }) : null;
  } finally {
    done.abort();
  }
}

/** Whether another project's dev server answers on `port`, per the `/status` header; the default check. */
export async function servesAnotherProjectAsync(
  projectRoot: string,
  port: number
): Promise<boolean> {
  const reported = await readReportedProjectRootAsync(
    `http://127.0.0.1:${port}`,
    FOREIGN_CHECK_TIMEOUT_MS
  );
  return reported.kind === 'header' && matchProjectRoot(reported.root, projectRoot) === false;
}

/**
 * Resolves null once the dev server stops, `deadline` passes, or `signal` aborts. `isRunning` is
 * asked every `intervalMs`; `stopped` cuts that wait short.
 */
async function whileRunningAsync({
  deadline,
  isRunning,
  stopped,
  intervalMs,
  signal,
}: {
  deadline: number;
  isRunning: () => boolean;
  stopped?: Promise<unknown>;
  intervalMs: number;
  signal: AbortSignal;
}): Promise<null> {
  let gone = false;
  stopped?.then(
    () => (gone = true),
    () => (gone = true)
  );
  while (!gone && isRunning() && Date.now() < deadline && !signal.aborted) {
    await waitAsync(Math.min(intervalMs, deadline - Date.now()), signal, stopped);
  }
  return null;
}

/**
 * Wait out `ms`, or until `signal` aborts or `stopped` settles.
 *
 * The timer is deliberately not unref'd: the caller is awaiting this, and a process whose only
 * pending work is unref'd exits with the event loop instead of finishing it.
 */
function waitAsync(ms: number, signal: AbortSignal, stopped?: Promise<unknown>): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    stopped?.then(finish, finish);
  });
}
