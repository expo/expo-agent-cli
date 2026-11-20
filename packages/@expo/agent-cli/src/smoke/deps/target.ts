import type { CloudPreference } from '../../navigate/device';
import { Log } from '../../log';
import { PROGRAM_PREFIX } from '../../programName';
import { firstLine } from '../../utils/text';
import type { StartPlan } from '../../project/types';
import type { SmokeOptions } from '../resolveOptions';

/**
 * What this run would open, and whether it may start a dev server for it at all.
 *
 * One read of the project's plan, answering the two questions that are really the same one: which
 * app is this run about, and is it an app that exists yet.
 */
export interface SmokeTarget {
  /**
   * Where this project's plan would build, or null when it builds nothing.
   *
   * @ref llp/0036-smoke-gate.rfc.md §It builds what the app needs, and says so first
   * `StartPlan.buildLocation`, the plan engine's own answer to "does this plan compile anything":
   * an Expo Go target and a development build already installed for this fingerprint both answer
   * null. It used to be the boundary this command refused at; it is now the fact that decides the
   * start phase's budget and the sentence printed before the wait.
   */
  buildLocation: StartPlan['buildLocation'];
  /**
   * The application id this run's deep link would open, or null when it could not be read.
   *
   * @ref llp/0036-smoke-gate.rfc.md §The device that can open the app
   * The **plan's** rule decides it rather than the app config alone, and that distinction is the
   * whole value: an Expo Go project usually also declares an `ios.bundleIdentifier`, so a device
   * choice made from the config would go looking for an app this run is never going to open.
   */
  appId: string | null;
  /** What to call it in a sentence — `Expo Go` reads better than `host.exp.Exponent`. */
  appLabel: string | null;
  /** The command that puts that app on a simulator, for a machine where no device has it. */
  installWith: string | null;
  /**
   * How this run puts the app on a device that has not got it.
   *
   * @ref llp/0036-smoke-gate.rfc.md §The gate installs the app, whichever app it is
   *
   * **This was a boolean, and the boolean was the last refusal in the command**
   * [confirmed, Kudo, 2026-09-04: "smoke should be self-served without running dev first"]. It was
   * true for exactly one plan rule, `expo-go`, on the reasoning that Expo Go is a published binary
   * to download and a development build is this project's own artefact to compile — so the compile
   * belonged to `dev`. The distinction is real and it is not the caller's problem: an agent told
   * "run `dev --ios` first" cannot take that instruction without leaving the loop this
   * command exists to serve, which is the same dead end §Putting Expo Go on a simulator that has
   * not got it was written against.
   *
   * So both are installs, and this says which kind:
   *
   * - `expo-go` — download the release this SDK ships and `simctl install` it.
   * - `native-build` — `expo run:<platform> --no-bundler --device <id>`, which builds what is
   *   missing and installs it onto the device this run chose. `--no-bundler` because this run
   *   already has a dev server and a second one would be a second answer to "which bundle".
   * - `null` — the plan could not be read, so this run does not know which app to install, and
   *   installs nothing.
   */
  installWithKind: 'expo-go' | 'native-build' | null;
}

/** Read the plan once, and answer both questions from it. Never throws. */
export async function resolveSmokeTargetAsync(
  projectRoot: string,
  options: SmokeOptions,
  route: CloudPreference
): Promise<SmokeTarget> {
  const { probeProjectStateAsync } =
    require('../../project/probe') as typeof import('../../project/probe');
  const { readLastBuildRecord } =
    require('../../plan/lastBuild') as typeof import('../../plan/lastBuild');
  const { resolveStartPlanAsync } =
    require('../../plan/resolveAsync') as typeof import('../../plan/resolveAsync');
  const { EXPO_GO_APP_ID, readConfiguredAppId } =
    require('../../runtime/appId') as typeof import('../../runtime/appId');

  const unknown: SmokeTarget = {
    buildLocation: null,
    appId: null,
    appLabel: null,
    installWith: null,
    // An unread plan can be an Expo Go project, so a development build is a guess: install nothing.
    installWithKind: null,
  };

  let plan;
  try {
    const state = await probeProjectStateAsync(projectRoot);
    plan = (
      await resolveStartPlanAsync(projectRoot, state, {
        platform: options.platform,
        lastBuild: readLastBuildRecord(projectRoot),
        // @ref llp/0027-everything-on-eas.rfc.md §smoke — the same plan `dev --eas` makes, so the
        // build this names is the simulator profile on EAS and the session can install it.
        ...(route === 'required'
          ? { requestedBackend: 'eas' as const, deviceBackend: 'eas' as const }
          : {}),
      })
    ).plan;
  } catch (error: unknown) {
    // The probe is a courtesy, not a gate: a project it could not read is one this knows nothing
    // about, and refusing or choosing a device on an unread plan would stop runs that would have
    // worked. The run goes on with no install kind, so it installs nothing.
    Log.warn(
      `The start plan could not be read (${firstLine(error instanceof Error ? error.message : String(error))}), so smoke installs no app on the device.`
    );
    return unknown;
  }

  // `expo-go` is the one rule whose app is not this project's own build. Everything else — a
  // development build, a bare project, one that needs `expo-dev-client` — opens the app the
  // config names, whether or not it is installed anywhere yet.
  const expoGo = plan.rule === 'expo-go';
  const configured = expoGo ? null : readConfiguredAppId(projectRoot, options.platform);
  const appId = expoGo ? EXPO_GO_APP_ID[options.platform] : configured;

  return {
    buildLocation: plan.buildLocation,
    appId,
    appLabel: expoGo ? 'Expo Go' : appId,
    // Two different commands, because they put two different apps on the device. `expo start
    // --ios` is what installs Expo Go [observed — `@expo/cli` `openPlatforms.ts` →
    // `PlatformManager.openProjectInExpoGoAsync`, the same finding llp/0004 §Decision table
    // records for the plan's platform flag]; a development build is `dev`'s to make.
    installWith: expoGo
      ? `${PROGRAM_PREFIX} start --${options.platform}`
      : `${PROGRAM_PREFIX} dev --${options.platform}${route === 'required' ? ' --eas' : ''}`,
    installWithKind: expoGo ? 'expo-go' : 'native-build',
  };
}
