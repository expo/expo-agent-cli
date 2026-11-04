import { isExpoGoAppId } from '../../navigate/target';
import { openRouteAsync } from '../../navigate/openRoute';
import { PROGRAM_PREFIX } from '../../programName';
import { checkExpoGoCompatibilityAsync, decidesAgainstExpoGo } from '../../project/expoGo';
import { CdpClient, isMethodNotFoundError } from '../../runtime/cdpClient';
import { probeDevServerAsync } from '../../runtime/devServer';
import { markBundleSignalSync } from '../../runtime/reload/bundleSignal';
import { observeReloadAsync } from '../../runtime/reload/evidence';
import { prepareRungOneAsync, runRungOneAsync, settleRungOne } from '../../runtime/reload/rungOne';
import { CdpRuntimeErrorCollector } from '../../runtime/runtimeErrorCollector';
import { waitForAppConnectionAsync } from '../../runtime/waitReady';
import { CommandError } from '../../utils/errors';
import { firstLine } from '../../utils/text';
import type { SmokeDeps } from '../phases';
import { expoGoVersionMismatch } from './device';
import type { SmokeDepsContext } from './shared';

/**
 * The expression the runtime is asked to evaluate.
 *
 * `1` and nothing else. The question is only "does this runtime answer the debugger at all", and
 * anything that touched the app's own state would fail for reasons that are the app's rather than
 * the runtime's — which is the distinction this phase exists to draw.
 */
const LIVENESS_EXPRESSION = '1';

/** How long the liveness evaluation gets before it is called unanswered. */
const LIVENESS_TIMEOUT_MS = 5_000;

/** How often the target list is re-read while the run waits for the app to stop re-registering. */
const TARGET_SETTLE_POLL_MS = 500;

// Scoped to this run's platform: a `smoke --android` that counted the iOS simulator already
// attached to this dev server would go on to read that simulator's runtime, and report the
// verdict as Android's [friction run 6, F51].
export async function waitForAppConnection(
  ctx: SmokeDepsContext,
  devServerUrl: string,
  timeoutMs: number
): ReturnType<SmokeDeps['waitForAppConnection']> {
  const { targetSelection, deviceInventory, targets } =
    await ctx.targetSelectionAsync(devServerUrl);
  return await waitForAppConnectionAsync(devServerUrl, {
    timeoutMs,
    targetSelection,
    deviceInventory,
    inventoryTargets: targets,
  });
}

// The dev server this run settled on, not the flag: a run that discovered one in its first
// phase must not go looking for a second one in its fourth.
//
// **And its provenance with it** (F96). That URL is where the dev server *listens*, which is not
// where a device *reaches* it: `openRouteAsync` asks the manifest for the second, and it skips
// that lookup for a URL the caller pinned. Handing it a discovered URL with no label made the
// gate refuse `exp://127.0.0.1:8500` as unreachable from a cloud simulator while `navigate`,
// against the same dev server, opened the tunnel host the manifest carried
// [observed — live cloud, 2026-08-27]. `flag` only when the caller really did name one.
// The run's device choice, so the open and the waits after it are about one device. An earlier
// lookup that failed is not kept, so this one looks again, and throws its own refusal.
export async function openRoute(
  ctx: SmokeDepsContext,
  ...[route, devServerUrl, attachBudgetMs]: Parameters<SmokeDeps['openRoute']>
): ReturnType<SmokeDeps['openRoute']> {
  const { projectRoot, options } = ctx;
  const lookup = await ctx.deviceAsync();
  if (lookup.device == null) throw lookup.error;
  return await openRouteAsync(projectRoot, {
    device: lookup.device,
    route,
    platform: options.platform,
    devServerUrl,
    devServerUrlSource: options.devServerUrl == null ? 'discovered' : 'flag',
    routeCheck: options.routeCheck,
    command: 'smoke',
    cloud: options.cloud,
    // @ref llp/0005-runtime-loop-tools.rfc.md §Loading the app is not navigating it. The
    // budget is what turns this open into a *load*: F123's launcher-first ladder is gated on
    // it, so without one a cold development build was handed `<scheme>://<route>` — the link
    // only an app that is already running understands — and the run photographed the dev
    // launcher's own screen [observed, 2026-09-01]. The ladder lives in `openRouteAsync`
    // and is `navigate`'s; passing the budget is how this command joins it rather than building
    // a second URL of its own (F96).
    confirmAttachMs: attachBudgetMs,
  });
}

// @ref llp/0005-runtime-loop-tools.rfc.md §Expo Go is only a target for a project that fits in it
//
// The gate's own version of the question `decideExpoGoTarget` answers for the *link*. That
// decision stops this command opening Expo Go for a project that cannot run there; it says
// nothing about an Expo Go that was already attached when the run arrived, which is what
// `expo start --ios` leaves behind and the state an agent is most likely to inherit.
//
// Scoped to this run's platform for the same reason every other read is (F51): an iOS Expo Go
// attached to the same dev server must not decide an `--android` run's answer.
export async function checkAppFitsProject(
  ctx: SmokeDepsContext,
  devServerUrl: string
): ReturnType<SmokeDeps['checkAppFitsProject']> {
  const { projectRoot, options } = ctx;
  const nothing = { mismatch: null, kind: null, note: null };
  // `read` only: a target nothing placed must not earn this run's verdict either way (@ref
  // src/runtime/targetSelection §classifyTargets), so an unreadable target never becomes a refusal.
  const { classifiedTargets } = await ctx.targetSelectionAsync(devServerUrl);
  const expoGo = classifiedTargets.read.map((target) => target.appId).find(isExpoGoAppId);
  // Everything below is about Expo Go. A development build is this project's own app and its
  // version is the project's own business, so there is nothing here to ask about it.
  if (expoGo == null) {
    return nothing;
  }

  // @ref llp/0005 §Expo Go is only a target for a project that fits in it. Only a project that
  // is **ruled out** is a mismatch. Unknown is not: a project this could not read is the
  // ordinary state of a fresh clone (@ref src/project/expoGo §RULES_OUT_EXPO_GO).
  if (decidesAgainstExpoGo(await checkExpoGoCompatibilityAsync(projectRoot)) === false) {
    return {
      mismatch: `the app that answered is Expo Go (${expoGo}), and this project cannot run in Expo Go — its native code is not in that runtime, so this window is about Expo Go rather than about this project. "${PROGRAM_PREFIX} dev --${options.platform}" makes the development build that can run it`,
      kind: 'expo-go-incompatible' as const,
      note: null,
    };
  }

  // @ref llp/0005 §The Expo Go on the device is not the Expo Go the SDK wants
  //
  // The project fits in Expo Go — but the Expo Go on the device is a build of *some* SDK, and
  // only the one from this project's release line is the app under test. Asked only of a local
  // simulator: the check reads that simulator's own bundle, and a cloud session's disk is not
  // this machine's (llp/0005 §Cloud simulator).
  // The same resolution `probeDevice` performs, and for the same reason: the device this run is
  // about. Any failure to find one is nothing to check rather than something to report — the
  // app answered, so whatever it is running on is beyond this check's reach.
  const { device } = await ctx.deviceAsync();
  // @ref llp/0005-runtime-loop-tools.rfc.md §Android — both local backends now, because both
  // have a reader for the version on the device (@ref src/device/expoGoVersion). A cloud
  // session is still excluded: the check reads the device, and that device is not this
  // machine's (llp/0005 §Cloud simulator).
  const localDeviceId =
    device?.backend === 'local-ios' || device?.backend === 'local-android' ? device.deviceId : null;
  if (localDeviceId == null) {
    return nothing;
  }
  // `unknown` says nothing at all, and that is a decision rather than an oversight: a machine
  // with no route out would otherwise carry "the version could not be checked" on the `app` row
  // of every run it ever makes, which is chatter rather than a finding.
  // A run that could install has already fixed this in the `install-app` phase, so what reaches
  // here is a run that could not — `--no-start`, which says change nothing. It blocks the pass
  // rather than noting it: the runtime that answered is not the release this SDK ships, so the
  // window is not about the app the caller would ship.
  return (
    (await expoGoVersionMismatch(
      ctx,
      localDeviceId,
      `— so this window is about an Expo Go this SDK does not ship.`
    )) ?? nothing
  );
}

// @ref llp/0005-runtime-loop-tools.rfc.md §The app under test is the code on disk
//
// `runtime:reload`'s rung 1, and its proofs, through the same functions — the whole point of
// this command being one process (llp/0005 §The smoke gate). Deliberately **only** rung 1: the
// rungs above it stop the app and start it again, and a gate is not allowed to take the
// caller's app away in order to answer a question about it. An app the broadcast cannot reach
// is a fact this phase reports, not a licence to relaunch.
//
// The bundle mark is taken *before* the broadcast because that is what makes the log a proof:
// `dev-server-bundle` says a bundle was served after this run acted, which is only readable
// against a count from before it.
export async function reloadApp(
  ctx: SmokeDepsContext,
  devServerUrl: string,
  timeoutMs: number
): ReturnType<SmokeDeps['reloadApp']> {
  const { projectRoot } = ctx;
  const deadline = Date.now() + timeoutMs;
  const remainingMs = () => Math.max(0, deadline - Date.now());
  const prepared = await prepareRungOneAsync(devServerUrl, projectRoot, await ctx.scopeAsync(), {
    budgetMs: remainingMs(),
    preflight: ctx.lastObservation(),
  });
  const bundleMark = markBundleSignalSync(projectRoot);
  const rungOne = await runRungOneAsync(devServerUrl, { prepared, budgetMs: remainingMs() });
  const result = {
    knownTargetIds: prepared.targets.map((target) => target.id),
    commandSocketReconnected: rungOne.churn.reconnected > 0,
    targetOutcomes: rungOne.attempt.method === 'page-reload' ? rungOne.attempt.outcomes : [],
  };
  const settled = settleRungOne(rungOne);
  if (!settled.ran) {
    return {
      ...result,
      ok: false,
      verifiedBy: null,
      freshTargets: 0,
      bundleServed: false,
      reason: rungOne.attempt.reason,
    };
  }
  const { verifiedBy, evidence } = await observeReloadAsync(devServerUrl, projectRoot, {
    prepared,
    mechanismProof: settled.proof,
    churn: rungOne.churn,
    attempts: [rungOne.attempt],
    bundleMark,
    timeoutMs: remainingMs(),
  });
  return {
    ...result,
    ok: verifiedBy != null,
    verifiedBy,
    freshTargets: evidence?.freshTargets ?? 0,
    bundleServed: evidence?.bundle.observed ?? false,
    reason: verifiedBy == null ? rungOne.attempt.reason : null,
  };
}

export async function evaluate(
  ctx: SmokeDepsContext,
  devServerUrl: string
): ReturnType<SmokeDeps['evaluate']> {
  try {
    const { targetSelection, deviceInventory } = await ctx.targetSelectionAsync(devServerUrl);
    await new CdpClient({
      metroUrl: devServerUrl,
      targetSelection,
      deviceInventory,
    }).evaluateAsync(LIVENESS_EXPRESSION, {
      awaitPromise: false,
      timeoutMs: LIVENESS_TIMEOUT_MS,
    });
    return { ok: true, unsupported: false, reason: null };
  } catch (error: unknown) {
    // The Expo Go Android case: the engine was built without a CDP debugger, so nothing can be
    // evaluated *and* nothing will be reported in the window that follows.
    if (isMethodNotFoundError(error)) {
      return {
        ok: false,
        unsupported: true,
        reason: 'the runtime answered Runtime.evaluate with "method not found"',
      };
    }
    return {
      ok: false,
      unsupported: false,
      reason: debuggerFailureReason(error),
    };
  }
}

export async function collectErrors(
  ctx: SmokeDepsContext,
  devServerUrl: string,
  windowMs: number
): ReturnType<SmokeDeps['collectErrors']> {
  try {
    const { targetSelection, deviceInventory } = await ctx.targetSelectionAsync(devServerUrl);
    const records = await new CdpRuntimeErrorCollector({
      metroUrl: devServerUrl,
      durationMs: windowMs,
      targetSelection,
      deviceInventory,
    }).collectAsync();
    return { ok: true, records, reason: null };
  } catch (error: unknown) {
    // An unreadable app is a result rather than a tool failure: the gate reports that it could
    // not watch, which is exactly what `inconclusive` is for.
    return {
      ok: false,
      records: [],
      reason: `the app could not be watched (${debuggerFailureReason(error)})`,
    };
  }
}

// @ref ../timeouts §APP_SETTLE_MS — friction run 6, F57. Nothing over this protocol says
// "rendered", so what is waited for is the app having stopped re-registering: two reads of the
// dev server's target list that name the same ids. A relaunching app changes them.
export async function waitForStableTargets(
  devServerUrl: string,
  timeoutMs: number
): ReturnType<SmokeDeps['waitForStableTargets']> {
  const deadline = Date.now() + timeoutMs;
  let previous: string | null = null;
  for (;;) {
    const probe = await probeDevServerAsync(devServerUrl);
    const ids = probe.targets
      .map((target) => target.id)
      .sort()
      .join(',');
    if (previous != null && ids === previous && ids !== '') {
      return { stable: true };
    }
    previous = ids;
    if (Date.now() + TARGET_SETTLE_POLL_MS >= deadline) {
      return { stable: false };
    }
    await new Promise((resolve) => setTimeout(resolve, TARGET_SETTLE_POLL_MS));
  }
}

/** A debugger failure as one phase reason: a refusal keeps its Why, because that names what was skipped. */
function debuggerFailureReason(error: unknown): string {
  if (error instanceof CommandError) {
    return error.message
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('How:'))
      .join(' ');
  }
  return error instanceof Error ? firstLine(error.message) : String(error);
}
