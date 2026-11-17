// @ref llp/0005-runtime-loop-tools.rfc.md §The smoke gate
// @ref llp/0010-agent-conventions.rfc.md §Exit codes
// `@expo/agent-cli smoke`: the composite gate.
//
// This module holds the command run, its report and `buildSmokeDeps`, and nothing else. The
// decisions are in `phases.ts` and `walk/*`, which are given the deps rather than importing them, so the outcome
// table can be tested against fakes. The real deps are in `deps/*`, one function per phase question,
// and each is the same function the command that owns the question already calls.

import { event } from '../events';
import { buildSmokeFollowUps, followUpsEnabled, reportFollowUps } from '../followups';
import * as Log from '../log';
import { assertEasProjectConfiguredAsync } from '../needsHuman/easProject';
import { describeSkippedApps } from '../runtime/targetSelection';
import { createAppDeps, waitForStableTargets } from './deps/app';
import { createDeviceDeps } from './deps/device';
import { createDevServerDeps } from './deps/devServer';
import { createSmokeDepsContext } from './deps/shared';
import { startPortArgs } from './deps/startArgs';
import { formatSmokeResult, smokeResultToJson } from './format';
import type { CloudRouteCell, SmokeDeps, SmokeRun } from './contract';
import { runSmokePhasesAsync, smokeExitCode } from './phases';
import { buildSmokeProgress } from './progress';
import type { SmokeOptions } from './resolveOptions';
import { isFailingRecord } from './results';
import type { SmokeEnvironmentJson } from './types';

/** @ref llp/0035-one-device-per-worktree.rfc.md §Lifecycle smoke */
export function cleanupLeft(environment: SmokeEnvironmentJson): {
  serverStopped: boolean;
  deviceReleased: boolean;
} {
  return {
    serverStopped: environment.cleanup.some(({ resource, ok }) => resource === 'dev-server' && ok),
    deviceReleased: environment.boundDevice?.released === true,
  };
}

/**
 * Run the gate, report it, and answer with the exit code.
 *
 * @returns the exit code, per llp/0010 §Exit codes: `0` passed, `20` failed, `22` inconclusive.
 * A *tool* error — a route the project has not got, an unusable flag — is thrown instead, so it
 * gets the `1` and the envelope every other tool failure in this CLI gets.
 */
export async function smokeAsync(projectRoot: string, options: SmokeOptions): Promise<number> {
  if (options.cloud === 'required') {
    await assertEasProjectConfiguredAsync(projectRoot);
  }
  const run = await runSmokePhasesAsync(buildSmokeDeps(projectRoot, options), options);
  // Once per run, from the connection the verdict rests on, not once per wait.
  if (run.appsConnected != null && run.appsConnected > 0 && run.skippedApps.length > 0) {
    Log.progress(describeSkippedApps(run.skippedApps));
  }

  event('smoke', {
    outcome: run.outcome,
    devServerUrl: run.devServerUrl,
    source: run.discovery?.source ?? null,
    started: run.started,
    // What this run did to the machine, on the stream too: an agent watching events rather than
    // stdout has to be able to see that a dev server appeared and went again.
    devServer: run.environment.devServer,
    device: run.environment.device,
    leftBehind: run.environment.cleanup.filter((entry) => !entry.ok).map((entry) => entry.resource),
    appsConnected: run.appsConnected,
    bundle: run.bundle?.outcome ?? null,
    runtimeSupported: run.runtimeSupported,
    errorCount: run.windowMs == null ? null : run.errors.length,
    screenshot: run.screenshot.ok,
    durationMs: run.durationMs,
    phases: run.phases.map((phase) => ({ id: phase.id, status: phase.status, ms: phase.ms })),
  });

  const followups = followUpsEnabled(options.followups) ? buildFollowUps(run, options) : [];

  if (options.json) {
    Log.log(JSON.stringify(smokeResultToJson(run, options, followups), null, 2));
  } else {
    Log.log(formatSmokeResult(run, options));
  }
  reportFollowUps('smoke', followups, { json: options.json });

  if (run.outcome !== 'passed') {
    Log.error(explainOutcome(run));
  }
  return smokeExitCode(run.outcome);
}

/** The follow-ups of one run, from the facts it established. */
function buildFollowUps(run: SmokeRun, options: SmokeOptions) {
  return buildSmokeFollowUps({
    outcome: run.outcome,
    devServerFound: run.discovery?.reachable ?? false,
    bootstrap: options.bootstrap,
    foreignDevServer: run.projectRootMatched === false,
    bundleBroken: run.bundle?.outcome === 'broken',
    bundleFile: run.bundle?.error?.filename ?? null,
    appsConnected: run.appsConnected,
    runtimeSupported: run.runtimeSupported,
    failing: run.errors.filter(isFailingRecord).length,
    screenshotTaken: run.screenshot.ok,
    screenshotPath: run.screenshot.ok ? run.screenshot.path : null,
    route: options.route,
    platform: options.platform,
    reloadDisposition: run.reload.disposition,
    appMismatch: run.appMismatch,
    appMismatchKind: run.appMismatchKind,
    // The `start-dev-server` phase is only in the list for a run that performed one, and it is
    // charged as a build when the plan compiled (@ref ./timeouts §BUILD_DEV_SERVER_TIMEOUT_MS).
    buildAttempted: run.buildAttempted,
    ...cleanupLeft(run.environment),
    port: startPortArgs(options.devServerUrl)[1] ?? null,
    // `required` is `--eas`; `fallback` is a run that would only reach a session if this machine
    // had no device, and a ladder must not put a billed session on a line the caller never asked
    // for (llp/0005 §Cloud simulator).
    cloud: run.cloudRoute === 'required',
  });
}

/**
 * The what / why / how of a run that did not pass.
 *
 * Built from the first phase that was not `ok`, because that is the one the rest followed from:
 * a report that led with the last thing to happen would explain the silence of a runtime that was
 * never reached.
 */
function explainOutcome(run: SmokeRun): string {
  const culprit = run.phases.find(
    (phase) => phase.status === 'failed' || phase.status === 'inconclusive'
  );
  const what =
    run.outcome === 'failed'
      ? `The smoke gate failed at "${culprit?.id ?? 'an unknown phase'}".`
      : `The smoke gate could not decide, at "${culprit?.id ?? 'an unknown phase'}".`;
  const why = culprit?.reason ?? 'no phase reported a reason, which is a bug in this command.';
  const how =
    run.outcome === 'failed'
      ? `Read the phase list above: every phase before the one that failed did answer, so the failure is about what that phase asked and nothing later. The "Suggested next:" line is the command that acts on it.`
      : `Nothing was shown to be wrong and nothing was proved right, so this is not a failure to act on. ${
          run.appMismatchKind === 'expo-go-version'
            ? // @ref llp/0005 §The Expo Go on the device is not the Expo Go the SDK wants. Looking
              // again changes nothing *while the device holds that copy* — but unlike the case
              // below, the thing that has to change is cheap and this command does it itself.
              'The Expo Go on the device is built from another SDK, so looking again reads the same wrong runtime — a run without --no-start installs the release this SDK ships and reads that.'
            : run.appMismatch != null
              ? // @ref llp/0009 §the no-useless-re-run rule. The one inconclusive state looking
                // again cannot change: the same Expo Go will answer the same way for ever, so "look
                // again" here would send a caller round a loop with no exit.
                'The app that answered cannot run this project at all, so looking again reads the same wrong runtime — the development build is what has to exist first.'
              : run.runtimeSupported === false
                ? 'This runtime carries no debugger, so no window read from it will ever say anything — a development build, or iOS, is what answers.'
                : 'Looking again is the honest next step, with a longer --timeout when a first build was still running.'
        }`;
  return [what, `Why: ${why}`, `How: ${how}`].join('\n');
}

/**
 * The real dependencies: for each phase, the function the command that owns that question calls.
 * Each `deps/*` module builds its own slice, with the state it alone reads and writes.
 *
 * Cited rather than reimplemented, and that is the point of the whole module — a second reading of
 * "is the bundle broken" or "which URL does this route deep-link to" is a second place for the
 * findings behind them to be forgotten.
 */
export function buildSmokeDeps(projectRoot: string, options: SmokeOptions): SmokeDeps {
  const cloudRoute: CloudRouteCell = { current: options.cloud };
  const ctx = createSmokeDepsContext(projectRoot, options, cloudRoute);
  return {
    cloudRoute,
    ...createDevServerDeps(ctx),
    ...createDeviceDeps(ctx),
    ...createAppDeps(ctx),
    waitForStableTargets,

    // @ref llp/0005-runtime-loop-tools.rfc.md §The gate says what it is doing while it does it
    progress: buildSmokeProgress(options, { installKind: () => ctx.installKind }),

    now: () => Date.now(),
  };
}
