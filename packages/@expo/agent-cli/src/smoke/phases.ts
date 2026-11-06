// @ref llp/0005-runtime-loop-tools.rfc.md §The smoke gate
// @ref llp/0010-agent-conventions.rfc.md §Exit codes
// The gate itself: nine phases, one verdict — and two more that only some runs perform.
//
// Every phase is a question one existing command already answers, asked here through the same
// function rather than by running that command again. That is the whole design constraint. A
// `smoke` built out of subprocesses of itself would have nine processes, nine dev-server
// discoveries, and nine chances for the answers to disagree — and it would hand back a chain of
// exit codes rather than one.
//
// The phases and where each one comes from:
//
// | phase              | the command whose question it is | the function                |
// | ------------------ | -------------------------------- | --------------------------- |
// | `start-dev-server` | `dev --detach` (conditional)     | `devDetachAsync`            |
// | `dev-server`       | every runtime command            | `discoverDevServerAsync`    |
// | `bundler-ready`    | this command only                | `waitForBundlerReadyAsync`  |
// | `bundle`           | this command, `runtime:reload`   | `checkEntryBundleAsync`     |
// | `boot-device`      | `dev` (conditional)              | `acquireDeviceAsync`        |
// | `install-app`      | (new, conditional)               | `installExpoGoAsync`        |
// | `app`              | this command only                | `waitForAppConnectionAsync` |
// | `reload`           | `runtime:reload`                 | `runRungOneAsync`           |
// | `route`            | `navigate`                       | `openRouteAsync`            |
// | `runtime`          | `runtime:eval`                   | `CdpClient.evaluateAsync`   |
// | `errors`           | `runtime:errors`                 | `CdpRuntimeErrorCollector`  |
// | `screenshot`       | (new)                            | `captureScreenshotAsync`    |
//
// The `bundler-ready`/`bundle`/`app` rows used to be `dev:wait`'s, which the v1 narrowing deferred
// (llp/0016). The library functions they call are unchanged and still live in `src/runtime/`; only
// the second command that called them is gone.
//
// **The three conditional phases are acts rather than questions**, and that shapes three things
// (llp/0005 §The run brings its own environment): they are reported only by a run that performed
// them, they are never charged to `--timeout`, and the ones that hold a resource register the way
// to undo themselves *before* they do anything. `runSmokePhasesAsync` is the wrapper that runs
// those undos, newest first, on every path out of the walk. A booted device registers its release
// only after a reused dev server; after a started one, `dev:stop --release` releases it
// (llp/0035 §Lifecycle smoke).
//
// The dependencies are injected rather than imported, so the outcome table below — which is the
// part that can be wrong in a way no type checker sees — is testable against fakes, with no dev
// server, no device and no clock.

import type { ReleasedDevice } from '../deviceBinding';
import { EXIT_OK, EXIT_OUTCOME_FAILED, EXIT_OUTCOME_TIMEOUT } from '../exitCodes';
import { firstLine } from '../utils/text';
import type { RegisteredCleanup, SmokeDeps, SmokeRun, SmokeRunContext } from './contract';
import { stopWithPicture } from './walk/capture';
import type { SmokeOptions } from './resolveOptions';
import { isFailingRecord } from './results';
import type { SmokeCleanupJson, SmokeEnvironmentJson, SmokeOutcome } from './types';
import { appFitStep, appStep } from './walk/app';
import { bundlerReadyStep, bundleStep } from './walk/bundle';
import { prepareDeviceStep } from './walk/device';
import { devServerStep } from './walk/devServer';
import { reloadStep, routeStep, runtimeAndErrorsStep } from './walk/reads';
import { createPhaseWalk, type WalkRun } from './walk/walk';

/**
 * The exit code one verdict deserves (llp/0010 §Exit codes).
 *
 * Three codes for three answers, and the split between the last two is what the band exists for:
 * after `20` the next action is to fix something, and after `22` it is to look again. Collapsing
 * them would send an agent to debug an app that is fine, or to re-run a gate that will fail the
 * same way until a file is edited.
 *
 * Kept next to the outcome it maps, and pure, so the table is testable as a table.
 */
export function smokeExitCode(outcome: SmokeOutcome): number {
  switch (outcome) {
    case 'passed':
      return EXIT_OK;
    case 'failed':
      return EXIT_OUTCOME_FAILED;
    default:
      return EXIT_OUTCOME_TIMEOUT;
  }
}

/**
 * Run the gate.
 *
 * Never throws for anything about the *app*: an app that crashes, a bundle that does not compile
 * and a runtime that cannot be read are all outcomes this reports. It does propagate a genuine
 * tool failure — a route the project has not got, a `--dev-server-url` typo — because those are
 * the caller's own command being wrong, which is exit `1` and not a verdict on the project
 * (llp/0010 §Exit codes).
 */
export async function runSmokePhasesAsync(
  deps: SmokeDeps,
  options: SmokeOptions
): Promise<SmokeRun> {
  const startedAt = deps.now();
  const cleanups: RegisteredCleanup[] = [];
  const environment: SmokeEnvironmentJson = {
    devServer: 'absent',
    device: 'absent',
    deviceChoice: null,
    boundDevice: null,
    cleanup: [],
  };

  // The cleanup runs on both paths, and neither of them is a `finally` that swallows anything: a
  // tool error still propagates, and it still leaves the machine as it found it. `durationMs` is
  // computed afterwards because the caller waited for the cleanup too, and a run that reported
  // `4.2s` while spending eight seconds shutting a simulator down would be describing a moment
  // that had passed (llp/0021 §The rules).
  try {
    const run = await runPhasesAsync(deps, options, {
      startedAt,
      cloudRoute: deps.cloudRoute,
      cleanups,
      environment,
    });
    // Whether a device was *reused* is read off the run rather than probed for, and that is what
    // keeps a healthy run free of device tools: the phase that decides about a boot only asks
    // about a device when no app is connected, so on the ordinary run nothing has asked yet when
    // it goes past. The screenshot resolves one anyway (F98), and that is the answer.
    if (environment.device === 'absent' && run.deviceId != null) {
      environment.device = 'reused';
    }
    if (environment.device === 'reused' && environment.boundDevice == null) {
      const existing = deps.readBoundDevice();
      if (existing != null && existing.id === run.deviceId) {
        environment.boundDevice = {
          ...existing,
          action: 'existing',
          released: null,
          shutDown: false,
        };
      }
    }
    await releaseAsync(deps, cleanups, environment);
    return { ...run, environment, durationMs: deps.now() - startedAt };
  } catch (error: unknown) {
    await releaseAsync(deps, cleanups, environment);
    throw error;
  }
}

/**
 * Put back everything this run started, newest first, and report each one.
 *
 * Newest first because the two are ordered: the dev server was started before the device was
 * booted, and an app left talking to a bundler that has gone is a worse state to leave a machine in
 * than the reverse.
 *
 * Nothing here throws. A cleanup that fails is a **fact of the run**, and it is reported rather
 * than folded into the verdict: whether a dev server would stop says nothing about whether the app
 * boots, and a gate that failed on it would report a broken app to a caller whose app is fine.
 */
async function releaseAsync(
  deps: SmokeDeps,
  cleanups: RegisteredCleanup[],
  environment: SmokeEnvironmentJson
): Promise<void> {
  const released: SmokeCleanupJson[] = [];
  const devices: ReleasedDevice[] = [];
  for (const cleanup of [...cleanups].reverse()) {
    const at = deps.now();
    try {
      const result = await cleanup.release();
      devices.push(...(result.devices ?? []));
      released.push({
        resource: cleanup.resource,
        target: result.target ?? cleanup.target,
        ok: result.ok,
        reason: result.ok ? null : (result.reason ?? 'no reason was given'),
        ms: deps.now() - at,
      });
      if (cleanup.resource === 'dev-server') {
        for (const device of result.devices ?? []) {
          released.push({
            resource: 'device',
            target: device.id,
            ok: device.released === true,
            reason: device.released ? null : (device.reason ?? 'no reason was given'),
            ms: deps.now() - at,
          });
        }
      }
    } catch (error: unknown) {
      released.push({
        resource: cleanup.resource,
        target: cleanup.target,
        ok: false,
        reason: `the cleanup itself failed: ${error instanceof Error ? firstLine(error.message) : String(error)}`,
        ms: deps.now() - at,
      });
    }
  }
  environment.cleanup = released;
  const bound = environment.boundDevice;
  const device = bound && devices.find(({ id }) => id === bound.id);
  if (bound && device) {
    bound.released = device.released;
    bound.shutDown = device.shutDown;
  }
}

/** The phases themselves, in order. Everything they start is registered with the context first. */
async function runPhasesAsync(
  deps: SmokeDeps,
  options: SmokeOptions,
  ctx: SmokeRunContext
): Promise<WalkRun> {
  const walk = createPhaseWalk(deps, options, ctx);

  const found = await devServerStep(walk);
  if ('stop' in found) return found.stop;
  const ready = await bundlerReadyStep(walk);
  if ('stop' in ready) return ready.stop;
  const bundled = await bundleStep(walk);
  if ('stop' in bundled) return bundled.stop;
  const device = await prepareDeviceStep(walk);
  if ('stop' in device) return device.stop;
  const attached = await appStep(walk, device.next);
  if ('stop' in attached) return attached.stop;
  const { appMismatch, appMismatchKind } = await appFitStep(walk, attached.next);
  await reloadStep(walk);
  const routed = await routeStep(walk);
  if ('stop' in routed) return routed.stop;
  const { runtime, collected } = await runtimeAndErrorsStep(walk);

  // The verdict. `failed` needs something to have gone wrong; `passed` needs the runtime to have
  // answered, so a window nobody could have read is never a pass.
  //
  // **And it needs the window to be of the code on disk** (@ref ./walk/reads §reloadStep). A
  // reload that was attempted and never observed leaves the run unable to say which of two
  // sessions the runtime read and the window are about, and `passed` is a claim about the app the
  // caller has on disk. `threw` still wins: an app that reported an error has been shown to be
  // broken, and which session it was is no longer the open question.
  const threw = collected.records.some(isFailingRecord);
  const sessionKnown = walk.report.reload.disposition !== 'unproved';
  // @ref llp/0005 §Expo Go is only a target for a project that fits in it. `threw` still outranks
  // it: Expo Go reporting an error while running this project's bundle is a fact about the code,
  // whichever app was holding it.
  const appFitsProject = appMismatch == null;
  const outcome = threw
    ? 'failed'
    : runtime.ok && collected.ok && sessionKnown && appFitsProject
      ? 'passed'
      : 'inconclusive';

  // ---- Phase 10: the picture ----------------------------------------------------------------
  //
  // The settle was already done before the runtime read on this path, so it costs nothing here:
  // the wait happens once per run, for a run that opened the app. An app is connected on this
  // path — the run got past the `app` phase — so the picture is of the project.
  return stopWithPicture(walk, outcome, 'project', {
    runtimeSupported: runtime.unsupported ? false : runtime.ok ? true : null,
    appMismatch,
    appMismatchKind,
    windowMs: options.windowMs,
    errors: collected.records,
  });
}
