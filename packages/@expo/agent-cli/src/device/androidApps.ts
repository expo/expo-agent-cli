// @ref llp/0005-runtime-loop-tools.rfc.md §The Expo Go on the device is not the Expo Go the SDK wants
// @ref llp/0005-runtime-loop-tools.rfc.md §Android
//
// Which apps an Android device has, and which version of one.
//
// The Android half of `./installedApps.ts`, and it looks nothing like it. That file reads a
// simulator's **disk**, because the tools that would answer refuse on a device that is not booted
// and every device it asks about is shut. Here the opposite holds: an Android device this CLI can
// ask about is a device `adb` lists, which is a device that is *up* — so the question goes to the
// package manager on the device, which is the thing that actually knows.
//
// Two commands, and the choice of each is a measurement rather than a preference
// [all observed — emulator-5554, Android 36, 2026-09-03]:
//
// - **Is it installed:** `pm path <id>`, which exits **1** for a package the device has not got and
//   `0` with `package:/data/app/…` for one it has. `pm list packages <id>` was the obvious
//   alternative and is worse twice over: it exits `0` either way, so the answer has to be parsed
//   out of an empty string, and its argument is a *substring* filter — `host.exp.exponent` also
//   matches `host.exp.exponent.debug`, which is a different app.
// - **Which version:** `dumpsys package <id>`, whose output carries `versionName=57.0.9`. It exits
//   **0 even for a package that is not installed**, printing `Unable to find package: <id>`, so the
//   exit code decides nothing here and the absence of a `versionName` is the whole answer.

import { runAdbAsync, type AdbResolution } from './adb';

/** How long one package-manager question gets. It reads local state on the device and answers. */
const PM_TIMEOUT_MS = 15_000;

/** `versionName=<version>` in `dumpsys package` output, which is where the version lives. */
const VERSION_NAME = /^\s*versionName=(\S+)\s*$/m;

export interface AndroidAppOptions {
  /** Injected so a caller that has already resolved `adb` does not resolve a second copy. */
  adb?: AdbResolution;
  /** Injected for the tests, so both commands are provable without an emulator. */
  runAdbAsync?: typeof runAdbAsync;
}

/**
 * Whether one Android device has one app.
 *
 * **Three answers, not two.** `null` is "this could not be looked up" — no `adb` on the machine, a
 * device that has gone away, a `pm` that answered something unreadable — and it is separate from
 * `false` for the same reason `simulatorDiskExistsAsync` exists on the iOS side: the caller that
 * acts on `false` downloads a few hundred megabytes, and a failed lookup is not a licence to do
 * that (@ref ./installedApps §simulatorDiskExistsAsync).
 *
 * Never throws.
 */
export async function androidHasAppAsync(
  serial: string,
  appId: string,
  { adb, runAdbAsync: run = runAdbAsync }: AndroidAppOptions = {}
): Promise<boolean | null> {
  const result = await run(['-s', serial, 'shell', 'pm', 'path', appId], {
    adb,
    timeoutMs: PM_TIMEOUT_MS,
  });
  if (result.notRunnable) {
    return null;
  }
  // @ref ./androidApps — `pm path` is the one of the two whose exit code means something: `0` with
  // a `package:` line for an app that is there, `1` for one that is not.
  if (result.exitCode === 0 && /^package:/m.test(result.stdout)) {
    return true;
  }
  if (result.exitCode === 1) {
    return false;
  }
  // Anything else — a device that is offline, a shell that could not run, a code nothing here
  // predicted — is a lookup that did not happen rather than an app that is not there.
  return null;
}

/**
 * The version of the Expo Go installed on one Android device, or null when there is none to read.
 *
 * Null covers both "no Expo Go" and "could not ask", and that is deliberate here: the caller is the
 * version check, whose answer for a null is `unknown`, and `unknown` installs nothing and refuses
 * nothing (@ref ./expoGoVersion §ExpoGoVersionCheck). The caller that needs the two apart asks
 * {@link androidHasAppAsync}, which keeps them apart.
 *
 * Never throws.
 */
export async function readInstalledExpoGoVersionAndroidAsync(
  serial: string,
  appId: string,
  { adb, runAdbAsync: run = runAdbAsync }: AndroidAppOptions = {}
): Promise<string | null> {
  const result = await run(['-s', serial, 'shell', 'dumpsys', 'package', appId], {
    adb,
    timeoutMs: PM_TIMEOUT_MS,
  });
  if (result.notRunnable) {
    return null;
  }
  // @ref ./androidApps — the exit code is `0` for a package that is not installed too, so what
  // decides is whether the output carries a version at all.
  return VERSION_NAME.exec(result.stdout)?.[1] ?? null;
}
