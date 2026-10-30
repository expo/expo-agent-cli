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

import chalk from 'chalk';

import { isTunnelCurrent, resolveDevServerReachAsync } from '../../dev/advertisedUrl';
import { AGENT_DEVICE_SPEC } from '../../device/cloudSimulator';
import { liveCloudBindings } from '../../deviceBinding/cloud';
import { event as cliEvent } from '../../events';
import { EXIT_OK, EXIT_OUTCOME_FAILED, EXIT_OUTCOME_TIMEOUT } from '../../exitCodes';
import {
  buildReloadFollowUps,
  followUpsEnabled,
  reportFollowUps,
  type FollowUp,
} from '../../followups';
import * as Log from '../../log';
import {
  isFullUrlRoute,
  openUrlOnDeviceAsync,
  resolveDeepLinkUrl,
  readProjectSchemeConfig,
} from '../../navigate/deepLink';
import { resolveDeviceAsync, type NavigateDevice } from '../../navigate/device';
import { isCallerNamedDevServer } from '../../navigate/routeResolution';
import { checkRoute, routeNotFoundError, type RouteCheckJson } from '../../navigate/routeCheck';
import { decideExpoGoTarget } from '../../navigate/target';
import type { PlanPlatform } from '../../plan/types';
import { PROGRAM_PREFIX } from '../../programName';
import { smokeCommand, statedSmokePlatform } from '../../smoke/suggest';
import { checkExpoGoCompatibilityAsync, decidesAgainstExpoGo } from '../../project/expoGo';
import { readProjectNativeDirsAsync } from '../../project/nativeCode';
import {
  isInstalledDependencyAsync,
  listDependencyNames,
  readProjectPackageJsonAsync,
} from '../../project/nodeModules';
import { readProjectRoutesAsync } from '../../project/routes';
import { readConfiguredAppId, resolveAppId } from '../appId';
import { stopAppOnDeviceAsync } from '../appProcess';
import {
  bundleToJson,
  checkEntryBundleAsync,
  resolveBundleCheckPlatformsAsync,
  type BundleCheckJson,
  type BundleCheckResult,
  type BundlePlatformSource,
} from '../bundleCheck';
import { APP_RECONNECT_GRACE_MS, type DevServerSource } from '../devServer';
import type { CdpTarget } from '../cdpClient';
import { preflightRuntimeAsync, type RuntimeConnection } from '../preflight';
import {
  classifyTargets,
  describeSkippedApps,
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
import { keepsPageId, settledAttempt, type ReloadAttempt } from './attempt';
import { describeEvidence, observeReloadAsync, type Unwatched } from './evidence';
import { debugEvent, event } from './events';
import type { ReloadOptions } from './resolveOptions';
import {
  CHURN_NOT_ASKED,
  prepareRungOneAsync,
  runRungOneAsync,
  settleRungOne,
  type CommandSocketChurn,
  type PreparedRungOne,
  type RungOneOutcome,
} from './rungOne';
import { easCommandPrefix } from '../../utils/easCli';
import { firstLine } from '../../utils/text';

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

/**
 * Reload the app and report what happened.
 *
 * @returns the exit code: `0` reloaded and reconnected, `20` not reloaded, `22` reloaded but the
 * app had not reconnected when the budget ran out (llp/0010 §Exit codes).
 */
// oxlint-disable-next-line max-lines-per-function -- known debt: split this before it grows
export async function reloadAsync(projectRoot: string, options: ReloadOptions): Promise<number> {
  const startedAt = Date.now();
  const { route, json, followups: wantFollowUps } = options;

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
  const remainingMs = () => Math.max(0, options.timeoutMs - (Date.now() - startedAt));

  // @ref llp/0005-runtime-loop-tools.rfc.md §Android — friction run 6, F53. Which platform to build
  // for is a question about the app being reloaded, and this used to answer it with a host-free
  // default: with an Android-only break and both apps attached, a `runtime:reload` with no flag
  // checked the **iOS** bundle, passed, and reloaded the Android app onto the broken one.
  const { targetSelection, classifiedTargets } = devServer;
  let actionConnection = devServer;
  const { deviceInventory } = devServer;
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
  const refusal: 'bundle-broken' | 'bundle-timeout' | null =
    bundle?.outcome === 'broken'
      ? 'bundle-broken'
      : bundle?.outcome === 'timeout'
        ? 'bundle-timeout'
        : null;

  const attempts: ReloadAttempt[] = [];
  let method: ReloadResultJson['method'] = null;
  let device: NavigateDevice | null = null;
  // Read whenever the command socket is opened at all, and reported next to the debugger-target
  // count rather than instead of it (llp/0005 §What proves a reload).
  let commandSocketClients: number | null = null;
  // The evidence behind `verifiedBy: 'message-socket-peers'` (F95). Its own default says the socket
  // was never asked, which is the truth for every run that skipped the rung.
  let commandSocketChurn = CHURN_NOT_ASKED;
  // Where the dev server's captured output stood before anything was reloaded. Marked on every rung
  // (wave 21): "was the app seen to come back" is one question, and a command that answered it two
  // ways depending on where the device was is two commands wearing one name.
  let bundleMark: BundleSignalMark | null = null;
  let cloudUrl: string | null = null;
  // @ref llp/0005-runtime-loop-tools.rfc.md §Target owner. Rung 1, and the evidence that counts.
  let prepared: PreparedRungOne | null = null;
  let rungOne: RungOneOutcome | null = null;
  // One inventory for the run: the prepared observation's, once rung 1 prepared it. Only the whole
  // list's `read` group is this run's: a fresh page, a count or a relaunch id of another app is not.
  const own = (targets: CdpTarget[]) =>
    classifyTargets(targets, targetSelection, actionConnection.deviceInventory).read;
  // The last count anybody actually read, for the runs where no wait happens. Reporting a flat 0
  // for a refusal would be this command inventing "no app is connected" out of a step it skipped,
  // which is the same shape of claim as the ones it exists to remove.
  let observedApps = own(devServer.targets).length;

  // What the mechanism that ran observed *by itself*, apart from the app coming back. Peer churn
  // and a relaunch on a local device are observations already — the dev server's socket ids never
  // repeat, and `simctl terminate` names a process and fails when there is none. A cloud relaunch
  // and a debugger call are not (llp/0005 §Cloud simulator).
  let mechanismProof: ReloadResultJson['verifiedBy'] = null;

  /**
   * Why rung 1 did not prove the reload, or null when it did or did not run.
   *
   * The one fact that makes `auto` climb (F99). Separate from `method`, which names `dev-server`
   * for a delivered reload: the report has to say a mechanism ran, and the ladder has to know it
   * was not *proved* — those are the two halves F97 split apart, and this is the half rung two
   * reads.
   */
  let relaunchWhy: string | null = null;

  if (refusal == null) {
    // Read as late as possible, and always again rather than reusing the discovery probe: these
    // ids are what "the app came back" is measured against, and anything that reloaded the app in
    // the meantime — a save the watcher picked up — would otherwise be credited to this command.
    const before = await prepareRungOneAsync(devServerUrl, projectRoot, targetSelection, {
      budgetMs: remainingMs(),
      preflight: devServer,
    });
    prepared = before;
    actionConnection = { ...devServer, ...before };
    observedApps = before.classifiedTargets.read.length;

    // Marked before any mechanism runs and after the bundle gate, so everything the wait counts is
    // output the dev server produced because of *this* command — the gate's own `HEAD` on the entry
    // bundle would otherwise be evidence for the reload it was gating.
    bundleMark = markBundleSignalSync(projectRoot);

    // @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads — wave 21.
    //
    // **Rung one: the broadcast, when there is a client to broadcast to** — or `Page.reload` to
    // this worktree's targets while the scope skips an app. `getpeers` answers the first question,
    // and the answer — not `--eas`, not the location of the device — is what picks the rung. A
    // pinned `--method` skips this, as a pinned method always has.
    if (options.method === 'auto' || options.method === 'dev-server') {
      rungOne = await runRungOneAsync(devServerUrl, { prepared: before, budgetMs: remainingMs() });
      attempts.push(rungOne.attempt);
      commandSocketChurn = rungOne.churn;
      commandSocketClients = rungOne.churn.before;
      // @ref llp/0005 §How it reloads — F97. A delivered or acted reload is a mechanism that ran;
      // its own proof is missing, so the two shared observations below — a fresh debugger target,
      // or a bundle the dev server served — decide. That is the difference between exit `20` and
      // exit `22`, and between watching for the evidence and not looking at all.
      const settled = settleRungOne(rungOne);
      method = settled.ran ? 'dev-server' : null;
      mechanismProof = settled.proof;
      relaunchWhy = settled.relaunchWhy;
    }

    // @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads — the cloud loop, K2.
    // **Never in `auto`**, and that is a live finding rather than caution: on Expo Go this call
    // takes the app off the screen and nothing re-registers [observed — Expo Go SDK 57, iOS 26.5
    // simulator, 2026-08-27: `runtime:eval "expo.reloadAppAsync()"` left `/json/list` empty and the
    // device on its home screen, 13 s later]. It reloaded a cloud app, so the mechanism is
    // real and runtime-dependent — which makes it a method a caller chooses, not one this command
    // reaches for on its own. Putting it in `auto` would have traded the relaunch's known cost for
    // a less predictable one.
    if (method == null && options.method === 'runtime') {
      const attempt = await reloadOverRuntimeAsync(actionConnection, observedApps);
      attempts.push(attempt);
      if (attempt.ok) {
        // No mechanism proof: the debugger has no peer list to churn, so the claim is "the call was
        // made" and the proof is the wait below.
        method = 'runtime';
      }
    }

    // **Rung two: the relaunch, on the device backend in play.** `--eas` names *which* backend may
    // act: the session's controller (`./cloudReload.ts`, wave 19's two verbs) or a device booted on
    // this machine.
    //
    // Reached whenever rung 1 did not prove the reload (`relaunchWhy`), and the second state is F99
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
    // cost is visible in (`describeRelaunchCost`). A **pinned** `--method dev-server` never climbs:
    // a caller who named one rung excluded the others, cost and all.
    const relaunchRung =
      options.method === 'device' || (options.method === 'auto' && relaunchWhy != null);
    const why = relaunchWhy ?? '--method device named the relaunch';
    if (relaunchRung && options.cloud) {
      const cloud = await reloadOnCloudSimulatorAsync(projectRoot, options, {
        // Only this worktree's apps: a skipped app's id would relaunch the wrong app.
        targetAppIds: own(before.targets)
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
  }

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
    method != null && prepared != null && bundleMark != null
      ? await observeReloadAsync(devServerUrl, projectRoot, {
          prepared,
          mechanismProof,
          churn: commandSocketChurn,
          attempts,
          bundleMark,
          timeoutMs: remainingMs(),
        })
      : null;
  const unwatched: Unwatched | null = seen?.unwatched ?? null;
  const connection = seen?.evidence ?? {
    appsConnected: observedApps,
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
      ? await countConnectedAppsAsync(devServerUrl, reconnectBudget, actionConnection)
      : connection.appsConnected;

  if (bundleObservation != null) {
    debugEvent('bundle_observed', {
      observed: bundleObservation.observed,
      newBundles: bundleObservation.newBundles,
      waitedMs: bundleObservation.waitedMs,
    });
  }

  // The route is opened after the app is back, not before: Expo Go reloads the URL it was launched
  // with [observed — 2026-08-23: an app deep-linked to `/notes` returns to `/notes` after a
  // reload], so a link sent first would be replaced by the reload rather than survive it. The cloud
  // relaunch is the exception: its own verb carried the route, so opening one again would be a
  // second billed verb for a link the app is already on.
  const landing =
    route != null && method != null && cloudUrl == null && observed
      ? await openRouteAsync(projectRoot, options, devServerUrl, device)
      : null;
  if (landing?.device) {
    device = landing.device;
  }

  // A bundle that does not compile is `20` and a bundle that was still building is `22`, for the
  // reason llp/0010 gives `dev:wait`: a file with a syntax error in it does not parse on the second
  // look, and a cold first build really is worth looking at again.
  //
  // Then one rule for every rung (llp/0005 §How it reloads): no mechanism ran is `20`, a mechanism ran
  // and nothing was **observed** is `22` — the app may be back invisibly or may not be back, which
  // is "look again" rather than "it failed" — and an observation is `0`.
  const exitCode =
    refusal === 'bundle-broken'
      ? EXIT_OUTCOME_FAILED
      : refusal === 'bundle-timeout'
        ? EXIT_OUTCOME_TIMEOUT
        : method == null
          ? EXIT_OUTCOME_FAILED
          : observed
            ? EXIT_OK
            : EXIT_OUTCOME_TIMEOUT;

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

  const report: ReloadResultJson = {
    // An **observed** reload, and nothing weaker. `method != null` says a mechanism ran, which on a
    // cloud session is a controller that accepted a verb and answers about no app in particular.
    reloaded: verifiedBy != null,
    method,
    verifiedBy,
    devServerUrl,
    devServerSource: devServer.devServerSource,
    appsConnected,
    commandSocketClients,
    commandSocketChurn,
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
    route,
    routeCheck,
    url: landing?.url ?? cloudUrl,
    platform: device?.platform ?? null,
    deviceId: device?.deviceId ?? null,
    attempts,
    waitedMs: Date.now() - startedAt,
    followups,
  };

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
    Log.error(explainReloadFailure(report, options, { unwatched, rungOne }));
  }

  reportFollowUps('runtime:reload', followups, { json });
  return exitCode;
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

/**
 * Whether the app's `expo` global can reload it, asked before anything is asked of it.
 *
 * The diagnostic strings it answers with are also what makes the two expressions distinguishable in
 * a test double — not the `typeof` in it, which the promise-settling wrapper adds to every
 * expression this CLI sends (`src/runtime/promiseSettling.ts`).
 */
const RELOAD_PROBE_EXPRESSION = `(function () {
  var e = globalThis.expo;
  if (e == null) return 'no-expo-global';
  return typeof e.reloadAppAsync === 'function' ? 'ready' : 'no-reload-function';
})()`;

/** The reload itself. Returns before the runtime tears itself down, or never returns at all. */
const RELOAD_CALL_EXPRESSION = `(function () {
  globalThis.expo.reloadAppAsync();
  return 'sent';
})()`;

/**
 * How long the reload call is given to answer before the silence is read as the runtime going away.
 *
 * Short on purpose. `expo.reloadAppAsync()` tears down the JavaScript context that is answering the
 * request, so an answer is the *unusual* outcome and a long wait here would only delay the wait that
 * actually proves something — the debugger target registering again.
 */
const RUNTIME_RELOAD_ANSWER_MS = 4000;

/**
 * Reload by asking the app's own `expo` global to reload it, over the debugger.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads — the cloud loop, K2 and K3.
 *
 * The mechanism a caller chooses, and never one `auto` reaches for. It goes over the same CDP socket
 * `runtime:eval` uses, at the same target the same `/json/list` names, so an app this CLI can read
 * is an app this can ask — which is exactly the case the command socket could not serve: a cloud
 * app over a tunnel was in the target list and had no peer on `/message`, and this reloaded it.
 *
 * **On Expo Go the same call closes the app** [observed — Expo Go SDK 57, iOS 26.5 simulator,
 * 2026-08-27: the app left the screen and `/json/list` was still empty 13 s later]. That is the
 * whole reason this is opt-in: one runtime reloads and another quits, the difference is not
 * something this command can read in advance, and a mechanism that sometimes closes the app is not
 * one to run on a caller's behalf.
 *
 * It is `expo.reloadAppAsync()` because that is what a Hermes runtime has. There is no `require` and
 * no `import()` in it, so `DevSettings.reload()` is unreachable from an expression; the `expo`
 * global is the one door, and it was found by dumping `Object.keys(expo)`
 * [observed, cloud simulator, 2026-08-27]. `runtime:eval --help` documents the same idiom,
 * so that a caller who needs to do this by hand does not have to rediscover it.
 *
 * **Nothing here claims a reload.** The probe says the function exists, the call says it was sent,
 * and the proof is the caller's own wait for a debugger target the dev server had not listed before.
 * An app whose runtime stops answering mid-call is the expected shape of success, so a timeout on
 * the call is reported as "sent" rather than as a failure.
 */
async function reloadOverRuntimeAsync(
  {
    devServerUrl,
    targetSelection,
    deviceInventory,
  }: Pick<RuntimeConnection, 'devServerUrl' | 'targetSelection' | 'deviceInventory'>,
  connectedApps: number
): Promise<ReloadAttempt> {
  const failed = (reason: string): ReloadAttempt => ({
    method: 'runtime',
    ok: false,
    reason,
    leftAppStopped: null,
  });

  if (connectedApps === 0) {
    return failed(
      `no app is connected to the dev server, so there is no runtime to ask — this method reloads an app through its debugger and cannot start one`
    );
  }

  const { CdpClient, isMethodNotFoundError } =
    require('../cdpClient') as typeof import('../cdpClient');

  let client: import('../cdpClient').CdpClient;
  try {
    client = new CdpClient({ metroUrl: devServerUrl, targetSelection, deviceInventory });
  } catch (error: unknown) {
    return failed(
      `could not open a debugger connection to the app: ${error instanceof Error ? firstLine(error.message) : String(error)}`
    );
  }

  let probe: string;
  try {
    const answer = await client.evaluateAsync(RELOAD_PROBE_EXPRESSION, {
      awaitPromise: false,
      timeoutMs: RUNTIME_RELOAD_ANSWER_MS,
    });
    if (answer.exceptionText) {
      return failed(
        `the app threw while it was asked whether it can reload itself: ${answer.exceptionText}`
      );
    }
    probe = String(answer.value ?? 'no-answer');
  } catch (error: unknown) {
    return failed(
      isMethodNotFoundError(error)
        ? `the app's runtime has no debugger to ask: it answered "method not found" to Runtime.evaluate, which is what Expo Go for Android does`
        : `the app did not answer over the debugger: ${error instanceof Error ? firstLine(error.message) : String(error)}`
    );
  }

  if (probe !== 'ready') {
    return failed(
      probe === 'no-expo-global'
        ? `the app has no "expo" global, so there is nothing on it to reload with — this needs an app built on the expo package`
        : probe === 'no-reload-function'
          ? `the app's "expo" global has no reloadAppAsync, so this runtime cannot be asked to reload itself — a newer expo package has it`
          : `the app answered the reload probe with "${probe}", which this command cannot read`
    );
  }

  try {
    await client.evaluateAsync(RELOAD_CALL_EXPRESSION, {
      awaitPromise: false,
      timeoutMs: RUNTIME_RELOAD_ANSWER_MS,
    });
  } catch {
    // A runtime that stops answering is what a reload looks like from here, so this is not a
    // failure — and it is not a success either. The wait for a fresh target decides.
    return {
      method: 'runtime',
      ok: true,
      reason: `expo.reloadAppAsync() was called over the debugger and the runtime stopped answering, which is what a reload looks like from here`,
      leftAppStopped: null,
    };
  }

  return {
    method: 'runtime',
    ok: true,
    reason: `expo.reloadAppAsync() was called over the debugger`,
    leftAppStopped: null,
  };
}

/** Reload by stopping the app on the device and opening it again. */
async function reloadOnDeviceAsync(
  projectRoot: string,
  options: ReloadOptions,
  devServerUrl: string,
  own: (targets: CdpTarget[]) => CdpTarget[]
): Promise<{ attempt: ReloadAttempt; device: NavigateDevice | null }> {
  let device: NavigateDevice;
  try {
    // @ref llp/0005-runtime-loop-tools.rfc.md §Cloud simulator.
    // `required` and never `fallback`: only `--eas` sends this to a device that bills by the
    // minute, and a machine with nothing booted is told it has nothing.
    device = await resolveDeviceAsync(options.platform, {
      cloud: options.cloud ? 'required' : 'off',
      projectRoot,
    });
  } catch (error: unknown) {
    // Without --eas the local rungs answer for a worktree whose device is an EAS session, so their
    // refusal (an expired local lease, say) names the wrong device. Name the session instead.
    const session = options.cloud
      ? undefined
      : liveCloudBindings(projectRoot).find(
          (binding) => options.platform == null || binding.device.platform === options.platform
        );
    return {
      attempt: {
        method: 'device',
        ok: false,
        reason: session
          ? `this worktree's device is ${session.device.platform} EAS Simulator session ${session.device.id}; the relaunch acts on it only with --eas: run "${PROGRAM_PREFIX} runtime:reload --${session.device.platform} --eas"`
          : error instanceof Error
            ? error.message.split('\n')[0]!
            : String(error),
        leftAppStopped: null,
      },
      device: null,
    };
  }

  const appId = await resolveAppIdAsync(projectRoot, devServerUrl, device, own, options.appId);
  const stopped = await stopAppOnDeviceAsync({
    platform: device.platform,
    deviceId: device.deviceId,
    appId,
    adb: device.adb,
    backend: device.backend,
    projectRoot,
  });
  if (!stopped.ok) {
    return {
      attempt: {
        method: 'device',
        ok: false,
        reason: `${stopped.command} failed: ${stopped.reason}`,
        // The stop is what failed, so the app is where it was.
        leftAppStopped: null,
      },
      device,
    };
  }

  // Starting it again is the deep link, which is the same step `navigate` runs — so a run with a
  // `--route` opens the route directly and a run without one opens the root.
  const opened = await openRouteAsync(projectRoot, options, devServerUrl, device);
  if (opened == null || opened.exitCode !== 0) {
    return {
      attempt: {
        method: 'device',
        ok: false,
        reason: `the app was stopped, but the device refused the link that would start it again (${opened?.command ?? 'no command ran'})`,
        // Stopped and not started: the app is off the screen because of this run.
        leftAppStopped: appId,
      },
      device,
    };
  }

  return {
    attempt: {
      method: 'device',
      ok: true,
      reason: `${stopped.command}, then ${opened.command}`,
      leftAppStopped: null,
    },
    device,
  };
}

/**
 * Open the route (or the root) on a device, building the URL exactly as `navigate` does.
 *
 * **Including the host** (F96, the third URL-construction path this CLI had). The sentence above was
 * true when it was written and stopped being true in wave 17, when `navigate` learned to read the
 * host a *device* reaches out of the dev server's manifest: this function kept passing only the
 * origin the dev server listens on, so a project served through a tunnel or a proxy got a link
 * naming this machine. It is exactly wrong for a phone on another network, and it reaches a cloud
 * session too: the *relaunch* rung skips this open, because its own verb already carried the route,
 * but a `--route` run that reloaded over the **command socket** lands through here on whichever
 * backend is in play — including a session in a datacenter.
 *
 * @see src/dev/advertisedUrl.ts — and `resolveRouteUrlAsync`, which does the same thing for the two
 * callers that also need a route check and a target decision from the dev server's own target list.
 */
async function openRouteAsync(
  projectRoot: string,
  options: ReloadOptions,
  devServerUrl: string,
  known: NavigateDevice | null
): Promise<{
  url: string;
  command: string;
  exitCode: number | null;
  device: NavigateDevice;
} | null> {
  const [config, nativeDirs, packageJson, reach] = await Promise.all([
    readProjectSchemeConfig(projectRoot),
    readProjectNativeDirsAsync(projectRoot),
    readProjectPackageJsonAsync(projectRoot),
    // The same question `navigate` asks, through the same function: not where this dev server
    // listens, but where a device reaches it. `options.devServerUrl` is the caller's flag, so a run
    // that pinned a host keeps it and every other run gets the advertised one.
    isCallerNamedDevServer({ devServerUrl: options.devServerUrl ?? null })
      ? Promise.resolve(null)
      : resolveDevServerReachAsync(projectRoot),
  ]);
  const usesDevClient = await isInstalledDependencyAsync(
    projectRoot,
    listDependencyNames(packageJson),
    'expo-dev-client'
  );
  const target = decideExpoGoTarget({
    appIdOverride: options.appId,
    targetAppIds: [],
    hasNativeDirs: nativeDirs.ios || nativeDirs.android,
    usesDevClient,
    // @ref llp/0005-runtime-loop-tools.rfc.md §Expo Go is only a target for a project that fits in it
    // This rung starts an app that is not running, so it builds the same deep link `navigate` does
    // and owes the same answer: starting Expo Go for a project that cannot run there would put the
    // wrong app on the screen and call it a reload.
    expoGoCompatible: decidesAgainstExpoGo(await checkExpoGoCompatibilityAsync(projectRoot)),
  });

  const resolved = resolveDeepLinkUrl({
    route: options.route ?? '/',
    schemeOverride: options.scheme,
    config,
    isExpoGo: target.isExpoGo,
    devServerUrl,
    // Only a tunnel that is *current*, for the reason `resolveRouteUrlAsync` gives: a host read out
    // of a log whose dev server has since stopped is worse than the address of this machine.
    reachHost: reach && isTunnelCurrent(reach) ? (reach.advertised?.host ?? null) : null,
    platform: options.platform ?? null,
  });
  if (!resolved.ok) {
    return null;
  }

  const device =
    known ??
    (await resolveDeviceAsync(options.platform, {
      cloud: options.cloud ? 'required' : 'off',
      projectRoot,
    }));
  const result = await openUrlOnDeviceAsync({
    platform: device.platform,
    deviceId: device.deviceId,
    url: resolved.url,
    appId: options.appId,
    adb: device.adb,
    backend: device.backend,
    projectRoot,
  });
  return { url: resolved.url, command: result.command, exitCode: result.exitCode, device };
}

/**
 * The application id to stop, resolved the way `runtime:stop` resolves it.
 *
 * @see ../appId — the dev server outranks the app config, because the config says what a build of
 * this project would be called and the dev server says what is running.
 */
async function resolveAppIdAsync(
  projectRoot: string,
  devServerUrl: string,
  device: NavigateDevice,
  own: (targets: CdpTarget[]) => CdpTarget[],
  appIdOverride?: string
): Promise<string> {
  const { probeDevServerAsync } = require('../devServer') as typeof import('../devServer');
  const probe = await probeDevServerAsync(devServerUrl);
  return resolveAppId({
    platform: device.platform,
    appIdOverride,
    // Only this worktree's apps: a skipped app's id stops the wrong app (llp/0005 §Target owner).
    targetAppIds: own(probe.targets)
      .map((target) => target.appId)
      .filter(Boolean),
    configured: readConfiguredAppId(projectRoot, device.platform),
  }).appId;
}

/** What each method is, in the words of the thing it acted on rather than its flag value. */
const METHOD_PHRASE: { [method: string]: string } = {
  'dev-server': "the dev server's client command socket",
  runtime: "the app's own expo.reloadAppAsync, over the debugger",
  device: 'stopping the app on the device and opening it again',
  'page-reload': "Page.reload to this worktree's app, over the debugger",
};

/**
 * What the app being off the screen may mean after a cloud relaunch was refused, and how to fix it.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §Cloud simulator — live run S12.
 *
 * The old fallback `close`d the app and then failed to open it, which left a billed session with
 * nothing running and said so nowhere. The one-verb relaunch cannot strand the app *and* claim to
 * know it did not: `--relaunch` terminates before it launches, so a refusal is genuinely two states
 * this command cannot tell apart. It says that, and hands over the command that ends either one.
 */
function explainCloudRelaunchRefusal(report: ReloadResultJson): string[] {
  const failed = report.attempts.find((attempt) => attempt.method === 'device' && !attempt.ok);
  if (failed == null) {
    return [];
  }
  const appId = /relaunched (\S+)/.exec(failed.reason)?.[1] ?? 'the app';
  return [
    `Whether the app is still on the screen is not known: the relaunch verb terminates the app before it launches it, so a refusal may have left the session with nothing running — and the controller does not say which half it got to.`,
    `To put it back by hand, run "${easCommandPrefix()} simulator:exec npx ${AGENT_DEVICE_SPEC} open ${appId === 'the app' ? '<app-id>' : appId} --platform ${report.platform ?? 'ios'}" — opening the application id rather than a deep link avoids the "Open in Expo Go?" dialog that nothing can answer on a cloud device. "${easCommandPrefix()} simulator:stop --id ${report.deviceId ?? '<session-id>'}" ends the session and its billing.`,
  ];
}

function printHumanReport(report: ReloadResultJson, options: ReloadOptions): void {
  const lines = [
    chalk`{bold Reloaded} ${report.reloaded ? chalk.green('yes') : chalk.red('no')}${
      report.method
        ? chalk`{dim  · via ${METHOD_PHRASE[report.method === 'dev-server' && report.attempts.some((attempt) => attempt.method === 'page-reload') ? 'page-reload' : report.method]}}`
        : ''
    }`,
  ];
  if (report.verifiedBy) {
    // The evidence beside the label, always: a label a reader has to go looking for the count of is
    // the shape F95 was, and "verified by message-socket-peers" over "0 reconnected" is what it read
    // like.
    lines.push(chalk`{dim  verified by ${report.verifiedBy} · ${describeEvidence(report)}}`);
  }
  lines.push(
    chalk`{bold Dev server} ${report.devServerUrl}{dim  · via ${report.devServerSource}}`,
    // Both numbers whenever a reload happened: the second is what a reload proved by a debugger
    // target is judged on, and printing only the first is what let "Apps connected 1" describe a
    // runtime that was on its way out (F45). A zero says *why* it is zero (F95): "0 reconnected
    // after the reload" was three different facts wearing one number, one of them being "another
    // proof answered first and this watch stopped asking".
    chalk`{bold Apps connected} ${report.appsConnected}{dim  · ${
      report.appsReconnected > 0
        ? `${report.appsReconnected} reconnected after the reload`
        : (report.appsReconnectedReason ?? 'none reconnected after the reload')
    }}`
  );
  // @ref llp/0005 §Target owner. A line per placement group: rung 1 did not reload these apps, and
  // a reader must not take their bundle or their screen for this worktree's.
  for (const group of ['other-worktree', 'other-device'] as const) {
    const apps = report.skippedApps.filter((app) => app.group === group);
    if (apps.length > 0) {
      lines.push(chalk`{bold Not reloaded} {dim ${describeSkippedApps(apps)}}`);
    }
  }
  // @ref llp/0005 §What proves a reload. Its own line, whenever the socket was asked: one number
  // for two lists is how "Apps connected 1" came to sit above a broadcast that reached nobody.
  if (report.commandSocketClients != null) {
    lines.push(
      chalk`{bold Command socket} ${report.commandSocketClients} client(s){dim  · ${
        report.commandSocketClients === report.appsConnected
          ? 'the same count as the debugger target list'
          : `a different list from the ${report.appsConnected} above — a broadcast goes to these, and the rest of this CLI reads those`
      }}`
    );
  }
  // The second proof, watched on every rung (wave 21) and printed when it is load-bearing: it
  // fired, or nothing else answered and this is what the exit code turned on. A successful reload
  // proved by a fresh debugger target would otherwise print `Bundle served after no` under
  // `Reloaded yes`, which reads as a failure inside a success.
  if (
    report.bundlesAfterReload.observed === true ||
    (report.bundlesAfterReload.observed != null && report.appsReconnected === 0)
  ) {
    lines.push(
      chalk`{bold Bundle served after} ${
        report.bundlesAfterReload.observed
          ? chalk.green(`yes · ${report.bundlesAfterReload.count}`)
          : chalk.red('no')
      }${
        report.bundlesAfterReload.line
          ? chalk`{dim  · ${report.bundlesAfterReload.line}}`
          : report.bundlesAfterReload.reason
            ? chalk`{dim  · ${report.bundlesAfterReload.reason}}`
            : ''
      }`
    );
  }
  // Always a line, whatever the check did. Printing one only for an answered check made the
  // *absence* of a line the only signal that a gate had been skipped [observed — friction run 5,
  // F48-7: `runtime:reload --no-bundle-check` printed no Bundle line at all, while a checked run
  // printed `Bundle compiles · for ios`]. A reader cannot notice a line that is not there.
  if (report.bundle.ok != null) {
    // Which platforms, and where they came from: a run that checked a default it was never told to
    // use has to say so, or `for ios` reads as a fact about the app it just reloaded (F53).
    const others = report.bundlePlatforms.filter((name) => name !== report.bundle.platform);
    lines.push(
      chalk`{bold Bundle} ${report.bundle.ok ? chalk.green('compiles') : chalk.red('does not compile')}${
        report.bundle.platform ? chalk`{dim  · for ${report.bundle.platform}}` : ''
      }${others.length ? chalk`{dim  · also checked ${others.join(', ')}}` : ''}${
        report.bundlePlatformSource === 'connected-app'
          ? chalk`{dim  · the platform the connected app is on}`
          : report.bundlePlatformSource === 'default'
            ? chalk`{dim  · a default, because nothing named a platform and no connected app could be placed}`
            : ''
      }`
    );
  } else if (!options.bundleCheck) {
    lines.push(chalk`{bold Bundle} ${chalk.dim('skipped (--no-bundle-check)')}`);
  } else {
    lines.push(
      chalk`{bold Bundle} ${chalk.dim(`not checked${report.bundle.reason ? ` · ${report.bundle.reason}` : ''}`)}`
    );
  }
  if (report.route != null) {
    lines.push(
      chalk`{bold Route} ${report.route}${report.url ? chalk`{dim  · ${report.url}}` : ''}`
    );
  }
  for (const attempt of report.attempts) {
    lines.push(chalk`{dim  ${attempt.method}: ${attempt.reason}}`);
  }
  lines.push(chalk`{bold Took} ${report.waitedMs}ms`);
  Log.log(lines.join('\n'));
}

/**
 * What this run left behind, when the fallback stopped the app and could not start it again.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §Cloud simulator — live
 * run S12.
 *
 * Said out loud because it is a state the command *produced*: the app is not on the screen, and on a
 * cloud session the reopen this command would use is the one that just failed — so the recovery is a
 * command a person runs, and the fallback is not redesigned here. Empty for a run that stopped
 * nothing.
 */
function explainStrandedApp(report: ReloadResultJson, options: ReloadOptions): string[] {
  const appId = report.attempts.find((attempt) => attempt.leftAppStopped != null)?.leftAppStopped;
  if (appId == null) {
    return [];
  }
  return [
    options.cloud
      ? `The app was left closed: the device fallback stopped ${appId} on the cloud session and the relaunch was refused, so the session is still billing with nothing running on it, and this command cannot put it back — the reopen it would use is the one that just failed.`
      : `The app was left closed: the device fallback stopped ${appId} and the relaunch was refused, so nothing is running on the device now.`,
    options.cloud
      ? `To reopen it by hand, run "${easCommandPrefix()} simulator:exec npx ${AGENT_DEVICE_SPEC} open ${appId}" — opening the application id rather than a deep link avoids the "Open in Expo Go?" dialog that nothing can answer on a cloud device. "${PROGRAM_PREFIX} dev:stop --eas" ends the session and its billing.`
      : `Run "${PROGRAM_PREFIX} navigate /" to open it again.`,
  ];
}

/** What the payload does not carry and the failure text needs: the state rung 1 and the wait ended in. */
export interface ReloadFailureState {
  unwatched: Unwatched | null;
  rungOne: RungOneOutcome | null;
}

/** The what / why / how for a reload that did not end where it was supposed to. */
export function explainReloadFailure(
  report: ReloadResultJson,
  options: ReloadOptions,
  state: ReloadFailureState
): string {
  // The `smoke` this points at needs a platform now. Prefer the device this reload ran against,
  // then the flag the caller passed, then the host's default — and carry `--eas` through.
  const smokePlatform =
    statedSmokePlatform((report.platform as PlanPlatform | null) ?? options.platform) ??
    (process.platform === 'darwin' ? 'ios' : 'android');
  const smokeBase = `${smokeCommand(smokePlatform)}${options.cloud ? ' --eas' : ''}`;

  // The refusal comes first, because nothing was attempted: an attempts list that is empty for
  // this reason must not read as "no method worked" (friction run 4, F38).
  if (report.bundle.ok === false) {
    const error = report.bundle.error;
    const where = [error?.filename, error?.lineNumber, error?.column]
      .filter((part) => part != null)
      .join(':');
    return [
      chalk.red(`This project's entry bundle does not compile, so the app was not reloaded.`),
      `Why: a reload makes the app fetch the served bundle again, and that bundle is the one the bundler stopped on${where ? ` at ${where}` : ''} — ${error?.message ?? 'the bundler reported an error'}. Reloading would have replaced the screen the app is on with the same failure, and reported success for it.`,
      `How: fix ${where || 'the file the bundler named'} and run this command again; the dev server rebuilds on save, so no restart is needed. Pass --no-bundle-check to reload without asking, which is only useful when you mean to reload onto a bundle you know is broken.`,
      ...(error?.snippet ? [error.snippet] : []),
    ].join('\n');
  }
  if (
    report.bundle.reason != null &&
    report.bundle.ok == null &&
    options.bundleCheck &&
    report.method == null &&
    report.attempts.length === 0
  ) {
    return [
      chalk.red(
        `The bundler was still building this project's entry bundle after ${options.timeoutMs}ms, so the app was not reloaded.`
      ),
      `Why: ${report.bundle.reason}. Until that build finishes it is not known whether a reload would fetch working code, and nothing was attempted rather than reload onto an answer nobody has.`,
      `How: run this command again with a longer --timeout — a first build of a large app takes tens of seconds — or run "${smokeBase}" first and reload once it is green.`,
    ].join('\n');
  }
  // @ref llp/0005 §Cloud simulator. The relaunch ran and nothing was observed: the app
  // may be back and invisible to this dev server, or it may not be back. Two states this command
  // cannot tell apart, and naming both is the honest report — `reloaded: no` with the mechanism that
  // ran, rather than a success off a verb that answers about no app in particular.
  const keeps = keepsPageId(report.attempts);
  const relaunched = settledAttempt(report.attempts)?.method === 'device';
  const unprovable = state.unwatched === 'nothing-can-prove' ? keeps : null;
  // A mechanism that keeps the page id leaves the old target listed, so that list proves nothing.
  if (report.method != null && (report.verifiedBy == null || keeps != null)) {
    const outside = state.rungOne?.kind === 'acted' ? state.rungOne.reachedOutside : 0;
    const why = unprovable
      ? `Why: ${unprovable}, and no bundle may count here (${describeSkippedApps(report.skippedApps)}), so nothing could prove the reload and nothing was watched.`
      : [
          outside > 0
            ? `Why: the dev server's command socket clients churned, but ${outside} listed app${outside === 1 ? '' : 's'} outside this run's scope ${outside === 1 ? 'was' : 'were'} reloaded too, so the churn proves nothing, and neither observation that could prove it happened within ${options.timeoutMs}ms.`
            : `Why: two observations were watched for ${options.timeoutMs}ms and neither happened.`,
          `The dev server listed no debugger target it had not listed before (${report.devServerUrl}/json/list named ${report.appsConnected})${options.cloud ? ', which a cloud simulator often never does — an app has run this project on one with that list empty throughout' : ''}.`,
          `And ${report.bundlesAfterReload.reason ?? 'the dev server served no bundle after the relaunch'}. So the app may be running the new code invisibly, or it may not have come back.`,
        ].join(' ');
    return [
      chalk.red(
        `The app was ${relaunched ? 'relaunched' : 'asked to reload itself'}${options.cloud ? ' on the cloud simulator' : ''}, and nothing was observed to confirm it reloaded.`
      ),
      why,
      unprovable
        ? `How: ${relaunched ? `look at the screen — "${smokeBase} --no-route-check" photographs it — before you believe "${PROGRAM_PREFIX} runtime:errors".` : `run "${PROGRAM_PREFIX} runtime:reload --method device", which relaunches this worktree's app and proves it by the relaunch, or look at the screen with "${smokeBase} --no-route-check".`}`
        : `How: look at the screen — "${smokeBase} --no-route-check" photographs it — and at what the dev server was asked for, with "${PROGRAM_PREFIX} dev:logs". ${options.cloud ? 'A first bundle over a tunnel can take longer than this wait, so a longer --timeout is worth one try. ' : ''}${report.bundlesAfterReload.observed == null ? `This project has no captured dev server log, which is where the one usable proof would have been: start it with "${PROGRAM_PREFIX} dev --detach${options.cloud ? ' --tunnel' : ''}" so its output is recorded.` : ''}`.trim(),
    ].join('\n');
  }
  if (!report.reloaded) {
    return [
      chalk.red(`The app was not reloaded.`),
      `Why: ${report.attempts.map((attempt) => `${attempt.method} — ${attempt.reason}`).join('; ') || 'no method was tried'}.`,
      ...explainStrandedApp(report, options),
      ...(options.cloud ? explainCloudRelaunchRefusal(report) : []),
      // @ref llp/0005 §What proves a reload — K2 and K3. Two different dead ends, and the old
      // text described only the second: "open the app first" is advice for a caller whose app is
      // *not* running, and printing it for a connected app is how a reader was sent to start a
      // second copy of an app this command could see all along.
      state.rungOne?.kind === 'unprovable'
        ? `How: no app of this worktree could keep the marker that proves a Page.reload, so none was sent. Run "${PROGRAM_PREFIX} runtime:reload --method device", which relaunches this worktree's app and proves it by the relaunch.`
        : report.appsConnected > 0
          ? `How: the app is connected — ${report.devServerUrl}/json/list names ${report.appsConnected === 1 ? 'it' : `${report.appsConnected} of them`} — so this is not a missing app, it is a runtime ${report.attempts.some((attempt) => attempt.method === 'page-reload') ? 'Page.reload' : 'the broadcast'} could not reach. Editing a file the app has loaded is the cheapest way in: the dev server pushes that on its own. The two deliberate methods are "${PROGRAM_PREFIX} runtime:reload --method runtime", which asks the app's own expo.reloadAppAsync to do it and on Expo Go closes the app instead, and "${PROGRAM_PREFIX} runtime:reload --method device", which force-stops the app and opens it again — that always works and costs the app's state${options.cloud ? ', and on a cloud session leaves the app closed if the relaunch is refused' : ''}.`
          : `How: open the app on a device or simulator first ("${PROGRAM_PREFIX} navigate /"), then run this command again. A reload needs an app that is already running: it replaces the JavaScript in one, it does not start one.`,
    ].join('\n');
  }
  // Two shapes of "not back", and they are told apart by what the target list says. An empty list
  // is an app that went and did not return; a list holding only the runtime that was there before
  // the reload is an app that never re-registered. Reporting either as a success is F45.
  if (report.appsConnected === 0) {
    return [
      chalk.red(
        `The app reloaded, but it had not reconnected to the dev server ${options.timeoutMs}ms later.`
      ),
      `Why: its debugger target list (${report.devServerUrl}/json/list) was empty, so no app is running this project's JavaScript — the app either closed or is still loading a cold bundle, which can take longer than this wait.`,
      `How: run "${smokeBase}" to wait for the bundle and the app together, or run this command again with a longer --timeout. If the app is not on screen, "${PROGRAM_PREFIX} navigate /" opens it. Nothing is known to be wrong; the wait ran out first.`,
    ].join('\n');
  }
  return [
    chalk.red(
      `The app reloaded, but its JavaScript had not registered again ${options.timeoutMs}ms later.`
    ),
    `Why: ${report.devServerUrl}/json/list still names ${report.appsConnected === 1 ? 'the same debugger target' : `only the same ${report.appsConnected} debugger targets`} it named before the reload, and the dev server never reuses a target id — so the runtime that answers now is the one from before, not a reloaded one. Its errors and its state describe the run this reload was meant to replace.`,
    `How: run this command again with a longer --timeout, or run "${smokeBase}" and read the app after it. Do not believe "${PROGRAM_PREFIX} runtime:errors" until a reload reports a reconnected app.`,
  ].join('\n');
}
