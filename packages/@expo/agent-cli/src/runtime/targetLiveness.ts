// @ref llp/0005-runtime-loop-tools.rfc.md §Android
// Which of the debugger targets the dev server lists can still be talked to.
//
// The dev server's `/json/list` is a list of *registrations*, not of live runtimes. When an app is
// force-stopped and started again, the old page can stay in that list — so `@expo/agent-cli status` said
// `1 app connected` while every runtime command answered `No target found`, one counting the
// listing and the other counting what it could reach [observed — friction run 6 (Android),
// 2026-08-24, F56]. Both numbers were right about different things, and a caller reading one and
// then running the other had no way to know that.
//
// The test is the one the runtime commands already apply without saying so: **open the socket**.
// A registration nothing is behind refuses the handshake or closes it, and a live runtime accepts —
// including the Expo Go Android runtime, which accepts the connection and then has nothing to say
// (`./runtimeErrorCollector.ts`). So this asks nothing of the runtime beyond the handshake, and
// stays honest for a runtime that cannot answer anything else.

import type { WebSocket } from 'ws';

import { createInspectorWebSocket, type CdpTarget } from './cdpClient';
import { debugEvent } from './events';

/** How long one handshake gets before the target is called unreachable. */
const LIVENESS_TIMEOUT_MS = 1500;

export interface TargetLiveness {
  /** Targets the dev server listed. */
  listed: number;
  /** Of those, the ones whose debugger socket opened. */
  live: number;
  /** The ones that did not, which is what "stale" means here: listed and unreachable. */
  stale: CdpTarget[];
}

/**
 * Ask each listed target whether anything is still behind it.
 *
 * Never throws: a target that refuses is the answer this exists to produce. The probes run in
 * parallel, so the cost is one handshake's latency rather than one per app.
 */
export async function probeTargetLivenessAsync(
  targets: readonly CdpTarget[],
  {
    timeoutMs = LIVENESS_TIMEOUT_MS,
    createWebSocket = createInspectorWebSocket,
  }: { timeoutMs?: number; createWebSocket?: (url: string) => WebSocket } = {}
): Promise<TargetLiveness> {
  const results = await Promise.all(
    targets.map(async (target) => ({
      target,
      alive: await opensAsync(target.webSocketDebuggerUrl, timeoutMs, createWebSocket),
    }))
  );

  const stale = results.filter((result) => !result.alive).map((result) => result.target);
  debugEvent('target_liveness', { listed: targets.length, stale: stale.length });
  return { listed: targets.length, live: results.length - stale.length, stale };
}

/** Whether a debugger socket opens within the budget. Closed again immediately either way. */
function opensAsync(
  url: string,
  timeoutMs: number,
  createWebSocket: (url: string) => WebSocket
): Promise<boolean> {
  if (!url) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // A socket that will not close changes nothing about the answer.
      }
      resolve(alive);
    };

    let socket: WebSocket;
    try {
      socket = createWebSocket(url);
    } catch {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.on('open', () => finish(true));
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
}

/** How long an unplaced target of an EAS Simulator session gets to answer `Runtime.evaluate`. */
export const SESSION_PROBE_TIMEOUT_MS = 1500;

type ProbeAnswer = 'answered' | 'silent' | 'unknown';

/**
 * The ids of the targets an ended EAS Simulator session left listed: each one opened its socket and
 * answered nothing within the deadline. Empty unless one of `targets` answered.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
 * An ended session's page stays listed and its socket opens, so the handshake above calls it live.
 * Only a request tells: the page answers nothing.
 */
export async function endedSessionTargetIdsAsync(
  targets: readonly CdpTarget[],
  {
    timeoutMs = SESSION_PROBE_TIMEOUT_MS,
    createWebSocket = createInspectorWebSocket,
  }: { timeoutMs?: number; createWebSocket?: (url: string) => WebSocket } = {}
): Promise<string[]> {
  const answers = await Promise.all(
    targets.map((target) => askAsync(target.webSocketDebuggerUrl, timeoutMs, createWebSocket))
  );
  const silent = targets.filter((_, at) => answers[at] === 'silent').map((target) => target.id);
  debugEvent('target_liveness', { listed: targets.length, stale: silent.length });
  return answers.includes('answered') ? silent : [];
}

/**
 * One `Runtime.evaluate` of `1`. `silent` is the only verdict of death: the socket opened and the
 * deadline passed with no answer. A socket that closes, fails or never opens is `unknown`.
 */
function askAsync(
  url: string,
  timeoutMs: number,
  createWebSocket: (url: string) => WebSocket
): Promise<ProbeAnswer> {
  if (!url) {
    return Promise.resolve('unknown');
  }
  return new Promise<ProbeAnswer>((resolve) => {
    let opened = false;
    let settled = false;
    let socket: WebSocket | undefined;
    const finish = (answer: ProbeAnswer) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // A socket that will not close changes nothing about the answer.
      }
      resolve(answer);
    };
    const timer = setTimeout(() => finish(opened ? 'silent' : 'unknown'), timeoutMs);
    timer.unref?.();
    try {
      socket = createWebSocket(url);
    } catch {
      finish('unknown');
      return;
    }
    socket.on('open', () => {
      opened = true;
      socket!.send(
        JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1' } })
      );
    });
    socket.on('message', (data) => {
      try {
        if (JSON.parse(String(data)).id === 1) {
          finish('answered');
        }
      } catch {
        // Not an answer to this request.
      }
    });
    socket.on('error', () => finish('unknown'));
    socket.on('close', () => finish('unknown'));
  });
}
