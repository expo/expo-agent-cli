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
import { probeDevServerAsync } from '../devServer';
import type { CdpTarget } from '../cdpClient';
import { jsContextReplacedAsync } from '../contextReplaced';
import {
  connectMessageSocketAsync,
  peersChanged,
  type DevServerMessageSocket,
  type MessageSocketPeers,
} from '../messageSocket';
import {
  classifyTargets,
  deviceFactsLost,
  deviceInventoryForSelectionAsync,
  EMPTY_DEVICE_INVENTORY,
  skippedAppsOf,
  type DeviceInventory,
  type ClassifiedTargets,
  type TargetSelection,
  type SkippedApp,
} from '../targetSelection';
import { platformOfTarget } from '../targetPlatform';
import type { ReloadAttempt, TargetReloadOutcome } from './attempt';
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

/**
 * How long `Page.reload` has to prove itself on the own targets, cleanup included. Like the churn
 * window, it is separate from `--timeout`: a proof that does not come leaves the rest of the budget
 * to the relaunch.
 */
const PAGE_RELOAD_PROOF_MS = 8000;

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
  /** Listed apps outside `read` that the broadcast also reaches: other-platform and unplaced ones. */
  reachedOutside: number;
  /** The platforms whose served bundle proves the reload: never one an app outside `read` can fetch. */
  bundlePlatforms: NativePlatform[] | 'any';
}

/**
 * Decide rung 1 for one run's classified targets.
 *
 * The scope skips a target by its device name, so a fresh target is skipped by that name too: a
 * page that re-registered has an id the placement never saw. An app outside `read` that this rung
 * reloads, or that a page reload leaves alone, fetches its platform's bundle; one on no known
 * platform could fetch any.
 */
export function rungOnePolicy(
  classifiedTargets: ClassifiedTargets,
  targetSelection: TargetSelection,
  deviceInventory: DeviceInventory
): RungOnePolicy {
  const scoped: NativePlatform[] | 'any' =
    targetSelection.platform == null ? 'any' : [targetSelection.platform.value];
  const broadcast = classifiedTargets.skipped.length === 0;
  const outside = broadcast
    ? [
        ...classifiedTargets.otherPlatform.map((entry) => entry.platform),
        ...classifiedTargets.undetermined.map(() => null),
      ]
    : classifiedTargets.skipped.map(
        ({ target }) => platformOfTarget(target, deviceInventory).platform
      );
  return {
    mechanism: broadcast ? 'broadcast' : 'page-reload',
    skippedApps: broadcast ? [] : skippedAppsOf(classifiedTargets),
    reachedOutside: broadcast ? outside.length : 0,
    bundlePlatforms:
      outside.length === 0 && scoped === 'any'
        ? 'any'
        : (scoped === 'any' ? (['ios', 'android'] as const) : scoped).filter(
            (platform) => !outside.includes(platform) && !outside.includes(null)
          ),
  };
}

/**
 * One observation supplies dispatch, recipients and proof baselines together. Its scope and
 * inventory serve the rest of the run: the evidence, the counts and the relaunch.
 *
 * @param unread why the fresh read failed, so this is an older observation: it may miss an app a
 * broadcast would reach, so none is sent.
 */
export function prepareRungOne(
  targets: CdpTarget[],
  targetSelection: TargetSelection,
  deviceInventory: DeviceInventory,
  unread: string | null = null
) {
  const classifiedTargets = classifyTargets(targets, targetSelection, deviceInventory);
  return {
    targets,
    targetSelection,
    deviceInventory,
    classifiedTargets,
    policy: rungOnePolicy(classifiedTargets, targetSelection, deviceInventory),
    unread,
  };
}
export type PreparedRungOne = ReturnType<typeof prepareRungOne>;

/** A target list and the device facts that placed it. */
export type RungOneObservation = Pick<PreparedRungOne, 'targets' | 'deviceInventory'>;

/**
 * {@link prepareRungOne} on a fresh probe and inventory, inside one deadline. A probe that fails,
 * or a device tool that does not answer where `preflight` had its answer, keeps `preflight`.
 */
export async function prepareRungOneAsync(
  devServerUrl: string,
  projectRoot: string,
  targetSelection: TargetSelection,
  { budgetMs, preflight }: { budgetMs: number; preflight: RungOneObservation | null }
): Promise<PreparedRungOne> {
  const deadline = Date.now() + Math.max(1, budgetMs);
  const left = () => Math.max(1, deadline - Date.now());
  const keep = (unread: string) => {
    const { targets, deviceInventory } = preflight ?? {
      targets: [],
      deviceInventory: EMPTY_DEVICE_INVENTORY,
    };
    return prepareRungOne(targets, targetSelection, deviceInventory, unread);
  };
  const probe = await probeDevServerAsync(devServerUrl, { signal: AbortSignal.timeout(left()) });
  if (!probe.reachable) {
    return keep(`the dev server's target list could not be read again (${probe.reason})`);
  }
  const deviceInventory = await deviceInventoryForSelectionAsync(
    probe.targets,
    targetSelection,
    projectRoot,
    devServerUrl,
    left()
  );
  if (
    preflight &&
    deviceFactsLost(probe.targets, targetSelection, preflight.deviceInventory, deviceInventory)
  ) {
    return keep('the device tools did not answer again');
  }
  return prepareRungOne(probe.targets, targetSelection, deviceInventory);
}

/** What rung 1 came to. `proved` and `acted` keep `auto` on this rung; the rest relaunch. */
export type RungOneOutcome = { attempt: ReloadAttempt; churn: CommandSocketChurn } & (
  | { kind: 'proved'; proof: 'message-socket-peers' | 'debugger-context-replaced' }
  /**
   * The peers churned beside a listed app outside `read`: the churn may be that app's, so a fresh
   * own target or a bundle decides.
   */
  | { kind: 'acted'; reachedOutside: number }
  | {
      /**
       * `delivered`: the reload reached an app and its own proof did not arrive. `not-delivered`:
       * it reached none. `unprovable`: no own target could carry the marker that proves a
       * `Page.reload`, so none was sent.
       */
      kind: 'delivered' | 'not-delivered' | 'unprovable';
      /** The clause the relaunch's attempt opens with. */
      relaunchWhy: string;
    }
);

/**
 * Run rung 1: the broadcast, or `Page.reload` to the own targets while the scope skips an app.
 *
 * @param budgetMs the caller's budget. The rung's own proof is watched for no longer (F95), and
 * each mechanism has its own window inside it: a targeted reload shares one absolute deadline of
 * at most {@link PAGE_RELOAD_PROOF_MS} across every target and all proof phases. The broadcast
 * retains its minimum peer observation window.
 */
export async function runRungOneAsync(
  devServerUrl: string,
  { prepared, budgetMs }: { prepared: PreparedRungOne; budgetMs: number }
): Promise<RungOneOutcome> {
  const { policy, classifiedTargets, targets, unread } = prepared;
  if (policy.mechanism === 'broadcast' && unread != null) {
    return {
      kind: 'not-delivered',
      attempt: {
        method: 'dev-server',
        ok: false,
        reason: `${unread}, so no broadcast was sent: it reaches every app on the dev server, and this run could not see which apps those are`,
        leftAppStopped: null,
      },
      churn: CHURN_NOT_ASKED,
      relaunchWhy: `${unread}, so no broadcast was sent and the app was relaunched instead`,
    };
  }
  if (policy.mechanism === 'page-reload') {
    return await reloadOwnTargetsAsync(devServerUrl, {
      policy,
      own: classifiedTargets.read,
      deadline: Date.now() + Math.min(Math.max(0, budgetMs), PAGE_RELOAD_PROOF_MS),
    });
  }
  const timeoutMs = Math.min(PEER_CHURN_TIMEOUT_MS, Math.max(budgetMs, PEER_POLL_INTERVAL_MS * 2));
  let churn = CHURN_NOT_ASKED;
  const sent = await reloadOverDevServerAsync(devServerUrl, {
    connectedApps: targets.length,
    churnTimeoutMs: timeoutMs,
    onChurn: (seen) => {
      churn = seen;
    },
  });
  const outside = policy.reachedOutside;
  const apps = `${outside} app${outside === 1 ? '' : 's'}`;
  if (sent.ok && outside > 0) {
    const clients = `${churn.reconnected} command socket client${churn.reconnected === 1 ? '' : 's'}`;
    return {
      kind: 'acted',
      reachedOutside: outside,
      attempt: {
        ...sent,
        ok: false,
        delivered: true,
        reason: `${clients} reconnected, but the broadcast also reached ${apps} outside this run's scope, so the churn is not this app's proof`,
      },
      churn,
    };
  }
  if (sent.ok) {
    return { kind: 'proved', proof: 'message-socket-peers', attempt: sent, churn };
  }
  const attempt =
    outside > 0
      ? { ...sent, reason: `${sent.reason}; also reloaded ${apps} not in this run's scope` }
      : sent;
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
 * (`../contextReplaced.ts`). One own target proved is enough: it stops the other checks.
 */
async function reloadOwnTargetsAsync(
  devServerUrl: string,
  { policy, own, deadline }: { policy: RungOnePolicy; own: CdpTarget[]; deadline: number }
): Promise<RungOneOutcome> {
  const provedOne = new AbortController();
  const outcomes = await Promise.all(
    own.map((target) => reloadOwnTargetAsync(devServerUrl, target, deadline, provedOne))
  );
  const proved = outcomes.filter((each) => each.outcome === 'context-replaced');
  const answered = outcomes.filter(
    (each) => each.outcome === 'context-replaced' || each.outcome === 'delivered-unproved'
  );
  const notes = outcomes
    .filter((each) => each.reason)
    .map((each) => `"${each.deviceName}": ${each.reason}`);
  const reloadable = outcomes.filter((each) => each.outcome !== 'unsupported');
  debugEvent('page_reload_sent', { targets: reloadable.length, answered: answered.length });
  const kind =
    proved.length > 0
      ? 'proved'
      : answered.length > 0
        ? 'delivered'
        : reloadable.length > 0 && reloadable.every((each) => each.outcome === 'unmarkable')
          ? 'unprovable'
          : 'not-delivered';
  const names = (kind === 'proved' ? proved : answered)
    .map((each) => `"${each.deviceName}"`)
    .join(', ');
  const clause = {
    proved: `${names} answered from a new JavaScript context after Page.reload`,
    delivered: `${names} answered Page.reload over the debugger, and no new JavaScript context was seen`,
    unprovable:
      'no app of this worktree could carry the marker that proves a Page.reload, so none was sent',
    'not-delivered':
      reloadable.length === 0
        ? 'no app of this worktree takes Page.reload'
        : 'no app of this worktree answered Page.reload',
  }[kind];
  const attempt: ReloadAttempt = {
    method: 'page-reload',
    ok: kind === 'proved',
    delivered: kind === 'proved' || kind === 'delivered',
    outcomes,
    reason: `${clause}${notes.length ? ` (${notes.join('; ')})` : ''}. No broadcast was sent, because the dev server relays it to every app, and this run skips ${policy.skippedApps.length} of them (\`skippedApps\`).`,
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

/** `Page.reload` to one own target, proved on it. The first target proved stops the other checks. */
async function reloadOwnTargetAsync(
  devServerUrl: string,
  target: CdpTarget,
  deadline: number,
  provedOne: AbortController
): Promise<TargetReloadOutcome> {
  const identity = { targetId: target.id, deviceName: target.deviceName };
  if (target.reactNative?.capabilities?.nativePageReloads !== true) {
    return {
      ...identity,
      outcome: 'unsupported',
      reason: 'the target does not support Page.reload',
    };
  }
  try {
    const seen = await jsContextReplacedAsync(devServerUrl, target, {
      act: async (session) =>
        await session.sendAsync(
          'Page.reload',
          {},
          Math.max(1, Math.min(PAGE_RELOAD_ANSWER_MS, deadline - Date.now()))
        ),
      timeoutMs: Math.max(0, deadline - Date.now()),
      deadline,
      signal: provedOne.signal,
    });
    if (seen.kind === 'replaced') {
      provedOne.abort();
      return { ...identity, outcome: 'context-replaced', reason: null };
    }
    if (provedOne.signal.aborted) {
      return { ...identity, outcome: 'not-needed', reason: NOT_NEEDED };
    }
    return {
      ...identity,
      outcome: seen.kind === 'unmarkable' ? 'unmarkable' : 'delivered-unproved',
      reason: seen.reason,
    };
  } catch (error: unknown) {
    return provedOne.signal.aborted
      ? { ...identity, outcome: 'not-needed', reason: NOT_NEEDED }
      : {
          ...identity,
          outcome: 'not-delivered',
          reason: firstLine(error instanceof Error ? error.message : String(error)),
        };
  }
}

const NOT_NEEDED = 'another app of this worktree proved the reload first, so this check stopped';
