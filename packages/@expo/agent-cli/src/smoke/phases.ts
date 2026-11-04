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

import type { ScreenshotResult } from '../device/screenshot';
import type { AcquireAction, ReleasedDevice } from '../deviceBinding';
import { EXIT_OK, EXIT_OUTCOME_FAILED, EXIT_OUTCOME_TIMEOUT } from '../exitCodes';
import type { DeviceBackend } from '../navigate/device';
import type { OpenRouteResult } from '../navigate/openRoute';
import type { RouteCheckJson } from '../navigate/routeCheck';
import type { BundleCheckResult } from '../runtime/bundleCheck';
import type { DevServerDiscovery } from '../runtime/devServer';
import type { RuntimeErrorRecord } from '../runtime/runtimeErrorCollector';
import type { SkippedApp } from '../runtime/targetSelection';
import type { AppConnectionResult, BundlerReadyResult } from '../runtime/waitReady';
import { firstLine } from '../utils/text';
import { stopWithPicture } from './capture';
import type { SmokeProgress } from './progress';
import type { SmokeOptions } from './resolveOptions';
import { isFailingRecord } from './results';
import type {
  SmokeCleanupJson,
  SmokeEnvironmentJson,
  SmokeOutcome,
  SmokePhase,
  SmokeReloadJson,
  SmokeResource,
} from './types';
import { appFitStep, appStep } from './walk/app';
import { bundlerReadyStep, bundleStep } from './walk/bundle';
import { prepareDeviceStep } from './walk/device';
import { devServerStep } from './walk/devServer';
import { reloadStep, routeStep, runtimeAndErrorsStep } from './walk/reads';
import { createPhaseWalk } from './walk/walk';

/** What starting a dev server amounted to. */
export interface SmokeStartResult {
  ok: boolean;
  /** Origin it came up on, when it did. */
  devServerUrl: string | null;
  /** Why it did not. Null exactly when {@link ok} is true. */
  reason: string | null;
  /**
   * The plan this start ran **compiled** something.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §It builds what the app needs, and says so first
   * Reported whether the start succeeded or failed, because what it changes — the cheapest way to
   * find out why — is most useful exactly when it failed.
   */
  built?: boolean;
  /** The worktree device the detached `dev` bound, read from its binding file, for the report. */
  bound?: { id: string; name: string; action: AcquireAction | 'existing' };
}

/** What booting a simulator or an emulator amounted to. */
export interface SmokeBootResult {
  ok: boolean;
  /** The device that came up. Null exactly when {@link ok} is false. */
  deviceId: string | null;
  backend: DeviceBackend | null;
  /** Why none came up. Null exactly when {@link ok} is true. */
  reason: string | null;
  /** Why this device rather than another, for the report. Null when none was chosen. */
  choice?: string | null;
  /**
   * The device came up **without** the app, so the caller has an install to do.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §Putting Expo Go on a simulator that has not got it
   */
  installNeeded?: boolean;
  /** The worktree device the boot bound, for the report. */
  bound?: { name: string; action: AcquireAction };
}

/** What putting the app on a device amounted to. Never a throw: a failed install is a result. */
export interface SmokeInstallResult {
  ok: boolean;
  /** The version that was installed, when the installer could name one. */
  version: string | null;
  /**
   * The version that was there before, when this replaced one rather than adding it.
   *
   * Two different things to do to somebody's machine, and the row says which (llp/0021 §The rules).
   */
  replaced?: string | null;
  /** Why it was not. Null exactly when {@link ok} is true. */
  reason: string | null;
}

/** What putting one thing back amounted to. Never a throw: a cleanup that failed is a result. */
export interface SmokeReleaseResult {
  ok: boolean;
  /** What was released, for the report. */
  target: string | null;
  /** Why it was not. Null exactly when {@link ok} is true. */
  reason: string | null;
  /** The bound devices this release let go of. */
  devices?: ReleasedDevice[];
}

/** What making sure there is an EAS Simulator session amounted to. */
export interface SmokeSessionResult {
  ok: boolean;
  /** The session that is up, or null. */
  sessionId: string | null;
  /** Whether this run started it, which is what registers the cleanup. */
  started: boolean;
  /** Why there is none. Null exactly when {@link ok} is true. */
  reason: string | null;
}

/** What asking the runtime to evaluate `1` amounted to. */
export interface SmokeEvaluateResult {
  /** The runtime answered, whatever it answered with. */
  ok: boolean;
  /**
   * The runtime has no `Runtime.evaluate` handler at all.
   *
   * The Expo Go Android case (llp/0005-runtime-loop-tools.rfc.md §Android), and the reason it is a field of its own: a
   * runtime that cannot be evaluated also reports an *empty error window*, so the window that
   * follows proves nothing and the run must never pass on it.
   */
  unsupported: boolean;
  /** What went wrong, for the report. Null when it answered. */
  reason: string | null;
}

/**
 * What putting an already-attached app back on the served bundle amounted to.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §The app under test is the code on disk
 * Never a throw: a reload that could not be performed is a fact this gate reports, not a tool
 * failure — the run still has a picture and an error window to hand back, and the phase's job is to
 * say which session they are of.
 */
export interface SmokeReloadResult {
  /** The reload mechanism ran and was **observed** to have reloaded the app. */
  ok: boolean;
  /**
   * What proved it. Null exactly when {@link ok} is false.
   *
   * Under llp/0021's rule: named only when this result's own evidence field for it is non-empty, so
   * `ok` and a label with nothing behind it cannot be reported together.
   */
  verifiedBy: SmokeReloadJson['verifiedBy'];
  /** The targets listed before the broadcast, which is what makes a later one "fresh". */
  knownTargetIds: string[];
  /** Targets seen afterwards under an id that was not in that list. */
  freshTargets: number;
  /** Whether the app's client on the command socket was replaced. */
  commandSocketReconnected: boolean;
  targetOutcomes: SmokeReloadJson['targetOutcomes'];
  /** Whether the dev server was seen to serve a bundle after this run acted. */
  bundleServed: boolean;
  /** Why nothing was proved. Null exactly when {@link ok} is true. */
  reason: string | null;
}

/** What the error window amounted to. Never a throw: an unreadable app is a result. */
/**
 * Which of the two reasons an app cannot run this project.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §Expo Go is only a target for a project that fits in it
 * @ref llp/0005-runtime-loop-tools.rfc.md §The Expo Go on the device is not the Expo Go the SDK wants
 *
 * Carried as a value rather than left to be read out of the sentence, because the **next action is
 * different for each** and the follow-ups have to pick one (llp/0021 §The rules — nothing
 * downstream should have to match English to act):
 *
 * - `expo-go-incompatible`: this project's native code is not in Expo Go's runtime, and no version
 *   of Expo Go will ever run it. The answer is a development build.
 * - `expo-go-version`: the project fits in Expo Go, and the copy on the device is built from a
 *   different SDK. The answer is the right copy, which this gate installs for itself on any run
 *   that was not told to change nothing.
 *
 * Suggesting a development build for the second would send a caller to a twenty-minute compile to
 * fix something a re-run without `--no-start` fixes in seconds.
 */
export type SmokeAppMismatchKind =
  | 'expo-go-incompatible'
  | 'expo-go-version'
  /**
   * The device has not got the app at all, so nothing there handles this project's link.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §A refused link is a device without the app
   * The development-build case, and the reason it is a *third* kind: `smoke` installs Expo Go for
   * itself, and a development build is this project's own artefact to compile — so the answer is
   * `dev --<platform>` and not a re-run of anything.
   */
  | 'app-not-installed';

/** What asking "can the app under test run this project" came to. @see SmokeDeps.checkAppFitsProject */
export interface SmokeAppFit {
  /** Why it cannot, or null when it can — or when nothing could be decided. */
  mismatch: string | null;
  /** Which kind of "cannot". Null exactly when {@link mismatch} is. */
  kind: SmokeAppMismatchKind | null;
  /** A finding worth printing that decides nothing. */
  note: string | null;
}

export interface SmokeErrorsResult {
  ok: boolean;
  records: RuntimeErrorRecord[];
  /** Why the window could not be opened. Null when it was. */
  reason: string | null;
}

/** Everything the runner needs from the outside world, so none of it happens here. */
export interface SmokeDeps {
  discoverDevServer(explicitUrl: string | null): Promise<DevServerDiscovery>;
  startDevServer(): Promise<SmokeStartResult>;
  /**
   * Stop the dev server this run started. Only ever called for one this run started.
   *
   * Never throws, and answers `ok` for a dev server that is already gone: the question a cleanup
   * asks is "is it not running now", and a start that died on its own has answered it.
   */
  stopDevServer(): Promise<SmokeReleaseResult>;
  /**
   * Make sure this project has an EAS Simulator session on this run's platform with the app on it.
   *
   * @ref llp/0027-everything-on-eas.rfc.md §smoke
   * The `--eas` counterpart of {@link bootDevice} and {@link installApp} in one: a session is started
   * with the app on its command line, or the one in progress is reused. Only called on `--eas`, and
   * only for a run allowed to bring its own environment. A development build with no finished
   * simulator build of this fingerprint on EAS is a failure here, never a build — a gate does not
   * spend fifteen minutes compiling.
   */
  ensureEasSession(devServerUrl: string): Promise<SmokeSessionResult>;
  /** End the session this run started. Only ever called for one this run started. */
  stopEasSession(sessionId: string): Promise<SmokeReleaseResult>;
  /**
   * Bind and boot this worktree's device for this run's platform (`acquireDeviceAsync`). The
   * device is released by dev:stop after a child exits, or by the boot phase's own cleanup.
   */
  bootDevice(): Promise<SmokeBootResult>;
  releaseDevice(): Promise<SmokeReleaseResult>;
  /** This worktree's binding for the run's platform, read only. Null when there is none. */
  readBoundDevice(): { id: string; name: string } | null;
  /**
   * Put the app on the device this run booted, when the boot said it has not got it.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §Putting Expo Go on a simulator that has not got it
   * Only ever called for a boot whose {@link SmokeBootResult.installNeeded} is true, and only
   * after that boot: the device has to be up for `simctl install` to reach it.
   *
   * **Registers no cleanup, deliberately.** "Stop only what you started" is about resources this
   * run is *holding* — a dev server, a booted simulator. An installed app is not held, it is
   * given: uninstalling Expo Go on the way out would take away what the next run needs and make
   * it download 423 MB again.
   */
  installApp(deviceId: string): Promise<SmokeInstallResult>;
  /**
   * Whether this run has an app to put on that device before it can open anything.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §Putting Expo Go on a simulator that has not got it
   * True only when the app is one this run may install *and* the device has not got it. The policy
   * half lives with the caller, so this file stays a walk over phases rather than a second opinion
   * about which apps may be installed.
   *
   * Asked of the device this run settled on, however it got there — **not** only of one this run
   * booted. A simulator someone left running without Expo Go is the ordinary case, and the first
   * version of this phase missed it by hanging the question off the boot [observed, 2026-09-03].
   */
  installNeededOnDevice(deviceId: string, backend: DeviceBackend | null): Promise<boolean>;
  waitForBundlerReady(devServerUrl: string, timeoutMs: number): Promise<BundlerReadyResult>;
  checkEntryBundle(devServerUrl: string, timeoutMs: number): Promise<BundleCheckResult>;
  waitForAppConnection(devServerUrl: string, timeoutMs: number): Promise<AppConnectionResult>;
  /**
   * Look for a device without failing when there is none: no device is an answer.
   *
   * Answers the *backend* too, because the picture is taken through a different tool for each and
   * the phase that takes it must not guess. Null when nothing was found.
   * The dependencies retain successful choices and adopt devices from boot/session creation;
   * an unsuccessful lookup may be retried by a later phase.
   */
  probeDevice(): Promise<{
    deviceId: string | null;
    backend: DeviceBackend | null;
    reason: string | null;
  }>;
  /**
   * Open a route on the device, the way `navigate` does. Throws what `navigate` throws.
   *
   * The dev server is passed in rather than found again, and that is a fix rather than a tidy-up
   * [observed live — 2026-08-24]: `navigate` discovers its own dev server, so a run that had
   * settled on one in phase 1 went looking for it a second time in phase 4 and found nothing —
   * `Cannot build an Expo Go URL because the dev server URL is unknown`, exit 1, from a run whose
   * first three phases had all answered. A gate that talks to two dev servers is a gate whose
   * phases are about two different things.
   */
  openRoute(
    route: string,
    devServerUrl: string,
    /**
     * How long the open may wait for the app to register a debugger target.
     *
     * @ref llp/0005-runtime-loop-tools.rfc.md §Loading the app is not navigating it
     * Not decoration: `openRouteAsync`'s launcher-first ladder (F123) is **gated on this budget**,
     * because loading a development build means opening the launcher URL first and waiting for the
     * bundle it fetches. A run that passed none — which `smoke` did — handed a cold app the link
     * only a loaded app understands and landed on the launcher's own screen.
     */
    attachBudgetMs: number
  ): Promise<OpenRouteResult>;
  /**
   * Whether the app that answered is one this project can actually run.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §Expo Go is only a target for a project that fits in it
   * @ref llp/0005-runtime-loop-tools.rfc.md §The Expo Go on the device is not the Expo Go the SDK wants
   *
   * Three fields, because the findings are not the same weight and the two heavy ones do not have
   * the same answer. A `mismatch` is an app that cannot run this project, and the gate must not
   * report a pass on a reading taken through it. `kind` says which of the two it is — see
   * {@link SmokeAppMismatchKind}, and the reason it is carried rather than derived from the
   * sentence. A `note` is a finding worth printing that decides nothing, such as an Expo Go an
   * update behind on the same release line, which will usually run the app.
   *
   * All null is the ordinary answer, and so is all null when nothing could be decided: a check
   * that could not run must not become a refusal.
   */
  checkAppFitsProject(devServerUrl: string): Promise<SmokeAppFit>;
  /**
   * Why an app this run opened may never have attached, read off the **device** rather than the
   * dev server.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §The Expo Go on the device is not the Expo Go the SDK wants
   *
   * The one question {@link checkAppFitsProject} cannot answer, and the reason is in its argument:
   * it looks for an Expo Go among the dev server's debugger targets, and on this path there are
   * none — nothing attached, which is the whole problem. So the same question is asked of the
   * device.
   *
   * Found live, and it is the worst form of the gap the version check was written to close: an
   * emulator holding Expo Go 54.0.8, a project on SDK 57, and 119 seconds spent to report `no app
   * had attached when the budget ran out` — while the reason was on the device the entire time, and
   * the follow-ups went on to suggest opening it again [observed — emulator-5554, 2026-09-04].
   *
   * Null when nothing on the device explains it, which is the ordinary answer: a slow app, a first
   * bundle still building, a device that is busy. Never a guess.
   */
  explainSilentApp(
    deviceId: string | null,
    backend: DeviceBackend | null
  ): Promise<SmokeAppFit | null>;
  /**
   * Put an app that was already attached back on the bundle the dev server is serving.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §The app under test is the code on disk
   * `runtime:reload`'s rung 1 and its proofs, asked here through the same functions. Only rung 1:
   * the rungs above it stop the app and start it again, and a gate is not allowed to take the
   * caller's app away to answer a question about it.
   */
  reloadApp(devServerUrl: string, timeoutMs: number): Promise<SmokeReloadResult>;
  evaluate(devServerUrl: string): Promise<SmokeEvaluateResult>;
  collectErrors(devServerUrl: string, windowMs: number): Promise<SmokeErrorsResult>;
  captureScreenshot(deviceId: string, backend: DeviceBackend | null): Promise<ScreenshotResult>;
  /**
   * Wait until the dev server lists the same debugger targets twice, or the budget runs out.
   *
   * The picture is evidence, and a picture of a splash screen is evidence of nothing
   * [observed — friction run 6 (Android), 2026-08-24, `and-05-settled-after-smoke.png`: the run
   * opened the app itself and photographed it mid-load]. Nothing over this protocol says
   * "rendered", so what is waited for is the honest neighbouring fact — the app has stopped
   * re-registering, which is what a still-loading relaunch does.
   */
  waitForStableTargets(devServerUrl: string, timeoutMs: number): Promise<{ stable: boolean }>;
  /**
   * Say which phase is starting, before it starts.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §The gate says what it is doing while it does it
   * A dependency rather than a `Log` call, for the same reason every other side effect in this
   * file is one: the outcome table is tested against fakes, and a walk that printed for itself
   * would make those tests about prose. `silentProgress` is what they pass.
   */
  progress: SmokeProgress;
  /** The clock, so a test can pin the durations it reports. */
  now(): number;
}

/** Everything one run of the phases established, before it is formatted or exited with. */
export interface SmokeRun {
  outcome: SmokeOutcome;
  phases: SmokePhase[];
  devServerUrl: string;
  discovery: DevServerDiscovery | null;
  projectRootMatched: boolean | null;
  started: boolean;
  /** What this run found on the machine, what it started, and what it put back. */
  environment: SmokeEnvironmentJson;
  appsConnected: number | null;
  skippedApps: SkippedApp[];
  bundle: BundleCheckResult | null;
  route: string | null;
  routeCheck: RouteCheckJson | null;
  deviceId: string | null;
  deviceBackend: DeviceBackend | null;
  runtimeSupported: boolean | null;
  /**
   * Whether the app the later phases read was the code on disk.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §The app under test is the code on disk
   * Its default says the truth for a run that never reached the phase: nothing replaced the
   * session, because there was no session to replace.
   */
  reload: SmokeReloadJson;
  /**
   * Why the app that answered cannot run this project, or null when it can.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §Expo Go is only a target for a project that fits in it
   * Reported as a fact rather than only as the `app` phase's sentence, because the follow-ups and
   * the explanation both branch on it and neither may do that by matching English
   * (llp/0005 §One preflight for the runtime family, on `error.data`).
   */
  appMismatch: string | null;
  /**
   * Which kind of mismatch it is. Null exactly when {@link appMismatch} is.
   *
   * @see SmokeAppMismatchKind — the next action differs per kind, and the follow-ups pick it from
   * here rather than from the sentence.
   */
  appMismatchKind: SmokeAppMismatchKind | null;
  /**
   * The start phase ran a plan that **compiled**.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §It builds what the app needs, and says so first
   * Read by the follow-ups, which offer a different cheapest-next-step for a start that took
   * minutes than for one that took seconds.
   */
  buildAttempted: boolean;
  windowMs: number | null;
  errors: RuntimeErrorRecord[];
  screenshot: ScreenshotResult;
  durationMs: number;
}

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
  // recomputed afterwards because the caller waited for the cleanup too, and a run that reported
  // `4.2s` while spending eight seconds shutting a simulator down would be describing a moment
  // that had passed (llp/0021 §The rules).
  try {
    const run = await runPhasesAsync(deps, options, { startedAt, cleanups, environment });
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

/** One resource this run started, and the call that puts it back. */
export interface RegisteredCleanup {
  resource: SmokeResource;
  /** What it is, for a report written even when the release call answers nothing. */
  target: string | null;
  release(): Promise<SmokeReleaseResult>;
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

/** What {@link runSmokePhasesAsync} hands the phase walk, so the walk owns none of it. */
export interface SmokeRunContext {
  startedAt: number;
  /** Appended to as resources are started, and read back by the cleanup. */
  cleanups: RegisteredCleanup[];
  /** Filled in as the run learns what it found and what it started. */
  environment: SmokeEnvironmentJson;
}

/** The phases themselves, in order. Everything they start is registered with the context first. */
async function runPhasesAsync(
  deps: SmokeDeps,
  options: SmokeOptions,
  ctx: SmokeRunContext
): Promise<SmokeRun> {
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
