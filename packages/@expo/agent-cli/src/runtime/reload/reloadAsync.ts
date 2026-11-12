// @ref llp/0005-runtime-loop-tools.rfc.md §Reloading the app
// @ref llp/0010-agent-conventions.rfc.md §Other gates, in brief
// Put the running app back on the code that is on disk, and prove that it went.
//
// The friction this exists for [observed — friction run 3, F31, 2026-08-23]: a component threw
// while rendering. The file on disk was fixed, the served bundle was clean, and `dev:wait` exited
// 0 — while the simulator showed a blank screen and `runtime:errors --fail-on-error` kept exiting
// 20 for the *old* error. Every gate in the CLI was asking about the dev server; nothing could see
// the app's own session. The only recovery was `xcrun simctl terminate` by hand.
//
// Reproduced live [observed — 2026-08-23, SDK 57 in Expo Go on iOS] with one correction worth
// carrying: on that SDK Fast Refresh *did* recover the screen, and the error report did not.
// `runtime:errors --duration 3s` returned the same pre-fix error three times in a row against a
// healthy screen, so the debugger replays what the app reported to every new connection. The trap
// is therefore not only stale code — an error window is a property of the app's session, and the
// session outlives the fix. A reload cleared it: `count: 0`, twice.

import { event as cliEvent } from '../../events';
import { EXIT_OK, EXIT_OUTCOME_FAILED, EXIT_OUTCOME_TIMEOUT } from '../../exitCodes';
import {
  buildReloadFollowUps,
  followUpsEnabled,
  reportFollowUps,
  type FollowUp,
} from '../../followups';
import * as Log from '../../log';
import { isFullUrlRoute } from '../../navigate/deepLink';
import { type NavigateDevice } from '../../navigate/device';
import { checkRoute, routeNotFoundError, type RouteCheckJson } from '../../navigate/routeCheck';
import { readProjectRoutesAsync } from '../../project/routes';
import {
  bundleToJson,
  checkEntryBundleAsync,
  resolveBundleCheckPlatformsAsync,
  type BundleCheckJson,
  type BundleCheckResult,
  type BundlePlatformSource,
} from '../bundleCheck';
import { APP_RECONNECT_GRACE_MS, type DevServerSource } from '../devServer';
import { type CdpTarget } from '../cdpClient';
import { preflightRuntimeAsync, type RuntimeConnection } from '../preflight';
import {
  classifyTargets,
  scopeJson,
  skippedAppsOf,
  type ScopeJson,
  type SkippedApp,
} from '../targetSelection';
import { countConnectedAppsAsync } from '../waitReady';
import {
  markBundleSignalSync,
  type BundleSignalMark,
  type BundleSignalObservation,
} from './bundleSignal';
import { reloadOnCloudSimulatorAsync } from './cloudReload';
import { keepsPageId, type ReloadAttempt } from './attempt';
import { observeReloadAsync, type ReloadEvidence, type Unwatched } from './evidence';
import { debugEvent, event } from './events';
import { type ReloadOptions } from './resolveOptions';
import {
  CHURN_NOT_ASKED,
  prepareRungOneAsync,
  runRungOneAsync,
  settleRungOne,
  type CommandSocketChurn,
  type PreparedRungOne,
  type RungOneOutcome,
} from './rungOne';
import { askableInPlace, reloadOverRuntimeAsync } from './inPlace';
import { reloadOnDeviceAsync, openRouteAfterReloadAsync } from './deviceReload';
import { printHumanReport, explainReloadFailure } from './report';

/**
 * Machine shape of `@expo/agent-cli runtime:reload --json`.
 *
 * @ref llp/0006-agent-native-cli-surface.rfc.md §Output contract — one JSON object on stdout,
 * every key always present, and a fact the run does not have is null.
 */
export interface ReloadResultJson {
  /** The app was reloaded, and the reload was observed rather than assumed. */
  reloaded: boolean;
  /** Which method reloaded it, or null when none did. */
  method: 'dev-server' | 'runtime' | 'device' | null;
  /**
   * What proved the reload.
   *
   * `message-socket-peers` — the app's connection to the dev server's command socket was replaced,
   * which the dev server's own never-reused socket ids make unambiguous. `app-relaunch` — the app
   * was stopped on the device and started again, so there was nothing left to keep running.
   * `fresh-debugger-target` — the mechanism had no observation of its own, and the proof is the one
   * {@link appsReconnected} carries: a JavaScript runtime registering under a page id the dev server
   * had never used. `dev-server-bundle` — nor did it, and the proof is the weaker one
   * {@link bundlesAfterReload} carries: the dev server served a bundle after this command acted,
   * which says something fetched it and not *which* client did. `debugger-context-replaced` —
   * rung 1 sent `Page.reload` to this worktree's target, and the same target then answered from a
   * new JavaScript context (llp/0005 §Target owner).
   *
   * The mechanism's own observation wins the label when it has one, because it is the stronger fact;
   * the exit code is decided by the observations rather than by the label (llp/0005 §How it reloads).
   *
   * **One rule, and it is checked rather than intended** (F95, llp/0021 §The rules
   * band): this may name only a signal whose **own** evidence is in this payload and non-empty —
   * `commandSocketChurn.reconnected` for `message-socket-peers`, {@link appsReconnected} for
   * `fresh-debugger-target`, `bundlesAfterReload.count` for `dev-server-bundle`, and an `attempts`
   * entry that stopped and started the app for `app-relaunch`, and a `page-reload` attempt that
   * worked for `debugger-context-replaced`. A label with nothing to show for
   * itself is `null`, which makes `reloaded` false — the band, rather than a claim.
   */
  verifiedBy:
    | 'message-socket-peers'
    | 'fresh-debugger-target'
    | 'app-relaunch'
    | 'dev-server-bundle'
    | 'debugger-context-replaced'
    | null;
  devServerUrl: string;
  devServerSource: DevServerSource;
  /**
   * Debugger targets the dev server reported after the reload: apps with a live JS runtime, not
   * counting the apps in {@link skippedApps}.
   *
   * **Asked again when a proved reload would otherwise report zero** (F141). The watches that prove
   * a reload share one budget and the first to answer ends both, so a run the bundle signal proved
   * left this at whatever the target list held at that instant — which mid-reload is nothing. A zero
   * under `reloaded: true` therefore now means the app really did not register a runtime within the
   * re-registration window, which is a state a cloud session genuinely reaches (S11), and not that
   * this command stopped asking early.
   */
  appsConnected: number;
  /**
   * Clients registered on the dev server's **client command socket**, or null when nothing asked.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads — K2, live 2026-08-27.
   * A different list from {@link appsConnected}, and reported next to it because the
   * two disagree exactly where this command used to go wrong: an app that is bundling over a
   * tunnel is in the debugger list and holds no client here, so "Apps connected 1" printed above a
   * broadcast that reached nobody described two different worlds with one number.
   */
  commandSocketClients: number | null;
  /**
   * What that socket was seen to do: the evidence `verifiedBy: 'message-socket-peers'` rests on.
   *
   * @see CommandSocketChurn — F95. `commandSocketClients` above is a count *before* the broadcast,
   * which is a fact about the world and not about the reload.
   */
  commandSocketChurn: CommandSocketChurn;
  /**
   * How many of those targets the dev server had *not* listed before the reload.
   *
   * The evidence `verifiedBy: 'fresh-debugger-target'` rests on, and the reason it is reported next
   * to {@link appsConnected} rather than instead of it. A reloading app's previous target stays in
   * `/json/list` for about half a second [observed — 2026-08-23, live], so one connected and zero
   * reconnected is an app that has not come back — which is the false success friction run 4
   * recorded as F45, and the flake it recorded as F39.
   *
   * **Zero is not always "the app did not come back"** (F95): the wait for this runs against the
   * bundle watch on one budget, and whichever answers first ends both — so a run proved by another
   * signal leaves this at zero having stopped asking. {@link appsReconnectedReason} is what says
   * which of those a zero is.
   */
  appsReconnected: number;
  /**
   * Why {@link appsReconnected} is zero, or null when it is not zero.
   *
   * A zero used to be a number with no story, sitting under `Reloaded yes` and reading as a
   * contradiction [observed — live tier, 2026-08-27]. Three different facts produce it — nothing was
   * reloaded, another proof ended the wait, or the wait ran out — and they are different next steps.
   */
  appsReconnectedReason: string | null;
  /**
   * What building this project's entry bundle answered, before anything was reloaded.
   *
   * The same object `dev:wait` prints under the same key, because it is the same check
   * (llp/0010 §Other gates, in brief). `ok: false` is the one answer that stops the command.
   */
  bundle: BundleCheckJson;
  /**
   * What the dev server was seen to serve **after** this command acted.
   *
   * @see ./bundleSignal — the second proof, watched on every rung. `observed` is null only when no
   * mechanism ran, so there was nothing to watch for.
   */
  bundlesAfterReload: {
    observed: boolean | null;
    /** How many finished bundles appeared after the relaunch. */
    count: number;
    /** The last of them, verbatim, which is the evidence a reader can check. */
    line: string | null;
    /** Why nothing was observed, or null when something was. */
    reason: string | null;
  };
  /** Every platform whose entry bundle was built, in the order they were. */
  bundlePlatforms: string[];
  /**
   * Where those platforms came from: a flag, the connected apps, or this command's default.
   *
   * @ref ../bundleCheck — friction run 6, F53. The reason it is reported: `for ios` printed by a
   * run that had never asked which app it was reloading read exactly like an answer.
   */
  bundlePlatformSource: BundlePlatformSource;
  /** Which apps this run read: the flags, or the device bound to this worktree (llp/0035 §Readers). */
  scope: ScopeJson;
  /**
   * Apps the scope skipped: rung 1 does not reload them, and no evidence of theirs counts
   * (llp/0005 §Target owner).
   */
  skippedApps: SkippedApp[];
  /** Route the app was sent to afterwards, or null when none was asked for. */
  route: string | null;
  /** Whether that route was checked against the project's routes. */
  routeCheck: RouteCheckJson;
  /** The deep link that was opened for {@link route}, or null when no route was asked for. */
  url: string | null;
  platform: string | null;
  deviceId: string | null;
  /** Every method that was tried, in order, and what each one did. */
  attempts: ReloadAttempt[];
  /** How long the whole reload took, in milliseconds. */
  waitedMs: number;
  followups: FollowUp[];
}

type RemainingMs = () => number;

interface Preflight {
  devServer: RuntimeConnection;
  devServerUrl: string;
  routeCheck: RouteCheckJson;
  bundles: BundleCheckResult[];
  bundle: BundleCheckResult | null;
  bundlePlatformSource: BundlePlatformSource;
  refusal: 'bundle-broken' | 'bundle-timeout' | null;
}

/** The bundle gate refused, so no mechanism ran and nothing was prepared. */
interface RefusedLadder {
  kind: 'refused';
  attempts: ReloadAttempt[];
  method: null;
  device: null;
  cloudUrl: null;
  rungOne: null;
  observedApps: number;
  mechanismProof: null;
  actionConnection: RuntimeConnection;
}

interface ClimbedLadder {
  kind: 'climbed';
  attempts: ReloadAttempt[];
  method: ReloadResultJson['method'];
  device: NavigateDevice | null;
  cloudUrl: string | null;
  prepared: PreparedRungOne;
  rungOne: RungOneOutcome | null;
  bundleMark: BundleSignalMark;
  observedApps: number;
  mechanismProof: ReloadResultJson['verifiedBy'];
  /** The connection the mechanisms act on: the prepared observation's. */
  actionConnection: RuntimeConnection;
}

type LadderOutcome = RefusedLadder | ClimbedLadder;

interface Observation {
  connection: Omit<ReloadEvidence, 'bundle'> & { bundle: BundleSignalObservation | null };
  unwatched: Unwatched | null;
  verifiedBy: ReloadResultJson['verifiedBy'];
  observed: boolean;
  appsConnected: number;
}

/**
 * Reload the app and report what happened.
 *
 * @returns the exit code: `0` reloaded and reconnected, `20` not reloaded, `22` reloaded but the
 * app had not reconnected when the budget ran out (llp/0010 §Exit codes).
 */
export async function reloadAsync(projectRoot: string, options: ReloadOptions): Promise<number> {
  const startedAt = Date.now();
  const { route, json, followups: wantFollowUps } = options;
  const remainingMs = () => Math.max(0, options.timeoutMs - (Date.now() - startedAt));

  const preflight = await preflightAsync(projectRoot, options, remainingMs);
  const ladder = await climbLadderAsync(projectRoot, options, preflight, remainingMs);
  const observation = await observeAsync(projectRoot, options, preflight, ladder, remainingMs);

  // The route is opened after the app is back, not before: Expo Go reloads the URL it was launched
  // with [observed — 2026-08-23: an app deep-linked to `/notes` returns to `/notes` after a
  // reload], so a link sent first would be replaced by the reload rather than survive it. The cloud
  // relaunch is the exception: its own verb carried the route, so opening one again would be a
  // second billed verb for a link the app is already on.
  const landing =
    route != null && ladder.method != null && ladder.cloudUrl == null && observation.observed
      ? await openRouteAfterReloadAsync(projectRoot, options, preflight.devServerUrl, ladder.device)
      : null;
  const device = landing?.device ?? ladder.device;

  const exitCode = exitCodeOf(preflight.refusal, ladder.method, observation.observed);

  const followups =
    followUpsEnabled(wantFollowUps) && exitCode === EXIT_OK
      ? buildReloadFollowUps({
          // The session's platform when no device was resolved: the dev-server method never looks
          // for one, and a run told `--android` still has to hand back Android commands (F54).
          platform: device?.platform ?? options.platform ?? null,
          backend: device?.backend,
          deviceId: device?.deviceId ?? null,
          route,
          adbPath: device?.adb?.bin,
        })
      : [];

  const report = buildReport({
    options,
    preflight,
    ladder,
    observation,
    device,
    url: landing?.url ?? ladder.cloudUrl,
    followups,
    startedAt,
  });

  event('done', {
    reloaded: report.reloaded,
    method: report.method,
    appsConnected: report.appsConnected,
    appsReconnected: report.appsReconnected,
    route: report.route,
  });
  cliEvent('runtime_reload', {
    reloaded: report.reloaded,
    method: report.method,
    appsConnected: report.appsConnected,
    appsReconnected: report.appsReconnected,
  });

  if (json) {
    Log.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report, options);
  }

  if (exitCode !== EXIT_OK) {
    Log.error(
      explainReloadFailure(report, options, {
        unwatched: observation.unwatched,
        rungOne: ladder.rungOne,
      })
    );
  }

  reportFollowUps('runtime:reload', followups, { json });
  return exitCode;
}

async function preflightAsync(
  projectRoot: string,
  options: ReloadOptions,
  remainingMs: RemainingMs
): Promise<Preflight> {
  const { route } = options;

  // @ref ../preflight — the family's one refusal, in the family's one shape. `need: 'dev-server'`
  // and not `'debugger-target'`: this command can *start* an app that is not running, so "no app is
  // connected" is a rung of the ladder below rather than a refusal. A dev server that does not
  // answer is a refusal, because a reload puts the app back on the *served* bundle and stopping the
  // app there would replace a stale screen with no screen.
  const [devServer, routeTable] = await Promise.all([
    preflightRuntimeAsync(
      {
        need: 'dev-server',
        devServerUrl: options.devServerUrl,
        platform: options.platform,
        cloud: options.cloud,
      },
      { projectRoot }
    ),
    readProjectRoutesAsync(projectRoot),
  ]);
  const devServerUrl = devServer.devServerUrl;

  // Before anything is reloaded: a `--route` the project has not got would land the reloaded app
  // on the "Unmatched Route" screen, which is the second failure this command's own friction run
  // reported (llp/0005 §Verifying the route).
  const routeCheck = checkRoute({
    route: route ?? '/',
    table: routeTable,
    enabled: options.routeCheck && route != null,
    // Without `--route` there is no route to check; the reason must not name a flag the caller
    // never passed (friction run 4 follow-up).
    disabledReason:
      route == null ? 'no --route was named, so there was no route to check' : undefined,
    isFullUrl: route != null && isFullUrlRoute(route),
  });
  if (routeCheck.ok === false && route != null) {
    // Named, so the `Try:` line keeps the reload the caller asked for rather than replacing it
    // with a bare `navigate` (friction run 5).
    throw routeNotFoundError(route, routeTable, {
      platform: options.platform,
      command: 'runtime:reload',
    });
  }

  // @ref llp/0010-agent-conventions.rfc.md §Other gates, in brief — friction run 4, F38.
  // The gate that has to come *before* the broadcast. A reload makes the app fetch the served
  // bundle again, so reloading onto a bundle that does not compile puts the app back on the red
  // screen it is already showing — and the old command reported `Reloaded yes` for exactly that.
  //
  // @ref llp/0005-runtime-loop-tools.rfc.md §Android — friction run 6, F53. Which platform to build
  // for is a question about the app being reloaded, and this used to answer it with a host-free
  // default: with an Android-only break and both apps attached, a `runtime:reload` with no flag
  // checked the **iOS** bundle, passed, and reloaded the Android app onto the broken one.
  const { targetSelection, classifiedTargets, deviceInventory } = devServer;
  const { platforms: bundlePlatforms, source: bundlePlatformSource } =
    await resolveBundleCheckPlatformsAsync(targetSelection, classifiedTargets.read, {
      deviceInventory,
    });
  const bundles: BundleCheckResult[] = [];
  if (options.bundleCheck) {
    for (const platform of bundlePlatforms) {
      bundles.push(
        await checkEntryBundleAsync(devServerUrl, {
          platform,
          timeoutMs: remainingMs(),
          projectRoot,
        })
      );
    }
  }
  // A broken bundle decides the reload whichever platform it was found on: reloading onto it is
  // exactly what this gate exists to stop.
  const bundle =
    bundles.find((entry) => entry.outcome === 'broken') ??
    bundles.find((entry) => entry.outcome === 'timeout') ??
    bundles[0] ??
    null;
  // `unknown` passes, the way it does for `dev:wait`: a dev server that answered nothing this CLI
  // understands has not shown the project to be broken, and a refusal there would stop a reload
  // that would have worked and name no fix.
  const refusal: Preflight['refusal'] =
    bundle?.outcome === 'broken'
      ? 'bundle-broken'
      : bundle?.outcome === 'timeout'
        ? 'bundle-timeout'
        : null;

  return {
    devServer,
    devServerUrl,
    routeCheck,
    bundles,
    bundle,
    bundlePlatformSource,
    refusal,
  };
}

/**
 * The targets rung 2 asks, or null when it does not run: all own targets under a pinned
 * `--method runtime`; in `auto`, the own targets that are not Expo Go, after a rung 1 that did not
 * prove the reload.
 */
function rungTwoTargetsOf(
  method: ReloadOptions['method'],
  relaunchWhy: string | null,
  prepared: PreparedRungOne
): CdpTarget[] | null {
  if (method === 'runtime') return prepared.classifiedTargets.read;
  if (method !== 'auto' || relaunchWhy == null) return null;
  const askable = askableInPlace(prepared.classifiedTargets.read);
  return askable.length > 0 ? askable : null;
}

async function climbLadderAsync(
  projectRoot: string,
  options: ReloadOptions,
  { devServer, devServerUrl, refusal }: Preflight,
  remainingMs: RemainingMs
): Promise<LadderOutcome> {
  const { targetSelection } = devServer;
  // The last count anybody actually read, for the runs where no wait happens. Reporting a flat 0
  // for a refusal would be this command inventing "no app is connected" out of a step it skipped,
  // which is the same shape of claim as the ones it exists to remove.
  let observedApps = classifyTargets(devServer.targets, targetSelection, devServer.deviceInventory)
    .read.length;
  if (refusal != null) {
    return {
      kind: 'refused',
      attempts: [],
      method: null,
      device: null,
      cloudUrl: null,
      rungOne: null,
      observedApps,
      mechanismProof: null,
      actionConnection: devServer,
    };
  }

  // Read as late as possible, and always again rather than reusing the discovery probe: these
  // ids are what "the app came back" is measured against, and anything that reloaded the app in
  // the meantime — a save the watcher picked up — would otherwise be credited to this command.
  // @ref llp/0005-runtime-loop-tools.rfc.md §Target owner. Rung 1, and the evidence that counts.
  const prepared = await prepareRungOneAsync(devServerUrl, projectRoot, targetSelection, {
    budgetMs: remainingMs(),
    preflight: devServer,
  });
  const actionConnection: RuntimeConnection = { ...devServer, ...prepared };
  // One inventory for the run: the prepared observation's. Only the whole list's `read` group is
  // this run's: a fresh page, a count or a relaunch id of another app is not.
  const own = (targets: CdpTarget[]) =>
    classifyTargets(targets, targetSelection, actionConnection.deviceInventory).read;
  observedApps = prepared.classifiedTargets.read.length;

  // Where the dev server's captured output stood before anything was reloaded. Marked on every rung
  // (wave 21): "was the app seen to come back" is one question, and a command that answered it two
  // ways depending on where the device was is two commands wearing one name.
  //
  // Marked before any mechanism runs and after the bundle gate, so everything the wait counts is
  // output the dev server produced because of *this* command — the gate's own `HEAD` on the entry
  // bundle would otherwise be evidence for the reload it was gating.
  const bundleMark = markBundleSignalSync(projectRoot);

  // What the mechanism that ran observed *by itself*, apart from the app coming back. Peer churn
  // and a relaunch on a local device are observations already — the dev server's socket ids never
  // repeat, and `simctl terminate` names a process and fails when there is none. A cloud relaunch
  // and a debugger call are not (llp/0005 §Cloud simulator).
  let mechanismProof: ReloadResultJson['verifiedBy'] = null;
  const attempts: ReloadAttempt[] = [];
  let method: ReloadResultJson['method'] = null;
  let device: NavigateDevice | null = null;
  let cloudUrl: string | null = null;
  let rungOne: RungOneOutcome | null = null;
  /**
   * Why rungs 1 and 2 did not prove the reload, or null when one did or none ran.
   *
   * The one fact that makes `auto` climb (F99). Separate from `method`, which names `dev-server`
   * for a delivered reload: the report has to say a mechanism ran, and the ladder has to know it
   * was not *proved* — those are the two halves F97 split apart, and this is the half rungs two and three
   * reads.
   */
  let relaunchWhy: string | null = null;

  // @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads — wave 21.
  //
  // **Rung one: the broadcast, when there is a client to broadcast to** — or `Page.reload` to
  // this worktree's targets while the scope skips an app. `getpeers` answers the first question,
  // and the answer — not `--eas`, not the location of the device — is what picks the rung. A
  // pinned `--method` skips this, as a pinned method always has.
  if (options.method === 'auto' || options.method === 'dev-server') {
    rungOne = await runRungOneAsync(devServerUrl, { prepared, budgetMs: remainingMs() });
    attempts.push(rungOne.attempt);
    // @ref llp/0005 §How it reloads — F97. A delivered or acted reload is a mechanism that ran;
    // its own proof is missing, so the two shared observations below — a fresh debugger target,
    // or a bundle the dev server served — decide. That is the difference between exit `20` and
    // exit `22`, and between watching for the evidence and not looking at all.
    const settled = settleRungOne(rungOne);
    method = settled.ran ? 'dev-server' : null;
    mechanismProof = settled.proof;
    relaunchWhy = settled.relaunchWhy;
  }

  // @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads — rung 2.
  //
  // **Rung two: the app reloads itself**, `expo.reloadAppAsync(reason)`, proved on its target as
  // `Page.reload` is. In `auto` it follows a rung 1 that proved nothing, and never asks Expo Go,
  // where the call can close the app. A pinned `--method runtime` is this rung alone, on any app.
  const rungTwoTargets = rungTwoTargetsOf(options.method, relaunchWhy, prepared);
  if (rungTwoTargets != null) {
    const rungTwo = await reloadOverRuntimeAsync(devServerUrl, rungTwoTargets, remainingMs());
    attempts.push(rungTwo.attempt);
    if (rungTwo.kind === 'proved') {
      method = 'runtime';
      mechanismProof = 'debugger-context-replaced';
      relaunchWhy = null;
    } else {
      method ??= rungTwo.attempt.delivered ? 'runtime' : null;
      relaunchWhy &&= `${rungTwo.clause}, so the app was relaunched on this worktree's device instead`;
    }
  }

  // **Rung three: the relaunch, on the device backend in play.** `--eas` names *which* backend may
  // act: the session's controller (`./cloudReload.ts`, wave 19's two verbs) or a device booted on
  // this machine.
  //
  // Reached whenever rungs 1 and 2 did not prove the reload (`relaunchWhy`), and the second state is F99
  // — the ladder climbing rather than stopping:
  //
  //  1. the reload reached no app: the socket had no client, or no own target took `Page.reload`;
  //  2. the reload **was** delivered and its own proof never arrived. That is the state a live
  //     cloud reload sat in for a whole 180 s budget while the very next command — finding the
  //     socket empty, because the broadcast had taken the client away without reloading
  //     anything — climbed here and exited 0 in 18.5 s [observed — 2026-08-27, live cloud].
  //     Stopping at a rung that was tried and proved nothing is not a ladder, and llp/0005's own
  //     rule is that the state is spent "when nothing cheaper can reach the app".
  //
  // It costs the app's JavaScript state, and `auto` used to refuse rather than spend it — "never
  // force-stop an app the dev server can see" (K2). That rule protected a cheaper alternative,
  // and in neither state above is there one. What replaces the caller's consent is a report the
  // cost is visible in (`withRelaunchCost`). A **pinned** `--method dev-server` never climbs:
  // a caller who named one rung excluded the others, cost and all.
  const relaunchRung =
    options.method === 'device' || (options.method === 'auto' && relaunchWhy != null);
  const why = relaunchWhy ?? '--method device named the relaunch';
  if (relaunchRung && options.cloud) {
    const cloud = await reloadOnCloudSimulatorAsync(projectRoot, options, {
      // Only this worktree's apps: a skipped app's id would relaunch the wrong app.
      targetAppIds: own(prepared.targets)
        .map((target) => target.appId)
        .filter(Boolean),
    });
    attempts.push(withRelaunchCost(cloud.attempt, observedApps, why));
    device = cloud.device;
    cloudUrl = cloud.url;
    if (cloud.attempt.ok) {
      // Deliberately **no** mechanism proof: neither controller verb answers about the app it was
      // given (llp/0005 §Cloud simulator), so until the wait below observes
      // something this is a mechanism that ran rather than a reload that happened.
      method = 'device';
    }
  } else if (relaunchRung) {
    const attempt = await reloadOnDeviceAsync(projectRoot, options, devServerUrl, own);
    attempts.push(withRelaunchCost(attempt.attempt, observedApps, why));
    device = attempt.device;
    if (attempt.attempt.ok) {
      method = 'device';
      mechanismProof = 'app-relaunch';
    }
  }

  return {
    kind: 'climbed',
    attempts,
    method,
    device,
    cloudUrl,
    prepared,
    rungOne,
    bundleMark,
    observedApps,
    mechanismProof,
    actionConnection,
  };
}

async function observeAsync(
  projectRoot: string,
  options: ReloadOptions,
  { devServerUrl }: Preflight,
  ladder: LadderOutcome,
  remainingMs: RemainingMs
): Promise<Observation> {
  // The app has to come back with a JavaScript runtime the rest of the CLI can read, so the wait is
  // on the debugger target list rather than on the socket that proved the reload — and on a target
  // the dev server had *not* listed before, because the one it had is the runtime on its way out.
  // Peer churn proves the app acted on the broadcast; only a new target proves it came back. The
  // last read this wait makes is the re-read of the target list, so a success is never a peer count:
  // it is a runtime that was observed after the reload.
  //
  // Watched **alongside** the dev server's own output, on every rung. Some apps register no debugger
  // target at all — Expo Go loaded this project on a cloud session and `/json/list` stayed empty for
  // three minutes [observed — live run S11] — and a relaunched app re-registers under the page
  // id it had before, so on both of those the bundle the dev server finished is the observation that
  // is left (`./bundleSignal.ts`).
  const seen =
    ladder.kind === 'climbed' && ladder.method != null
      ? await observeReloadAsync(devServerUrl, projectRoot, {
          prepared: ladder.prepared,
          mechanismProof: ladder.mechanismProof,
          churn: ladder.rungOne?.churn ?? CHURN_NOT_ASKED,
          attempts: ladder.attempts,
          bundleMark: ladder.bundleMark,
          timeoutMs: remainingMs(),
        })
      : null;
  const unwatched: Unwatched | null = seen?.unwatched ?? null;
  const connection = seen?.evidence ?? {
    appsConnected: ladder.observedApps,
    freshTargets: 0,
    timedOut: false,
    waitedMs: 0,
    bundle: null,
  };
  const bundleObservation = connection.bundle;
  const verifiedBy = seen?.verifiedBy ?? null;
  /** The app was seen to be back: the same question, answered the same way, on every rung. */
  const observed =
    unwatched === 'context-replaced' ||
    connection.freshTargets > 0 ||
    bundleObservation?.observed === true;

  // @ref llp/0005-runtime-loop-tools.rfc.md §What proves a reload — **F141.** `appsConnected` is
  // the *last* read the wait above made, and the two watches share one budget: a run the bundle
  // signal proved aborts the target watch where it stands, which inside the app's re-registration
  // window is on an empty list. So a proved reload printed `Reloaded yes` over `Apps connected 0`,
  // which reads as a contradiction — and was worse than a contradiction, because the commands this
  // reload's own follow-ups name read that same list, and they were the ones that found it empty and
  // refused [observed — friction run 9].
  //
  // The number is not wrong, it is early. Asked again for the length of the window that hides an app
  // (`APP_RECONNECT_GRACE_MS`, F39's own), it either finds the runtime that came back — and the next
  // command in the chain finds it too — or it does not, and then zero is a fact about an app that is
  // genuinely not there and the report says so in words.
  const reconnectBudget = Math.min(APP_RECONNECT_GRACE_MS, remainingMs());
  const appsConnected =
    observed && connection.appsConnected === 0
      ? await countConnectedAppsAsync(devServerUrl, reconnectBudget, ladder.actionConnection)
      : connection.appsConnected;

  if (bundleObservation != null) {
    debugEvent('bundle_observed', {
      observed: bundleObservation.observed,
      newBundles: bundleObservation.newBundles,
      waitedMs: bundleObservation.waitedMs,
    });
  }

  return { connection, unwatched, verifiedBy, observed, appsConnected };
}

/**
 * A bundle that does not compile is `20` and a bundle that was still building is `22`, for the
 * reason llp/0010 gives `dev:wait`: a file with a syntax error in it does not parse on the second
 * look, and a cold first build really is worth looking at again.
 *
 * Then one rule for every rung (llp/0005 §How it reloads): no mechanism ran is `20`, a mechanism ran
 * and nothing was **observed** is `22` — the app may be back invisibly or may not be back, which
 * is "look again" rather than "it failed" — and an observation is `0`.
 */
function exitCodeOf(
  refusal: Preflight['refusal'],
  method: ReloadResultJson['method'],
  observed: boolean
): number {
  return refusal === 'bundle-broken'
    ? EXIT_OUTCOME_FAILED
    : refusal === 'bundle-timeout'
      ? EXIT_OUTCOME_TIMEOUT
      : method == null
        ? EXIT_OUTCOME_FAILED
        : observed
          ? EXIT_OK
          : EXIT_OUTCOME_TIMEOUT;
}

function buildReport({
  options,
  preflight: { devServer, devServerUrl, routeCheck, bundles, bundle, bundlePlatformSource },
  ladder: { method, rungOne, attempts, actionConnection },
  observation: { connection, unwatched, verifiedBy, appsConnected },
  device,
  url,
  followups,
  startedAt,
}: {
  options: ReloadOptions;
  preflight: Preflight;
  ladder: LadderOutcome;
  observation: Observation;
  device: NavigateDevice | null;
  url: string | null;
  followups: FollowUp[];
  startedAt: number;
}): ReloadResultJson {
  const bundleObservation = connection.bundle;
  return {
    // An **observed** reload, and nothing weaker. `method != null` says a mechanism ran, which on a
    // cloud session is a controller that accepted a verb and answers about no app in particular.
    reloaded: verifiedBy != null,
    method,
    verifiedBy,
    devServerUrl,
    devServerSource: devServer.devServerSource,
    appsConnected,
    // Read whenever the command socket is opened at all, and reported next to the debugger-target
    // count rather than instead of it (llp/0005 §What proves a reload).
    commandSocketClients: rungOne?.churn.before ?? null,
    // The evidence behind `verifiedBy: 'message-socket-peers'` (F95). Its own default says the socket
    // was never asked, which is the truth for every run that skipped the rung.
    commandSocketChurn: rungOne?.churn ?? CHURN_NOT_ASKED,
    appsReconnected: connection.freshTargets,
    appsReconnectedReason: describeNoReconnection({
      method,
      freshTargets: connection.freshTargets,
      bundle: bundleObservation,
      timedOut: connection.timedOut,
      timeoutMs: options.timeoutMs,
    }),
    // The same flag as `dev:wait`'s, so the reason a null bundle carries is the same sentence
    // whichever command asked the question (llp/0010 §Other gates, in brief).
    bundle: bundleToJson(bundle, { skippedByFlag: !options.bundleCheck }),
    bundlesAfterReload: {
      observed: bundleObservation ? bundleObservation.observed : null,
      count: bundleObservation?.newBundles ?? 0,
      line: bundleObservation?.last?.text ?? null,
      reason: bundleObservation
        ? bundleObservation.reason
        : unwatched === 'context-replaced'
          ? "not watched: a new JavaScript context on this worktree's app already proved the reload"
          : unwatched === 'nothing-can-prove'
            ? `not watched: ${keepsPageId(attempts)}, and no bundle may count on this run, so nothing could prove the reload`
            : 'nothing watched the dev server output: no mechanism ran, so there was nothing to watch for',
    },
    bundlePlatforms: bundles.map((entry) => entry.platform),
    bundlePlatformSource,
    skippedApps: skippedAppsOf(actionConnection.classifiedTargets),
    scope: scopeJson(devServer.targetSelection),
    route: options.route,
    routeCheck,
    url,
    platform: device?.platform ?? null,
    deviceId: device?.deviceId ?? null,
    attempts,
    waitedMs: Date.now() - startedAt,
    followups,
  };
}

/**
 * Why nothing reconnected on the debugger target list, or null when something did.
 *
 * F95. Three facts produce a zero and they are three different next steps, and the report used to
 * carry the number with none of them: `appsReconnected: 0` under `Reloaded yes` reads as a
 * contradiction, and the reader cannot tell "the app did not come back" from "this watch was ended by
 * the other proof answering first" — which is what `waitForReloadEvidenceAsync` does by design.
 */
function describeNoReconnection({
  method,
  freshTargets,
  bundle,
  timedOut,
  timeoutMs,
}: {
  method: ReloadResultJson['method'];
  freshTargets: number;
  bundle: BundleSignalObservation | null;
  timedOut: boolean;
  timeoutMs: number;
}): string | null {
  if (freshTargets > 0) {
    return null;
  }
  if (method == null) {
    return 'no reload happened, so nothing had reason to reconnect';
  }
  if (bundle?.observed === true) {
    return 'the dev server was seen to serve a bundle first, which ended this watch — so this is not a count of an app that failed to come back';
  }
  if (timedOut) {
    return `the dev server listed no debugger target it had not listed before within ${timeoutMs}ms`;
  }
  return 'nothing was watched for a fresh debugger target on this run';
}

/**
 * Say on the attempt what the relaunch cost, when it cost anything.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads — wave 21.
 *
 * The relaunch replaces the app's process, so everything the JavaScript was holding is gone. Until
 * wave 21 `auto` refused to spend that on an app the dev server could see, and the caller had to ask
 * for it by name; now the ladder spends it when nothing cheaper can reach the app, so the report is
 * where the cost has to be visible. Only when an app was **there** to lose state: a relaunch that
 * started an app that was not running cost nothing.
 *
 * **And it says which of the two reasons the rung was reached for** (F99). There are two, they are
 * not interchangeable, and the first live run of the climb printed the wrong one: "no client was
 * registered on the dev server's command socket" over a payload whose own `commandSocketClients`
 * was `1` [observed — live cloud, 2026-08-27]. A reader who checks the number against the sentence
 * finds the report arguing with itself, which is the class of thing llp/0021 exists to remove.
 */
function withRelaunchCost(
  attempt: ReloadAttempt,
  connectedApps: number,
  why: string
): ReloadAttempt {
  if (!attempt.ok || connectedApps === 0) {
    return attempt;
  }
  return {
    ...attempt,
    reason: `${why} — which costs the app's JavaScript state: ${attempt.reason}`,
  };
}
