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

import type { CdpTarget } from './cdpClient';
import { debugEvent } from './events';
import { createInspectorWebSocket } from './inspectorSocket';

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

interface ProbeOptions {
  timeoutMs?: number;
  createWebSocket?: (url: string) => WebSocket;
}

/**
 * Ask each listed target whether anything is still behind it.
 *
 * Never throws: a target that refuses is the answer this exists to produce. The probes run in
 * parallel, so the cost is one handshake's latency rather than one per app.
 */
export async function probeTargetLivenessAsync(
  targets: readonly CdpTarget[],
  { timeoutMs = LIVENESS_TIMEOUT_MS, createWebSocket = createInspectorWebSocket }: ProbeOptions = {}
): Promise<TargetLiveness> {
  const results = await Promise.all(
    targets.map(async (target) => ({
      target,
      alive:
        (await probeSocketAsync(target.webSocketDebuggerUrl, {
          timeoutMs,
          createWebSocket,
          ask: false,
        })) !== 'unreachable',
    }))
  );

  const stale = results.filter((result) => !result.alive).map((result) => result.target);
  debugEvent('target_liveness', { listed: targets.length, stale: stale.length });
  return { listed: targets.length, live: results.length - stale.length, stale };
}

/** How long an unplaced target of an EAS Simulator session gets to answer `Runtime.evaluate`. */
export const SESSION_PROBE_TIMEOUT_MS = 1500;

/**
 * The ids of the targets an ended EAS Simulator session left listed. A target is one when its
 * socket opened and it answered nothing within the deadline, and another target of the same device
 * name and app id answered.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
 * An ended session's page stays listed and its socket opens, so the handshake above calls it live.
 * Only a request tells: the page answers nothing. Its device name and app id are the live
 * session's, so an answer from any other device proves nothing about it.
 */
export async function endedSessionTargetIdsAsync(
  targets: readonly CdpTarget[],
  {
    timeoutMs = SESSION_PROBE_TIMEOUT_MS,
    createWebSocket = createInspectorWebSocket,
  }: ProbeOptions = {}
): Promise<string[]> {
  const answers = new Map(
    await Promise.all(
      targets.map(
        async (target) =>
          [
            target.id,
            await probeSocketAsync(target.webSocketDebuggerUrl, {
              timeoutMs,
              createWebSocket,
              ask: true,
            }),
          ] as const
      )
    )
  );
  const answered = targets.filter((target) => answers.get(target.id) === 'answered');
  const dead = targets.filter(
    (target) =>
      answers.get(target.id) === 'opened' &&
      answered.some(
        (other) =>
          !!target.appId && other.appId === target.appId && other.deviceName === target.deviceName
      )
  );
  debugEvent('session_target_probe', {
    timeoutMs,
    answered: answered.length,
    silent: [...answers.values()].filter((answer) => answer === 'opened').length,
    unknown: [...answers.values()].filter((answer) => answer === 'unreachable').length,
    dead: dead.length,
  });
  return dead.map((target) => target.id);
}

/**
 * Open the debugger socket and, with `ask`, send one `Runtime.evaluate` of `1`. `opened` is a socket
 * that opened and gave no answer before the deadline; any reply, a JSON-RPC error included, is
 * `answered`. A socket that fails, closes or never opens is `unreachable`. Without `ask`, the
 * handshake settles it.
 */
function probeSocketAsync(
  url: string,
  {
    timeoutMs,
    createWebSocket,
    ask,
  }: { timeoutMs: number; createWebSocket: (url: string) => WebSocket; ask: boolean }
): Promise<'unreachable' | 'opened' | 'answered'> {
  if (!url) {
    return Promise.resolve('unreachable');
  }
  return new Promise((resolve) => {
    let opened = false;
    let settled = false;
    let socket: WebSocket | undefined;
    const finish = (answer: 'unreachable' | 'opened' | 'answered') => {
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
    const timer = setTimeout(() => finish(opened ? 'opened' : 'unreachable'), timeoutMs);
    timer.unref?.();
    try {
      socket = createWebSocket(url);
    } catch {
      finish('unreachable');
      return;
    }
    socket.on('open', () => {
      if (!ask) {
        finish('opened');
        return;
      }
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
    socket.on('error', () => finish('unreachable'));
    socket.on('close', () => finish('unreachable'));
  });
}
