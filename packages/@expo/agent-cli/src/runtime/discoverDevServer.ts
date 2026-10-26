// @ref llp/0005-runtime-loop-tools.rfc.md
// Find the dev server a runtime command talks to: the discovery ladder over `./devServer.ts`'s probe.

import { readDevServerLockAsync, readLastLoggedDevServerPort } from '../devLock';
import { matchProjectRoot, readReportedProjectRootAsync } from './projectRootHeader';
import {
  DEFAULT_DEV_SERVER_URL,
  DEV_SERVER_SCAN_PORTS,
  normalizeDevServerUrl,
  probeDevServerAsync,
  type DevServerDiscovery,
  type DevServerProbe,
  type DevServerSource,
  type ForeignDevServer,
} from './devServer';

/** The two ways of describing one discovery step, so the sources and the flag stay in step. */
function foundBy(source: DevServerSource): { source: DevServerSource; discovered: boolean } {
  return { source, discovered: source === 'lock' || source === 'log' || source === 'scan' };
}

/**
 * How long a server that answered the probe gets to name its project root on `GET /status`. Longer
 * than the probe's budget, so a `/status` that is slow but answers inside it is accepted; one that
 * stalls past it is unproved, which callers show as not running. `status` passes its own, shorter
 * budget, because it is a report with a deadline where `navigate` is an action.
 */
const STATUS_READ_TIMEOUT_MS = 3000;

// @ref llp/0004-smart-start-and-project-state.rfc.md §Discovery ladder — the five steps, what
// each one proves, and why none may be skipped on the strength of a faster one.
/**
 * Probe for a dev server. An explicit URL is probed alone (the user named it, so no guessing);
 * without one, 8081 is tried first and, only when it does not answer, the next few ports
 * `expo start` falls back to are scanned in parallel with a short timeout each.
 *
 * A server found by the log or the port scan must prove it is this project's: when `projectRoot`
 * is given, the `X-React-Native-Project-Root` header of its `GET /status` is compared with it. A
 * mismatch is a foreign server and the scan goes on; when nothing else matches, the result is
 * unreachable and names the foreign servers in {@link DevServerProbe.foreignServers}. A server that
 * sends no header (an older dev server) is accepted. A server whose `/status` does not answer
 * within `statusTimeoutMs` proves nothing and is not accepted; the reason names it. A socket error
 * on that read gets one retry.
 * The explicit URL and the lock are trusted.
 *
 * @param signal the caller's own deadline, for a caller that has one. An **explicit** URL gets no
 *   timeout from this function on purpose — a dev server on another host or behind a tunnel may
 *   legitimately be slow, and cutting it off would report a running server as unreachable — so this
 *   is the only thing that can stop that probe. The scan's own budget applies as well as it, never
 *   instead of it.
 */
// oxlint-disable-next-line max-lines-per-function -- known debt: split this before it grows
export async function discoverDevServerAsync(
  explicitUrl?: string,
  {
    timeoutMs = 800,
    statusTimeoutMs = STATUS_READ_TIMEOUT_MS,
    projectRoot,
    signal,
    onScanCandidate,
  }: {
    timeoutMs?: number;
    statusTimeoutMs?: number;
    projectRoot?: string;
    signal?: AbortSignal;
    /** The best accepted scan result so far, whenever it changes. Callers with a deadline can
     * retain this result while the remaining ports are judged. Never called after cancellation. */
    onScanCandidate?: (candidate: DevServerDiscovery) => void;
  } = {}
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
  // proves that the dev server behind it is. The lock names its port at the spawn, before Metro
  // binds it, so the server there is this project's only when `/status` names no other project's
  // root (`matchProjectRoot`, the rule every `/status` reader applies). Another root falls through.
  if (projectRoot != null) {
    const lock = await readDevServerLockAsync(projectRoot);
    if (lock != null) {
      const lockUrl = normalizeDevServerUrl(lock.url);
      const lockProbe = await withTimeout(lockUrl);
      if (lockProbe.reachable) {
        // Lazy: `./bundlerStatus` reaches this module through `./waitReady`.
        const { probeBundlerAsync } =
          require('./bundlerStatus') as typeof import('./bundlerStatus');
        const status = await probeBundlerAsync(lockUrl, { timeoutMs, projectRoot });
        if (status.projectRootMatched !== false) {
          return { ...lockProbe, devServerUrl: lockUrl, ...foundBy('lock') };
        }
      }
    }
  }

  /** Judge a server that answered: this project's, foreign, or unproved. */
  const judgeAsync = async (url: string): Promise<Judgement> => {
    if (projectRoot == null) {
      return { kind: 'accepted' };
    }
    let reported = await readReportedProjectRootAsync(url, statusTimeoutMs, signal);
    if (reported.kind === 'unreachable' && !reported.timedOut) {
      // One retry for a socket that hung up at once [observed]; a read that used its budget gets none.
      reported = await readReportedProjectRootAsync(url, statusTimeoutMs, signal);
    }
    const port = Number(new URL(url).port);
    switch (reported.kind) {
      case 'no-header':
        return { kind: 'accepted' };
      case 'unreachable':
        return { kind: 'unproved', port };
      case 'header':
        return matchProjectRoot(reported.root, projectRoot)
          ? { kind: 'accepted' }
          : { kind: 'foreign', server: { port, projectRoot: reported.root } };
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
      };
    }
    recordRejected(judged);
  }

  const candidates = DEV_SERVER_SCAN_PORTS.slice(1)
    .map((port) => `http://127.0.0.1:${port}`)
    .filter((url) => url !== judgedLoggedUrl);
  const accepted: (DevServerDiscovery | undefined)[] = [];
  let published: DevServerDiscovery | undefined;
  const probes = await Promise.all(
    candidates.map(async (url, index) => {
      const probe = await withTimeout(url);
      const judged = probe.reachable ? await judgeAsync(url) : null;
      if (judged?.kind === 'accepted' && !signal?.aborted) {
        // Keep scan order rather than completion order. A fast empty server is a useful fallback,
        // but a later server with targets (or an earlier equally useful port) still takes priority.
        accepted[index] = { ...probe, devServerUrl: url, ...foundBy('scan') };
        const best = selectScanCandidate(accepted);
        if (best && best !== published) {
          published = best;
          onScanCandidate?.(best);
        }
      }
      return { judged };
    })
  );
  for (const { judged } of probes) {
    if (judged != null) {
      recordRejected(judged);
    }
  }
  const hit = selectScanCandidate(accepted);
  if (hit) {
    return hit;
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
        `a dev server answered on port ${unprovedPorts.join(', ')}, but its /status did not answer within ${statusTimeoutMs}ms, so it is not shown to serve ${projectRoot}`
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

/** Prefer listed targets, then scan-port order, for both progress and the final answer. */
function selectScanCandidate(
  accepted: (DevServerDiscovery | undefined)[]
): DevServerDiscovery | undefined {
  return (
    accepted.find((candidate) => candidate != null && candidate.targets.length > 0) ??
    accepted.find((candidate) => candidate != null)
  );
}

type Judgement =
  | { kind: 'accepted' }
  | { kind: 'foreign'; server: ForeignDevServer }
  /** `/status` never answered, so the server could be anyone's. Not accepted. */
  | { kind: 'unproved'; port: number };
