import path from 'path';

import type { EnsureEasSessionReport } from '../../dev/easSession';
import {
  acquireDeviceAsync,
  acquireLine,
  deviceIdOf,
  deviceNameOf,
  devicesDisabled,
  localBackendOf,
  releaseWorktreeDevicesAsync,
  type Binding,
  type BoundDevice,
} from '../../deviceBinding';
import { releaseStartedSessionAsync } from '../../deviceBinding/cloudRelease';
import { checkExpoGoVersionAsync } from '../../device/expoGoVersion';
import { hasAppOnDeviceAsync } from '../../device/hasApp';
import { installDevBuildAsync } from '../../device/installDevBuild';
import { installExpoGoAsync } from '../../device/installExpoGo';
import { captureScreenshotAsync, defaultScreenshotPath } from '../../device/screenshot';
import * as Log from '../../log';
import { navigateDeviceOf, type DeviceBackend } from '../../navigate/device';
import { PROGRAM_PREFIX } from '../../programName';
import { readSdkVersionAsync } from '../../project/nodeModules';
import { EAS_SIMULATOR_PROFILE } from '../../toolchain/runsOn';
import type { SmokeAppFit, SmokeDeps, SmokeSessionResult } from '../contract';
import { decideInstall, type InstallFacts } from './decideInstall';
import { whatAndHow } from './reasons';
import type { SmokeDepsContext } from './shared';

/** The device this run acquired, for the release phase to check it is still the one bound. */
interface DeviceState {
  bootBinding: Binding | undefined;
}

// @ref llp/0027-everything-on-eas.rfc.md §smoke
// The EAS device's boot-and-install: the session in progress on this platform, or one started
// with the app named. A development build needs a finished simulator build of this fingerprint
// on EAS; the gate never compiles one — `dev --eas` does, and is named.
async function ensureEasSession(
  ctx: SmokeDepsContext,
  devServerUrl: string
): ReturnType<SmokeDeps['ensureEasSession']> {
  const { projectRoot, options } = ctx;
  ctx.setDevice(null);
  const { ensureEasSessionAsync } =
    require('../../dev/easSession') as typeof import('../../dev/easSession');
  const target = await ctx.targetAsync();
  const result = await ensureEasSessionAsync(projectRoot, {
    platform: options.platform,
    expoGo: target.installWithKind === 'expo-go',
    devServerUrl,
    // A new session looks up the build of this fingerprint, and is never started without one.
    buildId: null,
    sessionName: `${path.basename(projectRoot)} — agent-cli smoke`,
    keepSession: false,
    noBuildReason: `no EAS Simulator session is up, and EAS has no finished "${EAS_SIMULATOR_PROFILE}" build of this project's ${options.platform} fingerprint to start one with — "${PROGRAM_PREFIX} dev --${options.platform} --eas" builds it and starts the session; this gate compiles nothing`,
  });
  if (result.ok && result.sessionId) {
    ctx.setDevice({ backend: 'cloud', platform: options.platform, deviceId: result.sessionId });
  }
  return smokeSessionResult(result);
}

async function stopEasSession(
  ctx: SmokeDepsContext,
  sessionId: string
): ReturnType<SmokeDeps['stopEasSession']> {
  const { projectRoot } = ctx;
  const release = await releaseStartedSessionAsync(projectRoot, sessionId, 'smoke');
  return release.outcome === 'stopped'
    ? { ok: true, target: sessionId, reason: null }
    : { ok: false, target: sessionId, reason: release.reason };
}

function readBoundDevice(ctx: SmokeDepsContext): ReturnType<SmokeDeps['readBoundDevice']> {
  const binding = ctx.ownBinding();
  return binding && { id: deviceIdOf(binding.device), name: deviceNameOf(binding.device) };
}

// Local only, and that is not a gap: `--eas` names a session somebody else started and pays
// for, and the phase that calls this never runs for one.
//
// @ref llp/0035-one-device-per-worktree.rfc.md §Lifecycle smoke — a child-owned binding is released by
// dev:stop; a binding acquired with a reused server is released by this hook.
async function releaseDevice(
  ctx: SmokeDepsContext,
  bound: DeviceState
): ReturnType<SmokeDeps['releaseDevice']> {
  const { projectRoot, options } = ctx;
  if (!bound.bootBinding) return { ok: true, target: null, reason: null };
  const devices = await releaseWorktreeDevicesAsync(projectRoot, {
    platform: options.platform,
    expected: bound.bootBinding,
  });
  if (devices.length === 0) {
    return {
      ok: false,
      target: null,
      reason:
        "this worktree's binding no longer names the device this run bound, so this run released nothing",
      devices,
    };
  }
  return {
    ok: devices.every((device) => device.released),
    target: devices.map((device) => device.id).join(', ') || null,
    reason: devices.find((device) => !device.released)?.reason ?? null,
    devices,
  };
}

async function bootDevice(
  ctx: SmokeDepsContext,
  bound: DeviceState
): ReturnType<SmokeDeps['bootDevice']> {
  const { projectRoot, options } = ctx;
  ctx.setDevice(null);
  const platform = options.platform;
  if (devicesDisabled()) {
    return {
      ok: false,
      deviceId: null,
      backend: null,
      choice: null,
      reason: `devices are off for this run (AGENT_CLI_NO_DEVICE), so no ${platform} device was bound`,
    };
  }
  try {
    const acquired = await acquireDeviceAsync(projectRoot, platform);
    ctx.setDevice(navigateDeviceOf(acquired.device));
    bound.bootBinding = acquired.binding;
    Log.progress(acquireLine(acquired));
    return {
      ok: true,
      deviceId: deviceIdOf(acquired.device),
      backend: localBackendOf(platform),
      choice: choiceOf(acquired.device),
      reason: null,
      bound: { name: deviceNameOf(acquired.device), action: acquired.action },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      deviceId: null,
      backend: null,
      choice: null,
      reason: error instanceof Error ? whatAndHow(error.message) : String(error),
    };
  }
}

// @ref llp/0036-smoke-gate.rfc.md §The gate installs the app, whichever app it is
//
// Gathers the device reads the install table asks for, one at a time and only when a row asks, and
// leaves the decision to `decideInstall`. `null` from a read is "could not look", never a licence
// to install (@ref src/device/hasApp §hasAppOnDeviceAsync).
async function installNeededOnDevice(
  ctx: SmokeDepsContext,
  deviceId: string,
  backend: DeviceBackend | null,
  createdByBoot: boolean
): ReturnType<SmokeDeps['installNeededOnDevice']> {
  const target = await ctx.targetAsync();
  const facts: InstallFacts = {
    deviceId,
    createdByBoot,
    backend,
    kind: target.installWithKind,
    appId: target.appId,
  };
  for (;;) {
    const decision = decideInstall(facts);
    if ('install' in decision) return decision.install;
    if (decision.ask === 'hasApp') {
      facts.hasApp = await hasAppOnDeviceAsync(decision.deviceId, backend, decision.appId);
    } else {
      facts.expoGoVerdict = (await checkExpoGoVersion(ctx, decision.deviceId)).verdict;
    }
  }
}

// Runs after `installNeededOnDevice` answered yes. For Expo Go: `expo-go download` for the binary
// and `simctl install` for the device, both as subprocesses, at the SDK version the project
// reports. For a native build: this project's own artefact.
// @ref llp/0036-smoke-gate.rfc.md §The gate installs the app, whichever app it is
//
// Two installs, because they put two different apps on the device: a published binary to
// download, or this project's own artefact to compile. The plan decides which
// (@ref ./target §SmokeTarget.installWithKind), so this reads the answer rather than
// forming a third opinion about which app the run is even about.
async function installApp(
  ctx: SmokeDepsContext,
  deviceId: string
): ReturnType<SmokeDeps['installApp']> {
  const { projectRoot, options } = ctx;
  const target = await ctx.targetAsync();
  if (target.installWithKind == null) {
    return {
      ok: false,
      version: null,
      replaced: null,
      reason: 'the plan could not be read, so there is no app to install',
    };
  }
  if (target.installWithKind === 'expo-go') {
    return await installExpoGoAsync(
      deviceId,
      options.platform,
      await readSdkVersionAsync(projectRoot)
    );
  }
  // @ref llp/0036 §An app that cannot be named still has to be installed — the build resolves
  // the package itself, so this works with `target.appId` null, which is exactly the run that
  // most needs it.
  const built = await installDevBuildAsync(projectRoot, options.platform, deviceId, {
    // @ref src/device/installDevBuild §verifyInstalledAsync — the device decides, because
    // `expo run:ios` activates the Simulator window through AppleScript *after* it installs and
    // throws there on a Mac with no Automation grant. The same read the install decision made.
    verifyInstalledAsync: async () =>
      target.appId == null
        ? null
        : await hasAppOnDeviceAsync(deviceId, localBackendOf(options.platform), target.appId),
  });
  // The shapes differ in what they can report: a download knows which release it fetched and
  // what it replaced, and a compile knows neither — the version of a development build is the
  // project's own business, and `expo run:*` does not say what it overwrote.
  return {
    ok: built.ok,
    version: null,
    replaced: null,
    reason: built.reason,
  };
}

// The same ladder `navigate` walks, through the same function — local device first, then this
// project's EAS Simulator session (llp/0005 §Cloud simulator). A second resolution
// here would be a second place for the order to drift, and a gate whose `route` phase and
// `screenshot` phase disagreed about the device would photograph one to answer for the other.
//
// It throws where the probes it replaced returned; caught, because no device is an answer this
// gate reports rather than fails on. The answer keeps the refusal's How line: with no device
// bound, that line is the `dev` command that binds one, and a skip row without it left a
// reader with a booted simulator and no way forward [observed — issue #171].
async function probeDevice(ctx: SmokeDepsContext): ReturnType<SmokeDeps['probeDevice']> {
  const { device, reason } = await ctx.deviceAsync();
  return {
    deviceId: device?.deviceId ?? null,
    backend: device?.backend ?? null,
    reason: reason == null ? null : whatAndHow(reason),
  };
}

// @ref llp/0036-smoke-gate.rfc.md §The Expo Go on the device is not the Expo Go the SDK wants
// @ref ../contract §SmokeDeps.explainSilentApp
//
// The same version question as above, asked of the **device** instead of the dev server's
// target list — because on this path that list is empty, and its emptiness is the thing being
// explained. An Expo Go from another SDK takes the deep link, fails to load a bundle its
// runtime cannot run, and registers no debugger target at all; the run then waits out its
// budget and reports the symptom [observed — 119 s, 2026-09-04].
//
// Only for a local device this CLI has a version reader for, and only when the app this run is
// about is Expo Go: a development build that did not attach is this project's own artefact, and
// there is no release of it for this to have an opinion about.
async function explainSilentApp(
  ctx: SmokeDepsContext,
  deviceId: string | null,
  backend: DeviceBackend | null
): ReturnType<SmokeDeps['explainSilentApp']> {
  if (deviceId == null || (backend !== 'local-ios' && backend !== 'local-android')) {
    return null;
  }
  const target = await ctx.targetAsync();

  // @ref llp/0036-smoke-gate.rfc.md §A refused link is a device without the app
  //
  // Asked first, and of **every** app rather than only of Expo Go: the commonest reason a
  // device answers nothing is that it has not got the app, and the commonest way that happens
  // is a development build on a simulator it was not built for. The link is then refused with
  // `115` and the report used to say only that the device refused it, which reads as a fault in
  // the device [observed — Kudo, local run, 2026-09-04].
  if (target.appId != null) {
    // `null` is "could not look", which explains nothing (@ref src/device/hasApp §hasAppOnDeviceAsync).
    const has = await hasAppOnDeviceAsync(deviceId, backend, target.appId);
    if (has === false) {
      return {
        mismatch: [
          `the app this project runs (${target.appLabel ?? target.appId}) is not installed on ${deviceId}, so nothing there handles its link`,
          // @ref llp/0036-smoke-gate.rfc.md §The gate installs the app, whichever app
          // it is. One sentence for both kinds now, because a run allowed to bring its own
          // environment installs both — a download for Expo Go, `expo run:<platform>` for a
          // development build. Anything that reaches here was told to change nothing, and the
          // flag that told it is the whole of the answer.
          `a run without --no-start installs it.`,
        ].join(' — '),
        kind: 'app-not-installed' as const,
        note: null,
      };
    }
  }

  // Everything below is about Expo Go's *version*, so a development build stops here: it is
  // this project's own app, and there is no release of it for this to have an opinion about.
  if (target.installWithKind !== 'expo-go') {
    return null;
  }
  // `unknown` explains nothing, and saying "the version could not be checked" beside a wait
  // that expired would add a sentence without adding a fact.
  return await expoGoVersionMismatch(
    ctx,
    deviceId,
    `— and an Expo Go built from another SDK takes the link, fails to load a bundle it cannot run, and registers no debugger target, which is what this wait was waiting for.`
  );
}

async function captureScreenshot(
  ctx: SmokeDepsContext,
  deviceId: string,
  backend: DeviceBackend | null
): ReturnType<SmokeDeps['captureScreenshot']> {
  const { projectRoot, options } = ctx;
  return captureScreenshotAsync({
    platform: options.platform,
    deviceId,
    backend: backend ?? undefined,
    projectRoot,
    appId: backend === 'cloud' ? ((await ctx.targetAsync()).appId ?? undefined) : undefined,
    filePath: options.screenshotPath ?? defaultScreenshotPath(projectRoot),
  });
}

/** The boot line's "because": a spawned instance's AVD, and nothing for an explicit serial. */
function choiceOf(device: BoundDevice): string | null {
  if (device.backend !== 'local-android') {
    return deviceNameOf(device);
  }
  return device.origin.kind === 'spawned' ? device.origin.avd : null;
}

/** The phase result of a session start; a refusal gives its What and How, not only its first line. */
export function smokeSessionResult(
  result: Pick<EnsureEasSessionReport, 'ok' | 'sessionId' | 'started' | 'reason' | 'refusal'>
): SmokeSessionResult {
  return {
    ok: result.ok,
    sessionId: result.sessionId,
    started: result.started,
    reason: result.refusal ? whatAndHow(result.refusal.message) : result.reason,
  };
}

/** Whether the Expo Go on the device is built from the release line this project's SDK ships. */
async function checkExpoGoVersion(ctx: SmokeDepsContext, deviceId: string) {
  return await checkExpoGoVersionAsync(
    deviceId,
    ctx.options.platform,
    await readSdkVersionAsync(ctx.projectRoot)
  );
}

/**
 * The `expo-go-version` finding for a device whose Expo Go is built from another SDK, or null.
 * `unknown` is null: a version that could not be read says nothing. `lead` is why that matters here.
 */
export async function expoGoVersionMismatch(
  ctx: SmokeDepsContext,
  deviceId: string,
  lead: string
): Promise<SmokeAppFit | null> {
  const version = await checkExpoGoVersion(ctx, deviceId);
  if (version.verdict !== 'mismatch') {
    return null;
  }
  return {
    mismatch: [
      version.reason,
      lead,
      ctx.options.bootstrap
        ? `This run was allowed to install the right one and did not manage to.`
        : `--no-start told this run to change nothing; a run without it installs the right one.`,
    ].join(' '),
    kind: 'expo-go-version' as const,
    note: null,
  };
}

/** The device deps of one run. `bound` is the device this run acquired, for the release phase. */
export function createDeviceDeps(ctx: SmokeDepsContext) {
  const bound: DeviceState = { bootBinding: undefined };
  return {
    ensureEasSession: (devServerUrl) => ensureEasSession(ctx, devServerUrl),
    stopEasSession: (sessionId) => stopEasSession(ctx, sessionId),
    readBoundDevice: () => readBoundDevice(ctx),
    releaseDevice: () => releaseDevice(ctx, bound),
    bootDevice: () => bootDevice(ctx, bound),
    installNeededOnDevice: (deviceId, backend, createdByBoot) =>
      installNeededOnDevice(ctx, deviceId, backend, createdByBoot),
    installApp: (deviceId) => installApp(ctx, deviceId),
    probeDevice: () => probeDevice(ctx),
    explainSilentApp: (deviceId, backend) => explainSilentApp(ctx, deviceId, backend),
    captureScreenshot: (deviceId, backend) => captureScreenshot(ctx, deviceId, backend),
  } satisfies Partial<SmokeDeps>;
}
