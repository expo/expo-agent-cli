// @ref llp/0005-runtime-loop-tools.rfc.md §Putting Expo Go on a simulator that has not got it
// @ref llp/0001-agentic-cli-on-expo-cli.rfc.md — constraint 5, on subprocesses
//
// The gate used to refuse a machine with no Expo Go and name `npx expo start --ios`. That is a
// correct instruction and a dead end for the caller this CLI is for: an agent cannot take it
// without leaving its loop, and the loop is the thing being served. So the missing app is
// installed [confirmed, Kudo, 2026-09-03].
//
// Two subprocesses, and neither is `@expo/cli`'s. `expo-go download <platform> <sdk> --json`
// fetches the release and extracts it, answering `{"path":…}` — for both platforms, with the same
// contract [observed, 2026-09-03: an `.app` on iOS and a 186 MB `.apk` on Android]. The second is
// the platform's own installer, and it is the only thing that differs
// (@ref ./installExpoGo §putOnDeviceAsync). `@expo/cli` does this in `ExpoGoInstaller` via
// `downloadExpoGoAsync`, which is the internal llp/0001 constraint 5 forbids importing.
//
// **The device has to be running first**, on both. `simctl install` on a shut simulator answers
// `Unable to lookup in current state: Shutdown` (domain `com.apple.CoreSimulator.SimError`, code
// 405) [observed, 2026-09-03], and `adb install` needs a device `adb` lists at all — so the boot
// comes before this and not after it.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { spawnCaptureAsync } from '../utils/spawnCapture';
import { resolveAdb, type AdbResolution } from './adb';
import { readInstalledExpoGoVersionAndroidAsync } from './androidApps';
import { expoGoVersionFromUrl, readInstalledExpoGoVersionAsync } from './expoGoVersion';

/** Expo Go's Android application id — a lower-case `e`, where the iOS bundle id has a capital. */
const ANDROID_EXPO_GO_APP_ID = 'host.exp.exponent';

/**
 * How long the download gets.
 *
 * The extracted bundle is ~423 MB [observed — SDK 57, 2026-09-03], so this is a real transfer and
 * not a metadata lookup. Generous, because the cost of a bound that is too short is a run that
 * reports a failed install for a download that was going fine — and because this is paid once per
 * simulator rather than once per run.
 */
const DOWNLOAD_TIMEOUT_MS = 300_000;

/** How long `simctl install` gets to copy an unpacked bundle onto a booted simulator. */
const INSTALL_TIMEOUT_MS = 120_000;

/** What putting Expo Go on a device amounted to. Never throws: a failed install is a result. */
export interface InstallExpoGoResult {
  ok: boolean;
  /** The version that was installed, when one was. */
  version: string | null;
  /**
   * The version that was on the device before, when this install replaced one.
   *
   * Null for a device that had no Expo Go at all. Reported because the two are different things to
   * do to somebody's machine, and a report that called them both "installed" would leave a reader
   * unable to tell an addition from a replacement (llp/0021 §The rules).
   */
  replaced: string | null;
  /** Why it was not. Null exactly when {@link ok} is true. */
  reason: string | null;
}

export interface InstallExpoGoOptions {
  spawn?: typeof spawnCaptureAsync;
  /**
   * Which `adb` to install through, for an Android device.
   *
   * Injected so the argv a test asserts on is `adb …` rather than this machine's absolute SDK path,
   * and resolved the same way every other Android call in this CLI resolves it (@ref ./adb).
   */
  adb?: AdbResolution;
  /** Where to download to. Injected for the tests, and a temporary directory otherwise. */
  tempDirAsync?: () => Promise<string>;
  /** How the download is removed afterwards. Injected for the tests. */
  cleanupAsync?: (dir: string) => Promise<void>;
}

/** A directory of this run's own, under the OS temp dir. */
async function makeTempDirAsync(): Promise<string> {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-cli-expo-go-'));
}

/** Remove it, and never fail the install over the removal. */
async function removeDirAsync(dir: string): Promise<void> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch {
    // A download left behind is untidy; an install reported as failed because the cleanup did not
    // work would be wrong. The app is on the device either way.
  }
}

/**
 * Expo Go's own URL schemes, which are the ones a deep link into it uses.
 *
 * `exps` is the TLS form. Both are approved because which one a link uses is the dev server's
 * business rather than this function's.
 */
const EXPO_GO_SCHEMES = ['exp', 'exps'];

/** The bundle id every Expo Go install has. */
const EXPO_GO_APP_ID = 'host.exp.Exponent';

/**
 * Tell the simulator that Expo Go may open its own links, so nothing has to be tapped.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §Putting Expo Go on a simulator that has not got it
 *
 * The install is not the last obstacle. A freshly installed app has no approved URL schemes, so
 * `simctl openurl exp://…` puts up an `Open in "Expo Go"?` alert and waits — and in the loop this
 * command exists for there is nobody to press Open. The run then reports, correctly and uselessly,
 * that no app attached inside its budget [observed — a fresh iOS 26.5 simulator, 2026-09-03: the
 * install succeeded, the link was opened, and the 120 s attach wait expired against that dialog].
 *
 * `@expo/cli` solves it by writing the scheme-approval plist directly, with a bplist library
 * (`updateSimulatorLinkingPermissionsAsync`). The same key written **through the simulator's own
 * `defaults`** needs no library and no plist parsing, and it is the version that works on a device
 * that is already booted: writing the file from outside is ignored, because the running preferences
 * daemon has already read it [both observed, 2026-09-03].
 *
 * Failure is not the install's failure. Expo Go is on the device either way, and the worst case is
 * the dialog or the sheet this exists to remove — so this reports nothing and the install stands.
 */
async function approveSchemesAsync(
  deviceId: string,
  spawn: typeof spawnCaptureAsync
): Promise<void> {
  /** One preference, written inside the simulator so a booted one picks it up. */
  const writeAsync = (domain: string, key: string, value: string[]) =>
    spawn('xcrun', ['simctl', 'spawn', deviceId, 'defaults', 'write', domain, key, ...value], {
      timeoutMs: APPROVE_TIMEOUT_MS,
    });

  for (const scheme of EXPO_GO_SCHEMES) {
    await writeAsync(
      'com.apple.launchservices.schemeapproval',
      // The key CoreSimulator reads. Its `-->` is part of the key rather than a path separator,
      // which is why this goes through `defaults` and not `plutil -replace`: a plutil keypath is
      // dot-separated and this key is full of dots.
      `com.apple.CoreSimulator.CoreSimulatorBridge-->${scheme}`,
      ['-string', EXPO_GO_APP_ID]
    );
  }

  // The second obstacle, and the same shape as the first. A first-ever Expo Go launch puts its
  // developer-menu onboarding sheet over the app, so the link works, the runtime attaches, the
  // window reads — and the screenshot is a picture of the sheet [observed, 2026-09-03]. llp/0005
  // §The smoke gate calls the picture evidence, and a picture of an onboarding sheet is evidence of
  // nothing, exactly as a splash screen is.
  //
  // The key is `expo-dev-menu`'s own, read from this monorepo rather than guessed
  // (`packages/expo-dev-menu/ios/Modules/DevMenuPreferences.swift` §isOnboardingFinishedKey), and
  // it is written only for an Expo Go **this run just installed** — never for one the caller
  // already had, whose preferences are theirs.
  await writeAsync(EXPO_GO_APP_ID, 'EXDevMenuIsOnboardingFinished', ['-bool', 'true']);
}

/** How long one preference write gets. It writes one key inside a booted simulator. */
const APPROVE_TIMEOUT_MS = 15_000;

/** The first line of a message, for a reason that has to fit on one. */
function firstLine(text: string): string {
  return text.split('\n')[0]!.trim();
}

/**
 * The version of the Expo Go already on this device, for the report's sake.
 *
 * @ref ./expoGoVersion §readInstalledVersionAsync — the same pair of device tools, asked here for a
 * different purpose: not "is it the right one" but "was there one at all", so an addition and a
 * replacement are told apart in the report (llp/0021 §The rules).
 */
async function readInstalledVersionAsync(
  deviceId: string,
  platform: 'ios' | 'android'
): Promise<string | null> {
  return platform === 'android'
    ? await readInstalledExpoGoVersionAndroidAsync(deviceId, ANDROID_EXPO_GO_APP_ID)
    : await readInstalledExpoGoVersionAsync(deviceId);
}

/**
 * Put a downloaded Expo Go onto a **running** device, with that platform's own tool.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §Android
 *
 * Two tools, and one thing worth saying about each argv:
 *
 * - iOS: `xcrun simctl install <udid> <path>`, on a simulator that is already booted.
 * - Android: `adb -s <serial> install -r -d <apk>`. `-r` is the reinstall that keeps the app's data,
 *   which is what makes replacing a version an install rather than an uninstall and an install.
 *   **`-d` is not optional**: without it a *downgrade* fails with `INSTALL_FAILED_VERSION_DOWNGRADE`
 *   [observed — emulator-5554, Expo Go 57.0.9 → 54.0.8, 2026-09-03], and a downgrade is an ordinary
 *   case here rather than an odd one — a project on an older SDK than the emulator's Expo Go wants
 *   the older release, because the release this SDK ships is the one under test
 *   (@ref ./expoGoVersion §ExpoGoVersionCheck).
 *
 * Never throws: every failure is a `reason`.
 */
async function putOnDeviceAsync(
  deviceId: string,
  platform: 'ios' | 'android',
  bundlePath: string,
  { spawn, adb }: { spawn: typeof spawnCaptureAsync; adb: AdbResolution }
): Promise<{ ok: true; reason: null } | { ok: false; reason: string }> {
  // Each branch spawns an array literal of its own rather than one built above the call, and that
  // is deliberate: `src/lint/foreignFlags.ts` reads the options this CLI puts on another CLI's
  // command line out of the source, and it reads them off literals. `-d` in particular is the
  // difference between a working downgrade and `INSTALL_FAILED_VERSION_DOWNGRADE`, so it is exactly
  // the kind of flag that has to be countable rather than hidden in a ternary
  // (llp/0002 §A flag is not shipped until it has run against the published binary).
  const command = platform === 'android' ? adb.bin : 'xcrun';
  const installed =
    platform === 'android'
      ? await spawn(adb.bin, ['-s', deviceId, 'install', '-r', '-d', bundlePath], {
          timeoutMs: INSTALL_TIMEOUT_MS,
        })
      : await spawn('xcrun', ['simctl', 'install', deviceId, bundlePath], {
          timeoutMs: INSTALL_TIMEOUT_MS,
        });
  if (installed.spawnError) {
    return {
      ok: false,
      reason: `"${command}" could not be run (${installed.spawnError.code ?? installed.spawnError.message})`,
    };
  }
  const output = installed.stderr + installed.stdout;
  // `adb install` is the one of the two that can **exit 0 and fail**: it prints `Failure
  // [INSTALL_FAILED_…]` and returns 0 for a device that refused the package [observed, 2026-09-03],
  // so the output decides on Android and the exit code decides on iOS.
  const refused = platform === 'android' && /^Failure|\[INSTALL_FAILED/m.test(output);
  if (installed.exitCode !== 0 || refused) {
    const said = firstLine(installed.stderr || installed.stdout) || 'it printed nothing';
    // The one failure worth naming rather than passing through: `simctl install` needs a booted
    // device, and the CoreSimulator sentence for it says "current state" rather than "boot".
    const notBooted = /current state: (Shutdown|Shutting Down|Creating)/.test(output);
    if (notBooted) {
      return {
        ok: false,
        reason: `the simulator ${deviceId} is not booted, and "simctl install" only works on one that is — so the boot has to come first (${said})`,
      };
    }
    const failure = refused ? firstLine(output) : said;
    return {
      ok: false,
      reason: `"${command} install" ${refused && installed.exitCode === 0 ? 'reported a failure' : `exited ${installed.exitCode ?? 'on a signal'}`}: ${failure}`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * Download the Expo Go this SDK wants and install it on a **booted** simulator.
 *
 * The download goes to a temporary directory rather than the project, because `expo-go download`
 * writes into the working directory and 423 MB left in someone's repository would be worse than
 * the refusal this replaced. It is removed on the way out of every path.
 */
export async function installExpoGoAsync(
  deviceId: string,
  platform: 'ios' | 'android',
  sdkVersion: string | null,
  {
    spawn = spawnCaptureAsync,
    tempDirAsync = makeTempDirAsync,
    cleanupAsync = removeDirAsync,
    // Resolved lazily rather than eagerly would be tidier, and is not worth it: this is a
    // filesystem search that spawns nothing (@ref ./adb §resolveAdb).
    adb = resolveAdb(),
  }: InstallExpoGoOptions = {}
): Promise<InstallExpoGoResult> {
  // Read before anything is downloaded, so the report can tell a replacement from an addition. A
  // failure to read is not a failure to install: it only means the report says less.
  const replaced = await readInstalledVersionAsync(deviceId, platform).catch(() => null);

  const dir = await tempDirAsync();
  try {
    const downloaded = await spawn(
      'npx',
      ['--yes', 'expo-go', 'download', platform, sdkVersion ?? 'latest', '--json'],
      { cwd: dir, timeoutMs: DOWNLOAD_TIMEOUT_MS }
    );
    if (downloaded.spawnError) {
      return {
        ok: false,
        version: null,
        replaced,
        reason: `the expo-go CLI could not be run (${downloaded.spawnError.code ?? downloaded.spawnError.message})`,
      };
    }

    // One object either way: `{"path":…}` at exit 0 and `{"error":…}` at exit 1.
    let payload: { path?: unknown; error?: unknown } | null = null;
    try {
      payload = JSON.parse(downloaded.stdout.trim());
    } catch {
      payload = null;
    }
    if (payload != null && typeof payload.error === 'string') {
      return {
        ok: false,
        version: null,
        replaced,
        reason: `the expo-go CLI said: ${payload.error}`,
      };
    }
    if (payload == null || typeof payload.path !== 'string') {
      return {
        ok: false,
        version: null,
        replaced,
        reason: `the expo-go CLI answered no download path${downloaded.exitCode == null ? ' and did not exit' : ` (exit ${downloaded.exitCode})`}`,
      };
    }

    const put = await putOnDeviceAsync(deviceId, platform, payload.path, { spawn, adb });
    if (!put.ok) {
      return { ok: false, version: null, replaced, reason: put.reason };
    }

    if (platform === 'ios') {
      // An install is not finished until the link works, and on a freshly installed app on iOS it
      // does not: iOS asks first, and nobody answers (@ref ./installExpoGo §approveSchemesAsync).
      // Android needs none of it — Expo Go's `exp://` intent filter is in its manifest, so the
      // link works the moment the package is there, and there is no dialog to approve away
      // [observed — emulator-5554, Android 36, 2026-09-03].
      await approveSchemesAsync(deviceId, spawn);
    }

    // The version is in the path the CLI answered, which is the release it chose — so this reports
    // what was installed rather than what was asked for.
    return {
      ok: true,
      version: expoGoVersionFromUrl(payload.path),
      replaced,
      reason: null,
    };
  } finally {
    await cleanupAsync(dir);
  }
}
