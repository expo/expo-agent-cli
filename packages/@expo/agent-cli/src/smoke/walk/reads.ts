import { stopWithPicture } from './capture';
import type { SmokeErrorsResult, SmokeEvaluateResult } from '../contract';
import { isFailingRecord, noReload } from '../results';
import {
  RELOAD_TIMEOUT_MS,
  RUNTIME_READY_POLL_MS,
  RUNTIME_READY_TIMEOUT_MS,
  RUNTIME_UNSUPPORTED_GRACE_MS,
} from '../timeouts';
import type { PhaseWalk, Step } from './walk';

// ---- Phase 6: is the app that answers the rest of this run the code on disk? --------------
//
// @ref llp/0005-runtime-loop-tools.rfc.md §The app under test is the code on disk
//
// The phase that makes the three after it mean something. `runtime`, `errors` and `screenshot`
// all read *the app*, and an app that was already attached when this run arrived is running
// whatever it last loaded — which, at the moment this command is for, is the bundle from before
// the edit the caller wants verified. Without this the gate reported `passed` over a `throw` at
// the top of the entry component, with the *previous* screen in the screenshot [observed — iOS
// 26.5 simulator, Expo Go SDK 57, 2026-09-03; `errors` ok at 3.1 s, exit 0].
//
// llp/0005 §Reloading the app had already written the rule this phase applies — "an error window
// is a property of the app's session, and the session outlives the fix" — and named the command
// that must not be believed without it. `smoke` reads that window and was not applying it.
export async function reloadStep(walk: PhaseWalk): Promise<void> {
  const { deps, options, phases, remaining } = walk;
  const { devServerUrl } = walk.report;
  const reloadJson = noReload();
  walk.report.reload = reloadJson;

  if (walk.app.openedByThisRun) {
    // Nothing to replace: the app came up during the `app` phase, so it fetched the bundle the dev
    // server is serving now on its way in. A reload here would cost a relaunch to reach the state
    // the run is already in.
    phases.push({
      id: 'reload',
      status: 'skipped',
      ms: 0,
      reason: 'this run opened the app, so it already fetched the bundle the dev server is serving',
    });
  } else if (!options.reload) {
    // Asked for, so the row says which of the two questions this run is answering rather than
    // reading as a step that was owed and not done. The verdict is left alone: "is the app throwing
    // where I left it" is a real question, and it is the one this caller asked.
    reloadJson.disposition = 'declined';
    phases.push({
      id: 'reload',
      status: 'skipped',
      ms: 0,
      reason:
        '--no-reload was given, so the app was read on the bundle it already had, which may predate the code on disk',
    });
  } else {
    const { value: reloaded } = await walk.record(
      'reload',
      async () => {
        const result = await deps.reloadApp(devServerUrl, Math.min(RELOAD_TIMEOUT_MS, remaining()));
        reloadJson.knownTargetIds = result.knownTargetIds;
        reloadJson.freshTargets = result.freshTargets;
        reloadJson.commandSocketReconnected = result.commandSocketReconnected;
        reloadJson.targetOutcomes = result.targetOutcomes;
        reloadJson.bundleServed = result.bundleServed;
        if (result.ok) {
          reloadJson.disposition = 'reloaded';
          reloadJson.verifiedBy = result.verifiedBy;
          return {
            status: 'ok' as const,
            reason: `${result.reason ?? 'the app was reloaded'} (${result.verifiedBy})`,
            value: result,
          };
        }
        // @ref llp/0021-honest-reports.rfc.md §The rules band. Not `failed`: nothing has been shown
        // to be wrong with the app, and the next action is to look again rather than to fix
        // something. What is unknown is *which session* the phases below are about, and that is
        // exactly the band `inconclusive` exists for (llp/0010 §Exit codes).
        reloadJson.disposition = 'unproved';
        return {
          status: 'inconclusive' as const,
          reason: `${result.reason ?? 'nothing was observed to come of the reload'}, so what the phases below read may be the session from before the code on disk`,
          value: result,
        };
      },
      { budgetMs: Math.min(RELOAD_TIMEOUT_MS, remaining()) }
    );
    if (reloaded.ok) {
      // The app is coming back, so it owes the same waits a freshly opened one does: the settle
      // before the reads, and the runtime-ready poll rather than a single look
      // (@ref ../timeouts §APP_SETTLE_MS, §RUNTIME_READY_TIMEOUT_MS). A reload that was *not* proved
      // must not claim them — an app that never acted is not coming up, and waiting on it would
      // spend the caller's budget proving nothing.
      walk.app.noteReloaded();
    }
  }
}

// ---- Phase 7: the route, unless the app phase already opened it -------------------------
export async function routeStep(walk: PhaseWalk): Promise<Step<null>> {
  const { deps, options, phases } = walk;
  if (options.route == null) {
    phases.push({
      id: 'route',
      status: 'skipped',
      ms: 0,
      reason: 'no --route was given, so the app was read where it already was',
    });
    return { next: null };
  }
  // A `--route` was given, so an app the `app` phase opened was opened on it.
  if (walk.app.openedByThisRun) {
    phases.push({
      id: 'route',
      status: 'ok',
      ms: 0,
      reason: 'it was the route the app was opened on, above',
    });
    return { next: null };
  }
  const route = options.route;
  const { value: opened } = await walk.record('route', async () => {
    const result = await deps.openRoute(route, walk.report.devServerUrl, walk.attachBudget());
    walk.app.noteOpened(result);
    return result.exitCode === 0
      ? { status: 'ok' as const, reason: `opened ${result.url}`, value: result }
      : {
          status: 'failed' as const,
          reason: `the device refused the deep link ("${result.command}" exited ${result.exitCode ?? 'on a signal'})`,
          value: result,
        };
  });
  if (opened.exitCode === 0) {
    return { next: null };
  }
  walk.skipRest(
    'runtime',
    'the route was not opened, so the app is not on the screen under test',
    'screenshot'
  );
  // The route was refused, so whatever is on screen is not the route under test.
  return { stop: await stopWithPicture(walk, 'failed', walk.app.showingWithoutApp()) };
}

/**
 * Ask the runtime until it answers, for an app this run opened.
 *
 * @ref ../timeouts §RUNTIME_READY_TIMEOUT_MS. The settle before it waits for the target *list* to
 * stop changing, which is a fact about registration and turned out to be too weak a proxy for "the
 * bundle has run": two reads of one id 500 ms apart are alike whether the app is ready or about
 * to reload. This asks the runtime itself, which is the thing the phase is about.
 *
 * An app that was already there when this run arrived **and was not reloaded** is asked once,
 * exactly as before: it is not coming up, so a second look would answer the same and cost the
 * caller a wait. One this run reloaded *is* coming up, and gets the same poll a cold launch does.
 */
async function evaluateUntilReadableAsync(walk: PhaseWalk): Promise<SmokeEvaluateResult> {
  const { deps } = walk;
  const { devServerUrl } = walk.report;
  const deadline = deps.now() + (walk.app.movedByThisRun ? RUNTIME_READY_TIMEOUT_MS : 0);
  let unsupportedSince: number | null = null;
  for (;;) {
    const result = await deps.evaluate(devServerUrl);
    const now = deps.now();
    // `unsupported` is decided only after the grace: a runtime with no debugger (llp/0005
    // §Android) will not grow one, but a reloading one answers the same way until it is back.
    const unsupportedFor = result.unsupported ? now - (unsupportedSince ??= now) : 0;
    if (result.ok || now >= deadline || unsupportedFor >= RUNTIME_UNSUPPORTED_GRACE_MS) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, RUNTIME_READY_POLL_MS));
  }
}

// ---- Phase 8: can the runtime be read at all? ---------------------------------------------
// ---- Phase 9: what did the app report while it was watched? -------------------------------
export async function runtimeAndErrorsStep(
  walk: PhaseWalk
): Promise<{ runtime: SmokeEvaluateResult; collected: SmokeErrorsResult }> {
  const { deps, options } = walk;
  const { devServerUrl } = walk.report;
  // @ref ../timeouts §APP_SETTLE_MS. Before the read rather than only before the picture: an app that
  // has just been launched onto a simulator this run booted is still registering, and asking a
  // debugger target list mid-churn answers "No target found" about an app that is running fine.
  await walk.app.settleAsync();

  const { value: runtime } = await walk.record('runtime', async () => {
    const result = await evaluateUntilReadableAsync(walk);
    if (result.ok) {
      return { status: 'ok' as const, value: result };
    }
    return {
      // Both are "nothing was proved", and they differ only in whether looking again could help.
      status: 'inconclusive' as const,
      reason: result.unsupported
        ? 'this runtime has no debugger, so an error window from it would be empty whatever the app is doing'
        : (result.reason ?? 'the runtime did not answer'),
      value: result,
    };
  });

  // Opened even for a runtime that cannot be evaluated, because an empty window costs one wait and
  // the report is more useful with it — but the *verdict* never rests on it. That is the rule
  // llp/0005-runtime-loop-tools.rfc.md §Android forces: Expo Go on Android acknowledges `Runtime.enable` and reports
  // nothing, so an empty window there is silence and not health.
  const { value: collected } = await walk.record(
    'errors',
    async () => {
      const result = await deps.collectErrors(devServerUrl, options.windowMs);
      if (!result.ok) {
        return {
          status: 'inconclusive' as const,
          reason: result.reason ?? 'the error window could not be opened',
          value: result,
        };
      }
      const failing = result.records.filter(isFailingRecord);
      if (failing.length > 0) {
        return {
          status: 'failed' as const,
          reason: `${failing.length} ${failing.length === 1 ? 'error' : 'errors'} reported by the app: ${failing[0]!.message}`,
          value: result,
        };
      }
      if (!runtime.ok) {
        return {
          status: 'inconclusive' as const,
          reason: 'the window was empty, and this runtime reports nothing whatever the app does',
          value: result,
        };
      }
      return {
        status: 'ok' as const,
        reason:
          result.records.length > 0
            ? `${result.records.length} console.error ${result.records.length === 1 ? 'line' : 'lines'}, none of them an error the app reported`
            : null,
        value: result,
      };
    },
    { budgetMs: null }
  );
  return { runtime, collected };
}
