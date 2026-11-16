// @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads
// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
// Rung 1 of `runtime:reload`, which is also the `smoke` gate's reload.
//
// The dev server relays a broadcast to every app that loads from its port. While the run's scope
// skips an app (another worktree's, or one beside the bound device), a broadcast would reload that
// app too. Then rung 1 sends CDP `Page.reload` to this worktree's own targets instead, and proves it
// on those targets. An iOS EAS session takes `Page.reload` too: no broadcast reaches its app through
// the tunnel. A pinned `--method runtime` is rung 1 as `expo.reloadAppAsync(reason)`. Everything
// that follows from that choice is decided here, once.

import type { NativePlatform } from '../../plan/types';
import { probeDevServerAsync } from '../devServer';
import type { CdpTarget } from '../cdpClient';
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
  type DeviceInventory,
  type ClassifiedTargets,
  type TargetSelection,
} from '../targetSelection';
import { platformOfTarget } from '../targetPlatform';
import type { ReloadAttempt, Settled } from './attempt';
import { markBundleSignalSync, type BundleSignalMark } from './bundleSignal';
import { debugEvent } from './events';
import { proofDeadline, reloadInPlaceAsync } from './inPlace';
import type { ReloadMethod } from './resolveOptions';

/**
 * How long the app's message socket has to come back before the broadcast is judged to have done
 * nothing.
 *
 * Live it takes under a second [observed — 2026-08-23: the app's peer id changed within 500 ms of
 * the broadcast], so this is generous rather than tight. It is separate from `--timeout`, which
 * covers the slower thing: the JavaScript loading and the debugger target re-registering.
 */
const PEER_CHURN_TIMEOUT_MS = 8000;

/** How often an unlisted session app is looked for again. */
const RELIST_INTERVAL_MS = 500;

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
 * zero cannot be named (`hasEvidenceFor` in `evidence.ts`).
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

/**
 * How rung 1 reloads. `page-reload`: `skipped-app`, a broadcast would reload an app this run skips;
 * `ios-eas-session`, the SDK 58 iOS app's command socket on an EAS session cannot reach the dev
 * server through the tunnel, so no broadcast arrives (llp/0005 §How it reloads). `runtime`: a pinned
 * `--method runtime`. `none`: the fresh read failed, so an older observation placed the targets; it
 * may miss an app a broadcast would reach, so none is sent.
 */
export type RungOneMechanism =
  | {
      mechanism: 'broadcast';
      /** Listed apps outside `read` that the broadcast also reaches: other-platform and unplaced ones. */
      reachedOutside: number;
    }
  | { mechanism: 'page-reload'; trigger: 'skipped-app' | 'ios-eas-session' }
  | { mechanism: 'runtime' }
  | { mechanism: 'none'; unread: string };

/** What rung 1 does on this run, and which evidence may prove it. */
export type RungOnePolicy = {
  /** The platforms whose served bundle proves the reload: never one an app outside `read` can fetch. */
  bundlePlatforms: NativePlatform[] | 'any';
} & RungOneMechanism;

/**
 * The run's input to rung 1. `method` is the run's `--method`: a pinned `dev-server` broadcasts, as
 * it names, also on an iOS EAS session, and a pinned `runtime` reloads only `read` targets. `smoke`
 * passes `auto`. `unread` says why the fresh read failed, so this is an older observation.
 */
export interface RungOneInput {
  method: ReloadMethod;
  unread?: string | null;
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
  deviceInventory: DeviceInventory,
  { method, unread = null }: RungOneInput
): RungOnePolicy {
  const scoped: NativePlatform[] | 'any' =
    targetSelection.platform == null ? 'any' : [targetSelection.platform.value];
  const trigger =
    classifiedTargets.skipped.length > 0
      ? 'skipped-app'
      : method !== 'dev-server' &&
          targetSelection.device?.backend === 'cloud' &&
          targetSelection.platform?.value === 'ios'
        ? 'ios-eas-session'
        : null;
  // A broadcast reaches every listed app. `Page.reload` and `--method runtime` reach only `read`.
  const reachesAll = method !== 'runtime' && trigger == null;
  const outside = reachesAll
    ? [
        ...classifiedTargets.otherPlatform.map((entry) => entry.platform),
        ...classifiedTargets.undetermined.map(() => null),
      ]
    : classifiedTargets.skipped.map(
        ({ target }) => platformOfTarget(target, deviceInventory).platform
      );
  const mechanism: RungOneMechanism =
    method === 'runtime'
      ? { mechanism: 'runtime' }
      : trigger != null
        ? { mechanism: 'page-reload', trigger }
        : unread != null
          ? { mechanism: 'none', unread }
          : { mechanism: 'broadcast', reachedOutside: outside.length };
  return {
    ...mechanism,
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
 * @param unread why the fresh read failed, so this is an older observation.
 */
export function prepareRungOne(
  targets: CdpTarget[],
  targetSelection: TargetSelection,
  deviceInventory: DeviceInventory,
  input: RungOneInput
) {
  const classifiedTargets = classifyTargets(targets, targetSelection, deviceInventory);
  return {
    targets,
    targetSelection,
    deviceInventory,
    classifiedTargets,
    policy: rungOnePolicy(classifiedTargets, targetSelection, deviceInventory, input),
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
  {
    budgetMs,
    preflight,
    method,
  }: { budgetMs: number; preflight: RungOneObservation | null; method: ReloadMethod }
): Promise<PreparedRungOne> {
  const deadline = Date.now() + Math.max(1, budgetMs);
  const left = () => Math.max(1, deadline - Date.now());
  const keep = (unread: string) => {
    const { targets, deviceInventory } = preflight ?? {
      targets: [],
      deviceInventory: EMPTY_DEVICE_INVENTORY,
    };
    return prepareRungOne(targets, targetSelection, deviceInventory, { method, unread });
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
  return prepareRungOne(probe.targets, targetSelection, deviceInventory, { method });
}

/**
 * Right after `dev`, an iOS EAS session's app may not be listed yet. Read the list again until an
 * own target shows, inside rung 1's window, so `Page.reload` gets what is left of it.
 */
async function prepareOwnListedAsync(
  devServerUrl: string,
  projectRoot: string,
  prepared: PreparedRungOne,
  { deadline, method }: { deadline: number; method: ReloadMethod }
): Promise<PreparedRungOne> {
  const { policy } = prepared;
  if (policy.mechanism !== 'page-reload' || policy.trigger !== 'ios-eas-session') {
    return prepared;
  }
  let current = prepared;
  while (current.classifiedTargets.read.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RELIST_INTERVAL_MS));
    current = await prepareRungOneAsync(devServerUrl, projectRoot, prepared.targetSelection, {
      budgetMs: Math.max(1, deadline - Date.now()),
      preflight: current,
      method,
    });
  }
  return current;
}

/**
 * Rung 1 from one fresh observation: prepare, read the list again while an iOS EAS session's app is
 * not listed yet, mark the dev server's output, and run the mechanism. `--method device` skips the
 * relist and the mechanism, so its `outcome` is null.
 *
 * The mark is taken after the relist and before the mechanism, so everything the bundle watch counts
 * is output the dev server produced because of this run: a first load during the relist is not.
 */
export async function firstStepAsync(
  devServerUrl: string,
  projectRoot: string,
  targetSelection: TargetSelection,
  {
    preflight,
    method,
    remainingMs,
  }: { preflight: RungOneObservation | null; method: ReloadMethod; remainingMs: () => number }
): Promise<{
  prepared: PreparedRungOne;
  bundleMark: BundleSignalMark;
  outcome: RungOneOutcome | null;
}> {
  const first = await prepareRungOneAsync(devServerUrl, projectRoot, targetSelection, {
    budgetMs: remainingMs(),
    preflight,
    method,
  });
  const deadline = proofDeadline(
    first.policy.mechanism === 'runtime' ? 'runtime' : 'page-reload',
    remainingMs()
  );
  const prepared =
    method === 'device'
      ? first
      : await prepareOwnListedAsync(devServerUrl, projectRoot, first, { deadline, method });
  const bundleMark = markBundleSignalSync(projectRoot);
  const outcome =
    method === 'device'
      ? null
      : await runRungOneAsync(devServerUrl, { prepared, budgetMs: remainingMs(), deadline });
  return { prepared, bundleMark, outcome };
}

/** What rung 1 came to. `proved` and `acted` keep `auto` on this rung; the rest relaunch. */
export type RungOneOutcome = { attempt: ReloadAttempt; churn: CommandSocketChurn } & (
  | { kind: 'proved'; proof: Extract<Settled, { kind: 'proved' }>['proof'] }
  /**
   * The peers churned beside a listed app outside `read`: the churn may be that app's, so a fresh
   * own target or a bundle decides.
   */
  | { kind: 'acted'; reachedOutside: number }
  | {
      /**
       * `delivered`: the reload reached an app and its own proof did not arrive. `not-delivered`:
       * it reached none. `unprovable`: no own target could carry the marker that proves an
       * in-place reload, so none was sent.
       */
      kind: 'delivered' | 'not-delivered' | 'unprovable';
      /** The clause the relaunch's attempt opens with. */
      relaunchWhy: string;
    }
);

/** {@link Settled} for rung 1. A pinned `--method runtime` reports `runtime`, every other rung 1 `dev-server`. */
export function settleRungOne(outcome: RungOneOutcome): Settled {
  const method = outcome.attempt.method === 'runtime' ? 'runtime' : 'dev-server';
  switch (outcome.kind) {
    case 'proved':
      return { kind: 'proved', method, proof: outcome.proof };
    case 'acted':
      return { kind: 'observe', method };
    case 'delivered':
      return { kind: 'relaunch', method, why: outcome.relaunchWhy };
    case 'not-delivered':
    case 'unprovable':
      return { kind: 'relaunch', method: null, why: outcome.relaunchWhy };
  }
}

/**
 * Run rung 1: the broadcast, `Page.reload` to the own targets while the scope skips an app or is an
 * iOS EAS session, or `expo.reloadAppAsync` under a pinned `--method runtime`.
 *
 * @param budgetMs the caller's budget. The broadcast's peer churn is watched for no longer (F95),
 * and keeps its minimum observation window.
 * @param deadline the end of rung 1's window (`proofDeadline`), which an in-place mechanism shares
 * across every target and all proof phases.
 */
export async function runRungOneAsync(
  devServerUrl: string,
  {
    prepared,
    budgetMs,
    deadline,
  }: { prepared: PreparedRungOne; budgetMs: number; deadline: number }
): Promise<RungOneOutcome> {
  const { policy, classifiedTargets, targets } = prepared;
  switch (policy.mechanism) {
    case 'none':
      return {
        kind: 'not-delivered',
        attempt: {
          method: 'dev-server',
          ok: false,
          reason: `${policy.unread}, so no broadcast was sent: it reaches every app on the dev server, and this run could not see which apps those are`,
          leftAppStopped: null,
        },
        churn: CHURN_NOT_ASKED,
        relaunchWhy: `${policy.unread}, so no broadcast was sent and the app was relaunched instead`,
      };
    case 'page-reload':
      return await pageReloadAsync(devServerUrl, {
        trigger: policy.trigger,
        own: classifiedTargets.read,
        skips: classifiedTargets.skipped.length,
        deadline,
      });
    case 'runtime':
      return await reloadInPlaceAsync(devServerUrl, {
        mechanism: 'runtime',
        own: classifiedTargets.read,
        deadline,
        churn: CHURN_NOT_ASKED,
      });
    case 'broadcast':
      return await broadcastAsync(devServerUrl, {
        reachedOutside: policy.reachedOutside,
        connectedApps: targets.length,
        budgetMs,
      });
  }
}

/** The broadcast, watched for the peers' churn within the caller's budget. */
async function broadcastAsync(
  devServerUrl: string,
  {
    reachedOutside: outside,
    connectedApps,
    budgetMs,
  }: { reachedOutside: number; connectedApps: number; budgetMs: number }
): Promise<RungOneOutcome> {
  const timeoutMs = Math.min(PEER_CHURN_TIMEOUT_MS, Math.max(budgetMs, PEER_POLL_INTERVAL_MS * 2));
  let churn = CHURN_NOT_ASKED;
  const sent = await reloadOverDevServerAsync(devServerUrl, {
    connectedApps,
    churnTimeoutMs: timeoutMs,
    onChurn: (seen) => {
      churn = seen;
    },
  });
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

const IOS_SESSION_CLAUSE =
  "on an iOS Expo simulator session the app's command socket cannot reach the dev server through the tunnel";

/**
 * Rung 1 as `Page.reload` to the own targets. The scope skips an app, or it is an iOS EAS session
 * whose app no broadcast reaches ({@link rungOnePolicy}); the reason names which.
 */
async function pageReloadAsync(
  devServerUrl: string,
  {
    trigger,
    own,
    skips,
    deadline,
  }: {
    trigger: 'skipped-app' | 'ios-eas-session';
    own: CdpTarget[];
    skips: number;
    deadline: number;
  }
): Promise<RungOneOutcome> {
  const skippedApp = trigger === 'skipped-app';
  return await reloadInPlaceAsync(devServerUrl, {
    mechanism: 'page-reload',
    own,
    deadline,
    why: skippedApp
      ? `No broadcast was sent, because the dev server relays it to every app, and this run skips ${skips} of them (\`skippedApps\`).`
      : `No broadcast was sent: ${IOS_SESSION_CLAUSE}.`,
    churn: {
      ...CHURN_NOT_ASKED,
      reason: skippedApp
        ? "the dev server's command socket was not asked: the scope skips an app, and a broadcast reaches every app"
        : `the dev server's command socket was not asked: ${IOS_SESSION_CLAUSE}`,
    },
  });
}
