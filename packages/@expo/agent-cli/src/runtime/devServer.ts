// @ref llp/0005-runtime-loop-tools.rfc.md
// Reachability check for the dev server the runtime commands talk to.
//
// Every runtime command needs two things a project cannot promise: a dev server, and an app
// connected to it. This module finds and probes the dev server; `./preflight.ts` is what *requires*
// either of them and owns the family's one refusal, so a failure names the missing piece instead of
// the socket error it caused, in the same words whichever command asked.

import { readDevServerLockAsync, readLastLoggedDevServerPort } from '../devLock';
import { PROGRAM_NAME, PROGRAM_PREFIX } from '../programName';
import { canonicalizeExistingPath } from '../utils/dir';
import { CommandError } from '../utils/errors';
import type { CdpTarget } from './cdpClient';

export { readLastLoggedDevServerPort };

/** Where `npx expo start` listens by default. */
export const DEFAULT_DEV_SERVER_URL = 'http://127.0.0.1:8081';

/** Strip trailing slashes, so `${url}/json/list` is always a well formed path. */
export function normalizeDevServerUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Validate a `--dev-server-url` value, or fall back to the default dev server.
 *
 * Shared by every command that takes the flag, so one bad URL reads the same everywhere.
 *
 * @throws {CommandError} `BAD_ARGS` when the value is not an http(s) URL.
 */
export function resolveDevServerUrlFlag(value: unknown): string {
  if (value == null) {
    return DEFAULT_DEV_SERVER_URL;
  }
  const url = normalizeDevServerUrl(String(value));
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CommandError(
      'BAD_ARGS',
      `--dev-server-url is not a URL: ${value}. Pass the dev server origin, for example --dev-server-url http://127.0.0.1:8081`
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CommandError(
      'BAD_ARGS',
      `--dev-server-url must be an http or https URL, but got ${value}. The dev server is reached over HTTP, for example --dev-server-url http://127.0.0.1:8081`
    );
  }
  return url;
}

/**
 * The dev server a caller named, through either of the two flags that name one, or null.
 *
 * `--port 8195` is `--dev-server-url http://127.0.0.1:8195` and nothing else. It exists because
 * `@expo/agent-cli dev --port 8195` is the command that started the server, and every command that then
 * talks to it wanted the *other* spelling — so an agent that had just typed a port had to translate
 * it into a URL, and got `unknown or unexpected option: --port` when it did not
 * [observed — friction run 4, 2026-08-23]. One flag name across the group is cheaper than the
 * translation, and the URL form stays for a dev server on another host.
 *
 * @param url the `--dev-server-url` value, or null/undefined when the caller named none.
 * @param port the `--port` value, or null/undefined when the caller named none.
 * @param command the command as a caller types it, for the error that names both flags.
 * @throws {CommandError} `BAD_ARGS` when both are named, or when the port is not a port.
 */
export function resolveDevServerTarget(
  url: unknown,
  port: unknown,
  command: string
): string | null {
  if (url != null && port != null) {
    throw new CommandError(
      'BAD_ARGS',
      [
        `--dev-server-url and --port both name a dev server for "${PROGRAM_NAME} ${command}", and they name different ones.`,
        `Why: --port <n> is shorthand for --dev-server-url http://127.0.0.1:<n>, so passing both leaves two answers to one question and no rule for which wins.`,
        `How: pass one. Use --port ${port} for a dev server on this machine, or --dev-server-url ${url} for one anywhere else.`,
      ].join('\n')
    );
  }
  if (port != null) {
    return `http://127.0.0.1:${resolvePortFlag(port, command)}`;
  }
  return url == null ? null : resolveDevServerUrlFlag(url);
}

/**
 * A `--port` value as a port number.
 *
 * @throws {CommandError} `BAD_ARGS` when the value is not a port.
 */
export function resolvePortFlag(value: unknown, command: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CommandError(
      'BAD_ARGS',
      [
        `--port must be a port number from 1 to 65535, but got ${String(value) || '(nothing)'}.`,
        `Why: it names the port the dev server listens on, which is what this command connects to.`,
        `How: pass one, as in "${PROGRAM_PREFIX} ${command} --port 8081". Leaving it out lets this command find the dev server of this project on its own.`,
      ].join('\n')
    );
  }
  return port;
}

/**
 * The last sentence of a "no dev server answered" error: what to do about the URL.
 *
 * Two answers, and telling them apart is the whole point. A caller that let this CLI find the dev
 * server is told how to name one. A caller that **named** it is not told to name it — that sentence
 * suggested the very flag they had just passed, which reads as if the tool had not noticed
 * [observed — friction run 4, 2026-08-23: `runtime:reload --dev-server-url http://127.0.0.1:9999`].
 * What helps there is that the value they gave is the one that was tried.
 *
 * @param explicit whether the caller named the dev server, with `--dev-server-url` or `--port`.
 */
export function howToNameTheDevServer(explicit: boolean): string {
  return explicit
    ? `The URL above is the one you named, so nothing else was tried — check its host and port against the dev server you meant ("${PROGRAM_PREFIX} status --json" reports this project's).`
    : `Pass --dev-server-url, or --port for one on this machine, to reach a dev server on another host or port.`;
}

/** Header the dev server names the project root it serves in, URI-encoded. */
export const PROJECT_ROOT_HEADER = 'x-react-native-project-root';

/** The header value, URI-decoded, or null when the dev server sent none. */
export function decodeProjectRoot(value: string | null): string | null {
  if (value == null) {
    return null;
  }
  try {
    return decodeURI(value);
  } catch {
    // A value that is not a valid encoding is still the answer the dev server gave.
    return value;
  }
}

/**
 * Whether the dev server's project root and this project's are the same directory.
 *
 * Both sides are resolved through the filesystem when they exist, because a temporary directory is
 * commonly reached through a symlink (`/var` -> `/private/var` on macOS) and two spellings of one
 * directory must not read as two projects. Windows path comparison is case-insensitive.
 */
export function matchProjectRoot(
  reported: string | null,
  projectRoot?: string | null
): boolean | null {
  if (reported == null || projectRoot == null) {
    return null;
  }
  return canonicalPath(reported) === canonicalPath(projectRoot);
}

function canonicalPath(value: string): string {
  const resolved = canonicalizeExistingPath(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Ports `discoverDevServerAsync` scans when no explicit URL was given: Metro's default and
 * the ports `expo start` walks to when 8081 is taken. */
export const DEV_SERVER_SCAN_PORTS = [8081, 8082, 8083, 8084, 8085];

/**
 * Which step of {@link discoverDevServerAsync} produced the URL.
 *
 * Reported rather than kept private because the steps differ in how much they prove: `flag` and
 * `lock` name a dev server on purpose, `log` and `scan` are guesses that happened to answer. A
 * caller reading `scan` knows the caveat below applies to its result, and can pass
 * `--dev-server-url` to remove it.
 */
export type DevServerSource =
  /** An explicit `--dev-server-url`. */
  | 'flag'
  /** The project's dev-server lock, held by an `@expo/agent-cli`-started dev server. */
  | 'lock'
  /** The port the project's own `start.log` last recorded. */
  | 'log'
  /** Metro's default port, 8081. Also the reported source when nothing answered anywhere. */
  | 'default'
  /** One of the fallback ports `expo start` walks to, found by scanning. */
  | 'scan';

export interface DevServerDiscovery extends DevServerProbe {
  /** The dev server origin the probe answered on (the explicit URL, or the discovered one). */
  devServerUrl: string;
  /** The step that produced {@link devServerUrl}. */
  source: DevServerSource;
  /**
   * True when the URL was found rather than named: the lock, the log, or the port scan.
   *
   * Kept as the coarse form of {@link source}, for callers that only ask whether the URL was
   * guessed at.
   */
  discovered: boolean;
  /**
   * Whether discovery proved the server serves this project, per the project-root header of its
   * `GET /status`. `true`: the header matched. `false`: the server sent none (an older dev
   * server), so it is accepted unproved. Absent when nothing was compared: a named URL, the lock,
   * or no `projectRoot` to compare with.
   */
  projectRootVerified?: boolean;
}

/** A dev server the scan reached that serves another project. */
export interface ForeignDevServer {
  url: string;
  port: number;
  /** The project root the server named, decoded. */
  projectRoot: string;
}

/** The two ways of describing one discovery step, so the sources and the flag stay in step. */
function foundBy(source: DevServerSource): { source: DevServerSource; discovered: boolean } {
  return { source, discovered: source === 'lock' || source === 'log' || source === 'scan' };
}

// @ref llp/0004-smart-start-and-project-state.rfc.md §Discovery ladder — the five steps, what
// each one proves, and why none may be skipped on the strength of a faster one.
// @ref llp/0030-one-device-per-agent.rfc.md §Discovery
/**
 * Probe for a dev server. An explicit URL is probed alone (the user named it, so no guessing);
 * without one, 8081 is tried first and, only when it does not answer, the next few ports
 * `expo start` falls back to are scanned in parallel with a short timeout each.
 *
 * A server found by the log or the port scan must prove it is this project's: when `projectRoot`
 * is given, the `X-React-Native-Project-Root` header of its `GET /status` is compared with it. A
 * mismatch is a foreign server and the scan goes on; when nothing else matches, the result is
 * unreachable and names the foreign servers in {@link DevServerProbe.foreignServers}. A server that
 * sends no header is accepted with `projectRootVerified: false`. A server whose `/status` does not
 * answer, even on a second try, proves nothing and is not accepted; the result's reason names it.
 * The explicit URL and the lock are trusted.
 *
 * @param signal the caller's own deadline, for a caller that has one. An **explicit** URL gets no
 *   timeout from this function on purpose — a dev server on another host or behind a tunnel may
 *   legitimately be slow, and cutting it off would report a running server as unreachable — so this
 *   is the only thing that can stop that probe. The scan's own budget applies as well as it, never
 *   instead of it.
 */
export async function discoverDevServerAsync(
  explicitUrl?: string,
  {
    timeoutMs = 800,
    projectRoot,
    signal,
  }: { timeoutMs?: number; projectRoot?: string; signal?: AbortSignal } = {}
): Promise<DevServerDiscovery> {
  if (explicitUrl != null) {
    const probe = await probeDevServerAsync(explicitUrl, { signal });
    return { ...probe, devServerUrl: normalizeDevServerUrl(explicitUrl), ...foundBy('flag') };
  }

  const withTimeout = async (url: string): Promise<DevServerProbe> => {
    const abort = new AbortController();
    const probeSignal = signal == null ? abort.signal : AbortSignal.any([signal, abort.signal]);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        probeDevServerAsync(url, { signal: probeSignal }),
        new Promise<DevServerProbe>((resolve) => {
          timer = setTimeout(() => {
            // The request this gave up on is cancelled, not merely stopped being waited for.
            // Without it, `no answer within ${timeoutMs}ms` is a claim about the report and not
            // about the socket, and the socket is what the process waits on before it exits: a dev
            // server that accepted the connection and then never answered — a Metro mid-restart,
            // from this side — held the process open for undici's 300 s header timeout. Report
            // complete at 3.07 s, process still alive at 45 s; it now exits at 3.12 s
            // [observed — 2026-08-27].
            //
            // The limit, measured rather than assumed: this frees a socket that has *connected*. A
            // socket still in its TCP connect phase is not freed — `fetch` rejects at once and
            // undici keeps the `ConnectWrap` until its own 10 s connect ceiling. That case cannot
            // arise on this ladder, which only ever probes localhost, where a refusal is immediate.
            abort.abort();
            resolve({ reachable: false, targets: [], reason: `no answer within ${timeoutMs}ms` });
          }, timeoutMs);
          // Belt to the `clearTimeout` braces below: a timer this function somehow loses track of
          // still cannot hold the process open on its own.
          timer.unref?.();
        }),
      ]);
    } finally {
      // The probes below answer in about a millisecond — `ECONNREFUSED` on localhost is immediate —
      // and each one used to leave its whole budget pending. A Node process exits when its event
      // loop empties, so six probes' worth of unfired timers were paid at exit rather than in the
      // answer: a default `status` whose report was complete at 263 ms exited at 1584 ms
      // [observed — `friction/run7/tapapp`, 2026-08-27]. The scan was never slow; this was.
      clearTimeout(timer);
    }
  };

  // Step 0 — the project's dev-server lock (`src/devLock/`): a socket an `@expo/agent-cli`-started dev
  // server holds open for as long as it runs, which answers with the URL it listens on. Nothing
  // answers unless a process is alive, so this step has no stale case to guard against. The URL
  // is still probed, never trusted: the lock proves that the wrapper is alive, and the probe
  // proves that the dev server behind it is.
  if (projectRoot != null) {
    const lock = await readDevServerLockAsync(projectRoot);
    if (lock != null) {
      const lockUrl = normalizeDevServerUrl(lock.url);
      const lockProbe = await withTimeout(lockUrl);
      if (lockProbe.reachable) {
        return { ...lockProbe, devServerUrl: lockUrl, ...foundBy('lock') };
      }
    }
  }

  /** Judge a server that answered: accepted (with how well it is proved), foreign, or unproved. */
  const judgeAsync = async (url: string): Promise<Judgement> => {
    if (projectRoot == null) {
      return { kind: 'accepted', verified: undefined };
    }
    let reported = await readReportedProjectRootAsync(url, timeoutMs, signal);
    if (reported.kind === 'unreachable') {
      reported = await readReportedProjectRootAsync(url, timeoutMs, signal);
    }
    const port = Number(new URL(url).port);
    switch (reported.kind) {
      case 'no-header':
        return { kind: 'accepted', verified: false };
      case 'unreachable':
        return { kind: 'unproved', port };
      case 'header':
        return matchProjectRoot(reported.root, projectRoot)
          ? { kind: 'accepted', verified: true }
          : { kind: 'foreign', server: { url, port, projectRoot: reported.root } };
    }
  };
  const foreignServers: ForeignDevServer[] = [];
  const unprovedPorts: number[] = [];
  const recordRejected = (judged: Judgement) => {
    if (judged.kind === 'foreign') {
      foreignServers.push(judged.server);
    } else if (judged.kind === 'unproved') {
      unprovedPorts.push(judged.port);
    }
  };

  // Step 1 — the project's own log: `expo start` logs a `metro:instantiate` event with the port
  // into `.expo/dev/logs/start.log`. Project-scoped, but the log outlives the server that wrote
  // it and names no PID, so the port is only a candidate until it answers a probe *and* its
  // `/status` names this project: another worktree's Metro can bind the port after the logged
  // server is gone. This is what finds a dev server started by `expo start` directly, with no
  // `@expo/agent-cli` wrapper to hold a lock.
  const loggedPort = projectRoot != null ? readLastLoggedDevServerPort(projectRoot) : null;
  let judgedLoggedUrl: string | null = null;
  if (loggedPort != null && loggedPort !== 8081) {
    const loggedUrl = `http://127.0.0.1:${loggedPort}`;
    const loggedProbe = await withTimeout(loggedUrl);
    if (loggedProbe.reachable) {
      const judged = await judgeAsync(loggedUrl);
      if (judged.kind === 'accepted') {
        return {
          ...loggedProbe,
          devServerUrl: loggedUrl,
          ...foundBy('log'),
          ...verifiedField(judged),
        };
      }
      judgedLoggedUrl = loggedUrl;
      recordRejected(judged);
    }
  }

  const defaultProbe = await withTimeout(DEFAULT_DEV_SERVER_URL);
  if (defaultProbe.reachable) {
    const judged = await judgeAsync(DEFAULT_DEV_SERVER_URL);
    if (judged.kind === 'accepted') {
      return {
        ...defaultProbe,
        devServerUrl: DEFAULT_DEV_SERVER_URL,
        ...foundBy('default'),
        ...verifiedField(judged),
      };
    }
    recordRejected(judged);
  }

  const candidates = DEV_SERVER_SCAN_PORTS.slice(1)
    .map((port) => `http://127.0.0.1:${port}`)
    .filter((url) => url !== judgedLoggedUrl);
  const probes = await Promise.all(
    candidates.map(async (url) => {
      const probe = await withTimeout(url);
      return { url, probe, judged: probe.reachable ? await judgeAsync(url) : null };
    })
  );
  for (const { judged } of probes) {
    if (judged != null) {
      recordRejected(judged);
    }
  }
  const accepted = probes.filter(({ judged }) => judged?.kind === 'accepted');
  const hit = accepted.find(({ probe }) => probe.targets.length > 0) ?? accepted.find(() => true);
  if (hit) {
    return {
      ...hit.probe,
      devServerUrl: hit.url,
      ...foundBy('scan'),
      ...verifiedField(hit.judged as AcceptedJudgement),
    };
  }

  if (foreignServers.length > 0 || unprovedPorts.length > 0) {
    const reasons: string[] = [];
    if (foreignServers.length > 0) {
      const named = foreignServers.map((s) => `${s.port} (${s.projectRoot})`).join(', ');
      reasons.push(
        `a dev server answered on port ${named}, but it serves another project, not ${projectRoot}`
      );
    }
    if (unprovedPorts.length > 0) {
      reasons.push(
        `a dev server answered on port ${unprovedPorts.join(', ')}, but its /status did not answer twice within ${timeoutMs}ms, so it is not shown to serve ${projectRoot}`
      );
    }
    return {
      reachable: false,
      targets: [],
      reason: reasons.join('; '),
      ...(foreignServers.length > 0 ? { foreignServers } : {}),
      devServerUrl: DEFAULT_DEV_SERVER_URL,
      ...foundBy('default'),
    };
  }

  // Nothing answered anywhere. The default URL is reported so the caller has a dev server to name
  // in its error, and `default` is the step that produced it.
  return { ...defaultProbe, devServerUrl: DEFAULT_DEV_SERVER_URL, ...foundBy('default') };
}

type AcceptedJudgement = { kind: 'accepted'; verified: boolean | undefined };
type Judgement =
  | AcceptedJudgement
  | { kind: 'foreign'; server: ForeignDevServer }
  /** `/status` never answered, so the server could be anyone's. Not accepted. */
  | { kind: 'unproved'; port: number };

function verifiedField(judged: AcceptedJudgement): { projectRootVerified?: boolean } {
  return judged.verified === undefined ? {} : { projectRootVerified: judged.verified };
}

type ReportedRoot =
  | { kind: 'header'; root: string }
  | { kind: 'no-header' }
  | { kind: 'unreachable' };

/**
 * The project root a dev server names in the headers of `GET /status`, decoded. `no-header` is a
 * server that answered without one (an older dev server); `unreachable` is one that timed out or
 * failed, which proves nothing. `/status` only finishes once the bundler does, but the headers are
 * flushed first, so the request is abandoned as soon as they arrive.
 */
async function readReportedProjectRootAsync(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ReportedRoot> {
  const budget = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(`${url}/status`, {
      signal: signal == null ? budget : AbortSignal.any([signal, budget]),
      headers: { connection: 'close' },
    });
    const root = decodeProjectRoot(response.headers.get(PROJECT_ROOT_HEADER));
    await response.body?.cancel();
    return root == null ? { kind: 'no-header' } : { kind: 'header', root };
  } catch {
    return { kind: 'unreachable' };
  }
}

export interface DevServerProbe {
  /** The dev server answered the debugger target list. */
  reachable: boolean;
  /** Debugger targets the dev server reported. Empty when it is unreachable. */
  targets: CdpTarget[];
  /** Why the dev server could not be reached, for the error message. */
  reason?: string;
  /**
   * Dev servers the port scan reached that serve another project. Set only when that is all it
   * found, so "no dev server" is never said of a machine where another project's server answered.
   */
  foreignServers?: ForeignDevServer[];
}

/**
 * Ask the dev server for its debugger targets.
 *
 * Never throws: an unreachable dev server is an answer, so callers that can work without one
 * (deep-link navigation to a development build) are not forced into a failure path. An abort is one
 * of those answers rather than an exception, for the same reason — the caller that aborted already
 * has the answer it wanted.
 *
 * @param signal cancels the request. Callers that impose a deadline pass one, so the deadline
 *   bounds the socket and not only the wait; callers without one leave the request to undici.
 */
export async function probeDevServerAsync(
  devServerUrl: string,
  { signal }: { signal?: AbortSignal } = {}
): Promise<DevServerProbe> {
  const url = `${normalizeDevServerUrl(devServerUrl)}/json/list`;

  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { connection: 'close' } });
  } catch (error: unknown) {
    return {
      reachable: false,
      targets: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response.ok) {
    return {
      reachable: false,
      targets: [],
      reason: `${url} answered ${response.status} ${response.statusText}`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error: unknown) {
    return {
      reachable: false,
      targets: [],
      reason: `${url} did not answer with JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!Array.isArray(payload)) {
    return { reachable: false, targets: [], reason: `${url} did not answer with an array` };
  }

  return { reachable: true, targets: payload as CdpTarget[] };
}

/**
 * How long a command may keep asking for a debugger target before it reports that none is there.
 *
 * The window an app is invisible in while it reloads [observed — 2026-08-23, live on port 8190:
 * the pre-reload page id was served until 506 ms and the new one appeared at 761 ms]. During it
 * `/json/list` can be empty, and a command that read it once reported "no app is connected" for an
 * app that was on its way back — friction run 4's F39, which made the reload -> errors chain the
 * CLI prints as a follow-up fail one run in three. Bounded on purpose: an app that is genuinely
 * closed has to be reported quickly, so this buys the reconnect window and nothing more.
 */
export const APP_RECONNECT_GRACE_MS = 3000;
