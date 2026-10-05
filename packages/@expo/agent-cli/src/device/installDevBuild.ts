// @ref llp/0005-runtime-loop-tools.rfc.md §The gate installs the app, whichever app it is
// @ref llp/0001-agentic-cli-on-expo-cli.rfc.md — constraint 4, on subprocesses
//
// Put this project's **development build** on a device that has not got it.
//
// The other half of `./installExpoGo.ts`, and the half that used to be a refusal. `smoke` would
// find a device without the app and name `@expo/agent-cli dev --<platform>` — a correct
// instruction and a dead end for an agent, which cannot take it without leaving the loop this CLI
// exists to serve [confirmed, Kudo, 2026-09-04: "smoke should be self-served without running dev
// first", "if the app isn't installed, smoke should install it?"].
//
// **It is `expo run:<platform>`, not a build of our own.** That command already does exactly this
// job — compile what is missing, reusing Xcode's or Gradle's cache when nothing changed, then
// install onto a device and launch it — and llp/0001 constraint 4 says to invoke the Expo CLI
// family rather than reimplement it. Two flags make it usable from inside a run that is already
// under way, and both were read off the published binary rather than the monorepo
// [observed — `npx expo run:ios --help` and `run:android --help`, 2026-09-04]:
//
//   --no-bundler       this run already has a dev server, and a second Metro would be a second
//                      answer to "which bundle is the app under test running"
//   --device <id>      the simulator or emulator this run settled on, so the app lands where the
//                      rest of the run is looking rather than on whatever the CLI would pick
//
// **It is not `@expo/agent-cli dev`.** That plans and starts a dev server, which is the thing this
// run has already done; asking for it again from inside the install phase would start a second one.

import path from 'path';

import { readJsonFileAsync, resolvePackageRootAsync } from '../project/nodeModules';
import { spawnCaptureAsync } from '../utils/spawnCapture';
import { runAdbAsync } from './adb';

/** What `expo run:<platform> --device` is given for one device, or why no value is safe. */
export type RunDeviceArgument =
  /** Null when the device cannot be named: the install then runs unpinned. */
  { ok: true; value: string | null } | { ok: false; reason: string };

/**
 * The `--device` value of `expo run:*` for the device this worktree claims.
 *
 * @ref llp/0030-one-device-per-agent.rfc.md §Every verb uses the claim
 *
 * iOS takes the UDID. Android depends on the project's Expo CLI: 58 matches the adb serial
 * before the name (`AndroidDeviceManager.resolveFromNameAsync`), and 57 matches only the name
 * [observed — `@expo/cli` 57.0.21: `devices.find((device) => device.name === name)`]. An emulator's
 * name is its AVD, so on 57 a second, read-only instance of one AVD has the same name as the first,
 * and the install could land on the other worktree's emulator. That case is refused.
 */
export async function expoRunDeviceArgumentAsync(
  projectRoot: string,
  platform: 'ios' | 'android',
  deviceId: string,
  {
    run = runAdbAsync,
    readCliMajor = readExpoCliMajorAsync,
  }: {
    run?: typeof runAdbAsync;
    readCliMajor?: (projectRoot: string) => Promise<number | null>;
  } = {}
): Promise<RunDeviceArgument> {
  if (platform === 'ios') {
    return { ok: true, value: deviceId };
  }
  const major = await readCliMajor(projectRoot);
  if (major != null && major >= 58) {
    return { ok: true, value: deviceId };
  }
  const name = await androidDeviceNameAsync(deviceId, { run });
  if (name == null || !deviceId.startsWith('emulator-')) {
    return { ok: true, value: name };
  }
  const listed = await run(['devices', '-l'], { timeoutMs: NAME_TIMEOUT_MS });
  const serials = listed.exitCode === 0 ? (listed.stdout.match(/^emulator-\d+(?=\s)/gm) ?? []) : [];
  for (const serial of serials) {
    if (serial !== deviceId && (await androidDeviceNameAsync(serial, { run })) === name) {
      return {
        ok: false,
        reason: `${deviceId} and ${serial} both run the AVD "${name}", and this project's Expo CLI${
          major == null ? '' : ` (${major})`
        } picks the device for "expo run:android --device" by that name alone, so the app could be installed on the other one. Upgrade to @expo/cli 58 or newer, which takes the serial, or stop one of the two emulators`,
      };
    }
  }
  return { ok: true, value: name };
}

/** The major version of the `@expo/cli` the project runs, or null when it is not installed. */
async function readExpoCliMajorAsync(projectRoot: string): Promise<number | null> {
  const expoRoot = await resolvePackageRootAsync(projectRoot, 'expo');
  const cliRoot =
    (await resolvePackageRootAsync(projectRoot, '@expo/cli')) ??
    (expoRoot ? await resolvePackageRootAsync(expoRoot, '@expo/cli') : null);
  if (cliRoot == null) {
    return null;
  }
  const packageJson = await readJsonFileAsync<{ version?: string }>(
    path.join(cliRoot, 'package.json')
  );
  const major = Number(packageJson?.version?.split('.')[0]);
  return Number.isInteger(major) ? major : null;
}

/** How long `adb` gets to name one device. It reads local state and answers. */
const NAME_TIMEOUT_MS = 15_000;

/**
 * What `expo run:android --device` calls this device, or null when it cannot be named.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §The gate installs the app, whichever app it is
 *
 * **`--device` does not mean the same thing on the two platforms**, and the difference is not in
 * the help text in a way anybody would notice: iOS takes a *"Device name, UDID, or generic"*, and
 * Android takes a *"Device name"* and nothing else. Passing an `adb` serial to Android answers
 * `CommandError: Could not find device with name: emulator-5554` [observed — live, 2026-09-04],
 * which is what this function exists to avoid.
 *
 * The names it accepts are the ones its own device list builds
 * [reference — `@expo/cli` `src/start/platforms/android/adb.ts` §getAttachedDevicesAsync]: an
 * emulator is its **AVD name**, from `adb -s <serial> emu avd name`, and a physical device is the
 * `model:` field of `adb devices -l`. So this asks the same two questions in the same order.
 */
export async function androidDeviceNameAsync(
  serial: string,
  { run = runAdbAsync }: { run?: typeof runAdbAsync } = {}
): Promise<string | null> {
  if (serial.startsWith('emulator-')) {
    const named = await run(['-s', serial, 'emu', 'avd', 'name'], { timeoutMs: NAME_TIMEOUT_MS });
    if (!named.notRunnable && named.exitCode === 0) {
      // Two lines: the name, then `OK`. The console protocol's acknowledgement is not the answer.
      const name = named.stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0 && line !== 'OK');
      if (name) {
        return name;
      }
    }
    return null;
  }

  const listed = await run(['devices', '-l'], { timeoutMs: NAME_TIMEOUT_MS });
  if (listed.notRunnable || listed.exitCode !== 0) {
    return null;
  }
  const row = listed.stdout
    .split('\n')
    .find((line) => line.startsWith(`${serial}\t`) || line.startsWith(`${serial} `));
  return (
    row
      ?.split(/\s+/)
      .find((field) => field.startsWith('model:'))
      ?.replace('model:', '') ?? null
  );
}

/**
 * How long the build gets.
 *
 * The same budget the start phase gives a plan that compiles (`BUILD_DEV_SERVER_TIMEOUT_MS`), and
 * for the same reason: a cold `expo run:ios` is a pod install and a full native compile, and the
 * cost of a bound that is too short is the worst failure this command has — twenty minutes spent
 * and then a timeout reported for a build that was going fine.
 */
const BUILD_TIMEOUT_MS = 1_800_000;

/** What putting a development build on a device amounted to. Never throws: a failure is a result. */
export interface InstallDevBuildResult {
  ok: boolean;
  /** The command that ran, for a report that says what was spent. */
  command: string;
  /** Why it did not work. Null exactly when {@link ok} is true. */
  reason: string | null;
}

export interface InstallDevBuildOptions {
  spawn?: typeof spawnCaptureAsync;
  /** Injected for the tests. The real one is `npx`, which resolves the project's own Expo CLI. */
  timeoutMs?: number;
  /**
   * Whether the app is on the device **now**, asked after the command has run.
   *
   * @ref ./installDevBuild — the reason the exit code is not the judge.
   *
   * `expo run:ios` finishes by activating the Simulator window through AppleScript, and on a Mac
   * that has granted no Automation permission that throws — *after* the build has compiled and the
   * app has been installed. Measured: the command exited non-zero with an `osascript` stack, and
   * the app was on the simulator [observed — live, 2026-09-04, iOS 26.5]. The window is nothing
   * this run needs: `smoke` opens the app itself with `simctl openurl`, which needs no grant
   * (llp/0005 §The smoke gate, on why `--start` carries no platform flag).
   *
   * So the question is "is the app there", and the device answers it. Null when it could not be
   * asked, and then the exit code decides after all — it is the only evidence left.
   */
  verifyInstalledAsync?: () => Promise<boolean | null>;
  /** Injected for the tests, so the Android name lookup is provable without an emulator. */
  run?: typeof runAdbAsync;
}

/** The first line of a message, for a reason that has to fit on one. */
function firstLine(text: string): string {
  return text.split('\n')[0]!.trim();
}

/**
 * Build and install this project's development build onto one device.
 *
 * @param projectRoot the project to build. The command runs here, because `expo run:*` reads the
 * project it is standing in.
 * @param deviceId the simulator udid or `adb` serial the run chose.
 */
export async function installDevBuildAsync(
  projectRoot: string,
  platform: 'ios' | 'android',
  deviceId: string,
  {
    spawn = spawnCaptureAsync,
    timeoutMs = BUILD_TIMEOUT_MS,
    verifyInstalledAsync,
    run,
  }: InstallDevBuildOptions = {}
): Promise<InstallDevBuildResult> {
  // @ref ./installDevBuild §expoRunDeviceArgumentAsync. A device Android cannot name gets no
  // `--device` at all rather than a wrong one, and a name two emulators share is refused.
  const argument = await expoRunDeviceArgumentAsync(
    projectRoot,
    platform,
    deviceId,
    run ? { run } : {}
  );
  if (!argument.ok) {
    return { ok: false, command: `npx expo run:${platform} --no-bundler`, reason: argument.reason };
  }
  const target = argument.value;
  // Pushed rather than spread, so `--device` stays a literal the foreign-flag sweep can see: a
  // conditional spread hid it, and a flag this CLI writes onto another CLI's command line without
  // the guard noticing is exactly what that guard exists to stop (llp/0002 §A flag is not shipped
  // until it has run against the published binary).
  const args = [`run:${platform}`, '--no-bundler'];
  if (target != null) {
    args.push('--device', target);
  }
  const command = `npx expo ${args.join(' ')}`;

  const built = await spawn('npx', ['expo', ...args], { cwd: projectRoot, timeoutMs });
  if (built.spawnError) {
    return {
      ok: false,
      command,
      reason: `the Expo CLI could not be run (${built.spawnError.code ?? built.spawnError.message})`,
    };
  }
  if (built.exitCode === 0) {
    return { ok: true, command, reason: null };
  }

  // @ref ./installDevBuild §verifyInstalledAsync — the device decides, not the exit code. The
  // commonest non-zero here is the AppleScript window activation the build performs *after* it has
  // installed, and failing the install over a window this run does not need would throw away a
  // native build that worked.
  const installed = await verifyInstalledAsync?.();
  // The CLI's own last line, which for a native build is the compiler's complaint rather than a
  // sentence about this command. Quoted rather than replaced: it names the file.
  const said = firstLine(built.stderr || built.stdout) || 'it printed nothing';
  if (installed === true) {
    return {
      ok: true,
      command,
      // Reported even though this succeeded, because something did go wrong and a reader who sees
      // the app working should still be able to find out what (llp/0021 §The rules).
      reason: `the app was built and installed, and "${command}" then exited ${built.exitCode ?? 'on a signal'} doing something else: ${said}`,
    };
  }
  return {
    ok: false,
    command,
    reason: `"${command}" exited ${built.exitCode ?? 'on a signal'}: ${said}`,
  };
}
