// @ref llp/0005-runtime-loop-tools.rfc.md §The gate installs the app, whichever app it is
// @ref llp/0001-agentic-cli-on-expo-cli.rfc.md — constraint 4, on subprocesses
//
// Put this project's **development build** on a device that has not got it.
//
// The other half of `./installExpoGo.ts`, and the half that used to be a refusal. `smoke` would
// find a device without the app and name `@expo/agent-cli dev --<platform> --yes` — a correct
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

import { spawnCaptureAsync } from '../utils/spawnCapture';

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
  }: InstallDevBuildOptions = {}
): Promise<InstallDevBuildResult> {
  const args = [`run:${platform}`, '--no-bundler', '--device', deviceId];
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
