// @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads
// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
// Rung 1 of `runtime:reload`, which is also the `smoke` gate's reload.
//
// The dev server relays a broadcast to every app that loads from its port. While the run's scope
// skips an app (another worktree's, or one beside the bound device), a broadcast would reload that
// app too. Then rung 1 sends CDP `Page.reload` to this worktree's own targets instead, and proves it
// on those targets. Everything that follows from that choice is decided here, once.

import type { NativePlatform } from '../../plan/types';
import { firstLine } from '../../utils/text';
import type { CdpTarget } from '../cdpClient';
import { jsContextReplacedAsync } from '../contextReplaced';
import {
  connectMessageSocketAsync,
  peersChanged,
  type DevServerMessageSocket,
  type MessageSocketPeers,
} from '../messageSocket';
import {
  describeSkippedApps,
  skippedAppsOf,
  type DeviceFacts,
  type PlacedTargets,
  type RunScope,
  type SkippedApp,
} from '../runScope';
import { platformOfTarget } from '../targetPlatform';
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
const PEER_CHURN_TIMEOUT_MS = 8000;

/** How often the peers are read while waiting for the app to reconnect. */
const PEER_POLL_INTERVAL_MS = 250;

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
 * zero cannot be named ({@link hasEvidenceFor}).
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

/** The churn of a run that never asked the command socket. */
export const CHURN_NOT_ASKED: CommandSocketChurn = {
  observed: null,
  before: null,
  after: null,
  reconnected: 0,
  reason: "the dev server's command socket was not asked on this run",
};

/** What rung 1 does on this run, and which evidence may prove it. */
export interface RungOnePolicy {
  /** `page-reload` exactly when the scope skips an app. */
  mechanism: 'broadcast' | 'page-reload';
  skippedApps: SkippedApp[];
  /** The platforms whose served bundle proves the reload: never a platform a skipped app is on. */
  bundlePlatforms: NativePlatform[] | 'any';
  /** Whether a target, also one listed later under a new page id, is on a skipped device. */
  isSkipped(target: Pick<CdpTarget, 'deviceName'>): boolean;
}

/**
 * Decide rung 1 for one run's placed targets.
 *
 * The scope skips a target by its device name, so a fresh target is skipped by that name too: a
 * page that re-registered has an id the placement never saw. A skipped app on no known platform
 * could have fetched any platform's bundle.
 */
export function rungOnePolicy(
  placed: PlacedTargets,
  scope: RunScope,
  facts: DeviceFacts
): RungOnePolicy {
  const scoped: NativePlatform[] | 'any' = scope.platform == null ? 'any' : [scope.platform.value];
  const devices = new Set(placed.skipped.map(({ target }) => target.deviceName));
  if (devices.size === 0) {
    return {
      mechanism: 'broadcast',
      skippedApps: [],
      bundlePlatforms: scoped,
      isSkipped: () => false,
    };
  }
  const skippedOn = placed.skipped.map(({ target }) => platformOfTarget(target, facts).platform);
  return {
    mechanism: 'page-reload',
    skippedApps: skippedAppsOf(placed),
    bundlePlatforms: (scoped === 'any' ? (['ios', 'android'] as const) : scoped).filter(
      (platform) => !skippedOn.includes(platform) && !skippedOn.includes(null)
    ),
    isSkipped: (target) => devices.has(target.deviceName),
  };
}

/** What rung 1 came to. Every outcome but `proved` is a reason for `auto` to relaunch. */
export type RungOneOutcome =
  | {
      kind: 'proved';
      proof: 'message-socket-peers' | 'debugger-context-replaced';
      attempt: ReloadAttempt;
      churn: CommandSocketChurn;
    }
  | {
      /**
       * `delivered`: the reload reached an app and its own proof did not arrive. `not-delivered`:
       * it reached none. `unprovable`: no own target could carry the marker that proves a
       * `Page.reload`, so none was sent.
       */
      kind: 'delivered' | 'not-delivered' | 'unprovable';
      attempt: ReloadAttempt;
      churn: CommandSocketChurn;
      /** The clause the relaunch's attempt opens with. */
      relaunchWhy: string;
    };

/**
 * Run rung 1: the broadcast, or `Page.reload` to the own targets while the scope skips an app.
 *
 * @param budgetMs the caller's budget. The rung's own proof is watched for no longer (F95): a
 * `--timeout` the caller chose must not be outlived by a step inside it. The floor keeps at least
 * one read: a budget already spent is still worth one look.
 */
export async function runRungOneAsync(
  devServerUrl: string,
  {
    policy,
    own,
    connectedApps,
    budgetMs,
  }: {
    policy: RungOnePolicy;
    /** The targets this run reads, which are the targets `Page.reload` goes to. */
    own: CdpTarget[];
    /** How many apps `/json/list` named, for the reasons (K2). */
    connectedApps: number;
    budgetMs: number;
  }
): Promise<RungOneOutcome> {
  const timeoutMs = Math.min(PEER_CHURN_TIMEOUT_MS, Math.max(budgetMs, PEER_POLL_INTERVAL_MS * 2));
  if (policy.mechanism === 'page-reload') {
    return await reloadOwnTargetsAsync(devServerUrl, { policy, own, timeoutMs });
  }
  let churn = CHURN_NOT_ASKED;
  const attempt = await reloadOverDevServerAsync(devServerUrl, {
    connectedApps,
    churnTimeoutMs: timeoutMs,
    onChurn: (seen) => {
      churn = seen;
    },
  });
  if (attempt.ok) {
    return { kind: 'proved', proof: 'message-socket-peers', attempt, churn };
  }
  return attempt.delivered
    ? {
        kind: 'delivered',
        attempt,
        churn,
        relaunchWhy:
          "the reload was broadcast to a client on the dev server's command socket and nothing was seen to come of it, so the app was relaunched instead",
      }
    : {
        kind: 'not-delivered',
        attempt,
        churn,
        relaunchWhy:
          "no client was registered on the dev server's command socket, so the app was relaunched instead",
      };
}

/** How long one own target has to answer `Page.reload`. */
const PAGE_RELOAD_ANSWER_MS = 4000;

/**
 * Send `Page.reload` to each own target that takes it, and prove it on that target.
 *
 * The answer `{}` is delivery, not proof, and the target keeps its page id [observed — SDK 58
 * development build, React Native 0.88, iOS 27 simulator, 2026-10-21]. So a marker global is set
 * before the reload, and the reload is proved when the same target answers without it
 * (`../contextReplaced.ts`). One own target proved is enough.
 */
async function reloadOwnTargetsAsync(
  devServerUrl: string,
  { policy, own, timeoutMs }: { policy: RungOnePolicy; own: CdpTarget[]; timeoutMs: number }
): Promise<RungOneOutcome> {
  const reloadable = own.filter(
    (target) => target.reactNative?.capabilities?.nativePageReloads === true
  );
  const answeredBy: string[] = [];
  const notes: string[] = [];
  let unmarkable = 0;
  let replaced = false;
  for (const target of reloadable) {
    try {
      const seen = await jsContextReplacedAsync(devServerUrl, target, {
        act: async (client) => await client.sendAsync('Page.reload', {}, PAGE_RELOAD_ANSWER_MS),
        timeoutMs,
      });
      if (seen.kind === 'unmarkable') {
        unmarkable++;
      } else {
        answeredBy.push(target.deviceName);
      }
      if (seen.kind === 'replaced') {
        replaced = true;
      } else {
        notes.push(`"${target.deviceName}": ${seen.reason}`);
      }
    } catch (error: unknown) {
      notes.push(
        `"${target.deviceName}" did not answer Page.reload: ${firstLine(error instanceof Error ? error.message : String(error))}`
      );
    }
  }
  debugEvent('page_reload_sent', { targets: reloadable.length, answered: answeredBy.length });

  const kind = replaced
    ? 'proved'
    : answeredBy.length > 0
      ? 'delivered'
      : reloadable.length > 0 && unmarkable === reloadable.length
        ? 'unprovable'
        : 'not-delivered';
  const names = answeredBy.map((name) => `"${name}"`).join(', ');
  const clause = {
    proved: `${names} answered Page.reload over the debugger, and a new JavaScript context answered after it`,
    delivered: `${names} answered Page.reload over the debugger, and no new JavaScript context was seen (${notes.join('; ')})`,
    unprovable: `no app of this worktree could carry the marker that proves a Page.reload, so none was sent (${notes.join('; ')})`,
    'not-delivered':
      reloadable.length === 0
        ? 'no app of this worktree takes Page.reload'
        : `no app of this worktree answered Page.reload (${notes.join('; ')})`,
  }[kind];
  const attempt: ReloadAttempt = {
    method: 'page-reload',
    ok: replaced,
    delivered: answeredBy.length > 0,
    answeredBy,
    reason: `${clause}. No broadcast was sent, because the dev server relays it to every app. ${describeSkippedApps(policy.skippedApps)}`,
    leftAppStopped: null,
  };
  const churn = {
    ...CHURN_NOT_ASKED,
    reason:
      "the dev server's command socket was not asked: the scope skips an app, and a broadcast reaches every app",
  };
  return kind === 'proved'
    ? { kind, proof: 'debugger-context-replaced', attempt, churn }
    : {
        kind,
        attempt,
        churn,
        relaunchWhy: `${clause}, so the app was relaunched on this worktree's device instead`,
      };
}
