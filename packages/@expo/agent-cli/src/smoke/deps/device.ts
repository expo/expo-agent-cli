import {
  acquireDeviceAsync,
  acquireLine,
  deviceIdOf,
  deviceNameOf,
  devicesDisabled,
  releaseWorktreeDevicesAsync,
} from '../../deviceBinding';
import { checkExpoGoVersionAsync } from '../../device/expoGoVersion';
import { hasAppOnDeviceAsync } from '../../device/hasApp';
import { installDevBuildAsync } from '../../device/installDevBuild';
import { installExpoGoAsync } from '../../device/installExpoGo';
import { captureScreenshotAsync, defaultScreenshotPath } from '../../device/screenshot';
import * as Log from '../../log';
import { navigateDeviceOf, type DeviceBackend } from '../../navigate/device';
import { readSdkVersionAsync } from '../../project/nodeModules';
import type { SmokeDeps } from '../phases';
import type { SmokeOptions } from '../resolveOptions';
import { choiceOf, whatAndHow } from './reasons';
import type { SmokeDepsShared } from './shared';

/**
 * Whether one local device has one app, with each platform's own reader.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §Android
 *
 * **Three answers, not two.** `null` is "this could not be looked up", and it is separate from
 * `false` because the callers *act* on `false`: one downloads a few hundred megabytes and another
 * runs a native build. A machine with no CoreSimulator tree — the e2e tier's Linux runner, a udid
 * nothing here has — read as "not installed" and reached for a real download until this
 * distinction existed [observed — tier0-linux, 2026-09-03].
 *
 * One function because there are three callers: the install decision, the explanation for a
 * device that answered nothing, and the check that judges a native build by its result rather than
 * its exit code. The switch itself lives in `src/device/hasApp.ts`, because the plan engine asks the
 * same question (llp/0004 §A current build is not an installed app).
 */
// @ref ./device §hasAppOnDeviceAsync

export function readBoundDevice(s: SmokeDepsShared): ReturnType<SmokeDeps['readBoundDevice']> {
  const binding = s.ownBinding();
  return binding && { id: deviceIdOf(binding.device), name: deviceNameOf(binding.device) };
}

// Local only, and that is not a gap: `--eas` names a session somebody else started and pays
// for, and the phase that calls this never runs for one.
//
// @ref llp/0035-one-device-per-worktree.rfc.md §Lifecycle smoke — a child-owned binding is released by
// dev:stop; a binding acquired with a reused server is released by this hook.
export async function releaseDevice(
  s: SmokeDepsShared,
  projectRoot: string,
  options: SmokeOptions
): ReturnType<SmokeDeps['releaseDevice']> {
  if (!s.bootBinding) return { ok: true, target: null, reason: null };
  const devices = await releaseWorktreeDevicesAsync(projectRoot, {
    platform: options.platform,
    expected: s.bootBinding,
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

export async function bootDevice(
  s: SmokeDepsShared,
  projectRoot: string,
  options: SmokeOptions
): ReturnType<SmokeDeps['bootDevice']> {
  s.setDevice(null);
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
    s.setDevice(navigateDeviceOf(acquired.device));
    s.bootBinding = acquired.binding;
    Log.progress(acquireLine(acquired));
    return {
      ok: true,
      deviceId: deviceIdOf(acquired.device),
      backend: platform === 'ios' ? 'local-ios' : 'local-android',
      choice: choiceOf(acquired.device),
      installNeeded: acquired.action === 'created' || acquired.action === 'spawned',
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

// @ref llp/0005-runtime-loop-tools.rfc.md §Putting Expo Go on a simulator that has not got it
//
// Both halves of the question, so the phase runner carries no policy: is this an app this run
// may install, and has the device not got it. The first is the plan's `expo-go` rule, which
// already means "the project fits in Expo Go and nothing overrode it to a development build".
// The second is the same disk read the device choice makes (`installedApps.ts`).
export async function installNeededOnDevice(
  s: SmokeDepsShared,
  projectRoot: string,
  options: SmokeOptions,
  deviceId: string,
  backend: DeviceBackend | null
): ReturnType<SmokeDeps['installNeededOnDevice']> {
  const target = await s.targetAsync();

  // @ref llp/0005-runtime-loop-tools.rfc.md §An app that cannot be named still has to be installed
  //
  // **No app id is not "no app".** For a native build it is the ordinary state of a project
  // that has never been prebuilt for this platform: `android.package` is undeclared and there
  // is no `android/app/build.gradle` yet, because `expo prebuild` is the thing that writes
  // both. Skipping the install there is the bug that outlived two attempts at fixing it — the
  // emulator booted, nothing was installed, and the deep link was refused, three runs in a row
  // [observed — Kudo, 2026-09-04].
  //
  // The id is only needed to ask "is it already there". `expo run:<platform>` needs none: it
  // resolves the package itself, from the config it is about to write. So a run that cannot see
  // whether the app is installed installs it — and after that first build the package *is*
  // declared, so every later run resolves it and checks properly. One build, then normal.
  //
  // Expo Go is excluded because its ids are constants: an Expo Go run that cannot name its app
  // has a plan this could not read, and downloading 423 MB on that basis would be a guess.
  if (target.appId == null) {
    return target.installWithKind === 'native-build';
  }
  // @ref ./device §hasAppOnDeviceAsync. Local devices only — a cloud session's device is
  // not this machine's, and there is nothing this CLI can install on somebody else's session
  // (llp/0005 §Cloud simulator) — and `null` for a lookup that did not happen, which is never
  // a licence to install.
  const has = await hasAppOnDeviceAsync(deviceId, backend, target.appId);
  if (has == null) {
    return false;
  }
  if (!has) {
    return true;
  }
  // @ref llp/0005-runtime-loop-tools.rfc.md §The Expo Go on the device is not the Expo Go the SDK wants
  //
  // Installed is not the same as right, and this is the half `@expo/cli` gets right and a first
  // cut here did not: `ExpoGoInstaller` compares with `semver.eq` and, when it cannot prompt,
  // installs the recommended release rather than reporting the difference — "better to have the
  // correct version than not have Expo Go work at all". An agent loop is exactly the caller
  // that cannot be prompted.
  //
  // `unknown` installs nothing: a machine that is offline, or one whose version would not
  // read, has shown no reason to spend a few hundred megabytes.
  const version = await checkExpoGoVersionAsync(
    deviceId,
    options.platform,
    await readSdkVersionAsync(projectRoot)
  );
  return version.verdict === 'mismatch';
}

// `expo-go download` for the binary and `simctl install` for the device, both as subprocesses.
// Only reached for a boot that came up without the app, and only when the plan's rule is Expo
// Go — so the SDK version is the one the project reports, and the release is the one that SDK
// ships rather than whatever is newest.
// @ref llp/0005-runtime-loop-tools.rfc.md §The gate installs the app, whichever app it is
//
// Two installs, because they put two different apps on the device: a published binary to
// download, or this project's own artefact to compile. The plan decides which
// (@ref ./target §SmokeTarget.installWithKind), so this reads the answer rather than
// forming a third opinion about which app the run is even about.
export async function installApp(
  s: SmokeDepsShared,
  projectRoot: string,
  options: SmokeOptions,
  deviceId: string
): ReturnType<SmokeDeps['installApp']> {
  const target = await s.targetAsync();
  if (target.installWithKind === 'expo-go') {
    return await installExpoGoAsync(
      deviceId,
      options.platform,
      await readSdkVersionAsync(projectRoot)
    );
  }
  // @ref llp/0005 §An app that cannot be named still has to be installed — the build resolves
  // the package itself, so this works with `target.appId` null, which is exactly the run that
  // most needs it.
  const built = await installDevBuildAsync(projectRoot, options.platform, deviceId, {
    // @ref src/device/installDevBuild §verifyInstalledAsync — the device decides, because
    // `expo run:ios` activates the Simulator window through AppleScript *after* it installs and
    // throws there on a Mac with no Automation grant. The same read the install decision made.
    verifyInstalledAsync: async () =>
      target.appId == null
        ? null
        : await hasAppOnDeviceAsync(
            deviceId,
            options.platform === 'android' ? 'local-android' : 'local-ios',
            target.appId
          ),
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
export async function probeDevice(s: SmokeDepsShared): ReturnType<SmokeDeps['probeDevice']> {
  const { device, reason } = await s.deviceAsync();
  return {
    deviceId: device?.deviceId ?? null,
    backend: device?.backend ?? null,
    reason: reason == null ? null : whatAndHow(reason),
  };
}

// @ref llp/0005-runtime-loop-tools.rfc.md §The Expo Go on the device is not the Expo Go the SDK wants
// @ref ../phases §SmokeDeps.explainSilentApp
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
export async function explainSilentApp(
  s: SmokeDepsShared,
  projectRoot: string,
  options: SmokeOptions,
  deviceId: string | null,
  backend: DeviceBackend | null
): ReturnType<SmokeDeps['explainSilentApp']> {
  if (deviceId == null || (backend !== 'local-ios' && backend !== 'local-android')) {
    return null;
  }
  const target = await s.targetAsync();

  // @ref llp/0005-runtime-loop-tools.rfc.md §A refused link is a device without the app
  //
  // Asked first, and of **every** app rather than only of Expo Go: the commonest reason a
  // device answers nothing is that it has not got the app, and the commonest way that happens
  // is a development build on a simulator it was not built for. The link is then refused with
  // `115` and the report used to say only that the device refused it, which reads as a fault in
  // the device [observed — Kudo, local run, 2026-09-04].
  if (target.appId != null) {
    // `null` is "could not look", which explains nothing (@ref ./device §hasAppOnDeviceAsync).
    const has = await hasAppOnDeviceAsync(deviceId, backend, target.appId);
    if (has === false) {
      return {
        mismatch: [
          `the app this project runs (${target.appLabel ?? target.appId}) is not installed on ${deviceId}, so nothing there handles its link`,
          // @ref llp/0005-runtime-loop-tools.rfc.md §The gate installs the app, whichever app
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
  const version = await checkExpoGoVersionAsync(
    deviceId,
    options.platform,
    await readSdkVersionAsync(projectRoot)
  );
  // `unknown` explains nothing, and saying "the version could not be checked" beside a wait
  // that expired would add a sentence without adding a fact.
  if (version.verdict !== 'mismatch') {
    return null;
  }
  return {
    mismatch: [
      version.reason,
      `— and an Expo Go built from another SDK takes the link, fails to load a bundle it cannot run, and registers no debugger target, which is what this wait was waiting for.`,
      options.bootstrap
        ? `This run was allowed to install the right one and did not manage to.`
        : `--no-start told this run to change nothing; a run without it installs the right one.`,
    ].join(' '),
    kind: 'expo-go-version' as const,
    note: null,
  };
}

export async function captureScreenshot(
  s: SmokeDepsShared,
  projectRoot: string,
  options: SmokeOptions,
  deviceId: string,
  backend: DeviceBackend | null
): ReturnType<SmokeDeps['captureScreenshot']> {
  return captureScreenshotAsync({
    platform: options.platform,
    deviceId,
    backend: backend ?? undefined,
    projectRoot,
    appId: backend === 'cloud' ? ((await s.targetAsync()).appId ?? undefined) : undefined,
    filePath: options.screenshotPath ?? defaultScreenshotPath(projectRoot),
  });
}

export function buildDeviceDeps(
  s: SmokeDepsShared,
  projectRoot: string,
  options: SmokeOptions
): Pick<
  SmokeDeps,
  | 'readBoundDevice'
  | 'releaseDevice'
  | 'bootDevice'
  | 'installNeededOnDevice'
  | 'installApp'
  | 'probeDevice'
  | 'explainSilentApp'
  | 'captureScreenshot'
> {
  return {
    readBoundDevice: () => readBoundDevice(s),
    releaseDevice: (...args) => releaseDevice(s, projectRoot, options, ...args),
    bootDevice: (...args) => bootDevice(s, projectRoot, options, ...args),
    installNeededOnDevice: (...args) => installNeededOnDevice(s, projectRoot, options, ...args),
    installApp: (...args) => installApp(s, projectRoot, options, ...args),
    probeDevice: () => probeDevice(s),
    explainSilentApp: (...args) => explainSilentApp(s, projectRoot, options, ...args),
    captureScreenshot: (...args) => captureScreenshot(s, projectRoot, options, ...args),
  };
}
