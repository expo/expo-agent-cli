// @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads
// Rung 1 of runtime:reload, also used by smoke.

import {
  connectMessageSocketAsync,
  peersChanged,
  type DevServerMessageSocket,
  type MessageSocketPeers,
} from '../messageSocket';
import type { ReloadAttempt } from './attempt';
import { debugEvent } from './events';

/**
 * How long the app's message socket has to come back before the broadcast is judged to have done
 * nothing.
 *
 * Live it takes under a second [observed — 2026-08-23: the app's peer id changed within 500 ms of
 * the broadcast], so this is generous rather than tight. It is separate from `--timeout`, which
 * covers the slower thing: the JavaScript loading and the debugger target re-registering.
 */
export const PEER_CHURN_TIMEOUT_MS = 8000;

/** How often the peers are read while waiting for the app to reconnect. */
export const PEER_POLL_INTERVAL_MS = 250;

/**
 * What the dev server's client command socket was seen to do.
 *
 * @ref llp/0021-honest-reports.rfc.md §The rules — F95.
 *
 * The evidence behind `verifiedBy: 'message-socket-peers'`, and it exists because the label used to
 * have none in the payload. A run reported `verifiedBy: 'message-socket-peers'` beside
 * `appsReconnected: 0` [observed — live tier, 2026-08-27, twice], and a reader reconciling those two
 * numbers was reconciling a label against a **different signal's** count: `appsReconnected` is what
 * `fresh-debugger-target` rests on. Every label now carries its own count, and a label whose count is
 * zero cannot be named (`hasEvidenceFor` in `reloadAsync.ts`).
 */
export interface CommandSocketChurn {
  /**
   * A client the dev server had not listed before registered after the broadcast.
   *
   * Null when the socket was never asked — the rung was skipped, or a pinned `--method` went past it.
   */
  observed: boolean | null;
  /** Clients registered before the broadcast, or null when the dev server did not answer. */
  before: number | null;
  /** Clients registered at the read that ended the wait, or null when there was none. */
  after: number | null;
  /**
   * Client ids present afterwards that were not present before.
   *
   * The number the label rests on, and not the same question as "did the list change": a client that
   * **left** changes the list too, and an app that dropped its connection and did not come back is
   * the failure this count exists to tell apart. The dev server's socket ids come from a counter it
   * never rewinds (`../messageSocket.ts`), so a new id is a new connection.
   */
  reconnected: number;
  /** Why nothing was observed, or null when something was. */
  reason: string | null;
}

/**
 * Reload by broadcasting on the dev server's client command socket.
 *
 * Three steps, and the middle one is the reason this can be trusted. `getpeers` is asked first: it
 * names the clients that are connected *and* proves the dev server speaks this client's protocol
 * version, because a version it does not speak is dropped without an answer. The broadcast is then
 * sent, and the peers are read again until they change — the dev server's socket ids come from a
 * counter that never reuses a value, so a changed id is the app's connection having been replaced.
 */
export async function reloadOverDevServerAsync(
  devServerUrl: string,
  {
    connect = connectMessageSocketAsync,
    churnTimeoutMs = PEER_CHURN_TIMEOUT_MS,
    connectedApps = 0,
    onChurn,
  }: {
    connect?: typeof connectMessageSocketAsync;
    churnTimeoutMs?: number;
    /**
     * Called once with everything this socket was seen to do, whatever the outcome.
     *
     * An out-parameter rather than a second return value, because these are facts for the
     * **report** and not part of what this function decides (llp/0005 §What proves a reload).
     * Called on every path, including the ones that fail before the broadcast: a payload whose
     * evidence field is missing for a run that asked the question is the shape F95 was.
     */
    onChurn?: (churn: CommandSocketChurn) => void;
    /**
     * How many apps `/json/list` named, which is the list the rest of this CLI uses.
     *
     * @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads — K2. An empty peer list is
     * only "no app is connected" when *this* is zero too. Otherwise the app is there and the
     * command socket cannot see it, which is a different sentence and a different next step.
     */
    connectedApps?: number;
  } = {}
): Promise<ReloadAttempt> {
  const failed = (reason: string): ReloadAttempt => ({
    method: 'dev-server',
    ok: false,
    reason,
    leftAppStopped: null,
  });

  let socket: DevServerMessageSocket;
  try {
    socket = await connect(devServerUrl);
  } catch (error: unknown) {
    const reason = `could not open the dev server's command socket: ${error instanceof Error ? error.message : String(error)}`;
    onChurn?.({ observed: null, before: null, after: null, reconnected: 0, reason });
    return failed(reason);
  }

  try {
    const before = await socket.getPeersAsync();
    debugEvent('peers_read', { count: before ? Object.keys(before).length : null, when: 'before' });

    if (before == null) {
      const reason = `the dev server did not answer on its command socket, so it does not speak this protocol version and would have dropped the reload silently${
        connectedApps > 0
          ? ` — while its debugger target list names ${connectedApps} connected app(s), which is the list the debugger method below uses`
          : ''
      }`;
      onChurn?.({ observed: null, before: null, after: null, reconnected: 0, reason });
      return failed(reason);
    }
    if (Object.keys(before).length === 0) {
      // The claim "nothing is connected" is only true when both lists say so. With a debugger
      // target and no peer, the app is running and this socket is the wrong way to reach it — which
      // is what a cloud app over a tunnel was, and what the old wording read as an empty device
      // (K2).
      const reason =
        connectedApps > 0
          ? `no client is registered on the dev server's command socket, while its debugger target list names ${connectedApps} connected app(s) — so the app is running and there is nothing to broadcast to`
          : 'no app is connected to the dev server, so there is nothing to broadcast to';
      onChurn?.({ observed: false, before: 0, after: 0, reconnected: 0, reason });
      return failed(reason);
    }

    socket.broadcastReload();
    debugEvent('broadcast_sent', { devServerUrl });

    const churn = await waitForPeerChurnAsync(socket, before, churnTimeoutMs);
    onChurn?.(churn);
    if (!churn.observed) {
      // Delivered, and unproved. The frame left over a socket whose peer list named a client, so
      // something received it — what is missing is the churn that would show the app acted. The
      // caller reads `delivered` and lets the shared observations decide (F97), rather than reading
      // this as "no mechanism ran" and watching for nothing.
      return {
        ...failed(churn.reason ?? "nothing was seen on the dev server's command socket"),
        delivered: true,
      };
    }
    return {
      method: 'dev-server',
      ok: true,
      reason: `the dev server broadcast the reload and ${churn.reconnected === 1 ? 'the app reconnected' : `${churn.reconnected} clients reconnected`} to its command socket`,
      leftAppStopped: null,
    };
  } finally {
    socket.close();
  }
}

/**
 * Poll the peers until one the dev server had not listed before appears, or the budget runs out.
 *
 * **A new id, not a changed list** (F95). This used to return as soon as `peersChanged` was true, and
 * a list changes in two directions: an app that dropped its connection and had not yet come back
 * satisfied it, and the rung reported the reload as observed off a client *leaving*. The dev server's
 * ids come from a counter it never rewinds (`../messageSocket.ts`), so the honest question is whether
 * an id appeared that was not there before — which is also the count the report has to carry, because
 * a label with no count behind it is the defect this whole field exists to close.
 */
async function waitForPeerChurnAsync(
  socket: DevServerMessageSocket,
  before: MessageSocketPeers,
  timeoutMs: number
): Promise<CommandSocketChurn> {
  const beforeIds = new Set(Object.keys(before));
  const deadline = Date.now() + timeoutMs;
  /** Whether the list moved at all, which tells "it left and stayed away" from "nothing happened". */
  let sawAnyChange = false;
  let lastCount: number | null = beforeIds.size;

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, PEER_POLL_INTERVAL_MS));
    const after = await socket.getPeersAsync({ timeoutMs: PEER_POLL_INTERVAL_MS * 4 });
    const afterIds = after ? Object.keys(after) : [];
    lastCount = after ? afterIds.length : null;
    debugEvent('peers_read', { count: lastCount, when: 'after' });

    const fresh = afterIds.filter((id) => !beforeIds.has(id));
    if (fresh.length > 0) {
      return {
        observed: true,
        before: beforeIds.size,
        after: afterIds.length,
        reconnected: fresh.length,
        reason: null,
      };
    }
    sawAnyChange = sawAnyChange || peersChanged(before, after) === true;

    if (Date.now() >= deadline) {
      return {
        observed: false,
        before: beforeIds.size,
        after: lastCount,
        reconnected: 0,
        reason: sawAnyChange
          ? `the reload was broadcast and the app dropped its connection to the dev server's command socket, but nothing registered a new one within ${timeoutMs}ms — so the app went and did not come back`
          : `the reload was broadcast, but no client reconnected within ${timeoutMs}ms, so the app did not act on it`,
      };
    }
  }
}
