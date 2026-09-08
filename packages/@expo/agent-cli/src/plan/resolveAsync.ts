// @ref llp/0015-backend-selection-and-config.rfc.md §The selection
// The one place a plan is made from everything outside the project: the developer's config, the
// flags they typed, this host, and what the toolchain probe found. Everything it calls is pure
// except the probe and two file reads, and it is the only module that knows the order they go in.

import { probeAppPresenceAsync, type AppPresenceProbe } from '../device/appPresence';
import { easJsonExistsSync } from '../followups/projectFiles';
import type { ProjectState, StartPlan } from '../project/types';
import { readAgentCliSettings, settingsBuildBackend } from '../settings';
import type { BuildBackend, RunTarget } from '../settings/types';
import { applyToolchainProbe, detectToolchainAsync } from '../toolchain';
import { selectBuildBackend } from '../toolchain/selectBackend';
import type { ToolchainProbe } from '../toolchain/types';
import { decideStartPlan } from './decide';
import { lookUpEasSimulatorBuildAsync } from './easBuildLookup';
import { selectRunTarget } from './runTarget';
import type { DecideStartPlanOptions, NativePlatform, PlanEasBuild } from './types';
import { EAS_SIMULATOR_PROFILE } from '../toolchain/runsOn';
import { hasBuildProfileSync } from '../utils/easJson';

/**
 * Whether this plan assumes an app that is already on a device, without having asked one.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §A current build is not an installed app
 *
 * Read off the plan rather than listed by name. A list of rule names is a second copy of the
 * decision table, kept in a file the table does not import — and a row added there would go on
 * planning a dev server for an app that is not installed, silently, because nothing would fail
 * [review of #21]. What actually matters is the two properties the caller below acts on, and both
 * are in the plan already:
 *
 *  - **it builds nothing** — a plan that ends in `expo run:*` installs what it built, so there is
 *    nothing to ask and nothing to add;
 *  - **it runs a native app of this project** — `web` opens a browser, `expo-go` runs in a
 *    published app `expo start` offers to install itself, and `not-expo-app` has no app at all.
 */
function awaitsADevice(plan: StartPlan): boolean {
  return plan.buildLocation == null && (plan.target === 'dev-client' || plan.target === 'bare');
}

export interface ResolveStartPlanOptions extends DecideStartPlanOptions {
  /** Where a flag on this command line asked the build to run, or null when none did. */
  requestedBackend?: BuildBackend | null;
  /** Which app a flag on this command line asked for, or null when none did. */
  requestedTarget?: RunTarget | null;
  /** `process.platform`. Injected so the selection can be exercised for other hosts. */
  hostPlatform?: NodeJS.Platform;
  /** Injected for tests, so the device question is answerable without a device. */
  probeAppPresence?: (projectRoot: string, platform: 'ios' | 'android') => Promise<AppPresenceProbe>;
  /**
   * Injected for tests: whether EAS has a finished simulator build of this fingerprint.
   *
   * @ref llp/0027-everything-on-eas.rfc.md §Reuse
   */
  lookUpEasBuild?: (projectRoot: string, platform: NativePlatform) => Promise<PlanEasBuild | null>;
  /** Injected for tests: whether `eas.json` has the simulator dev-client profile. */
  hasSimulatorProfile?: (projectRoot: string) => boolean;
  /** Whether the per-platform fingerprint the EAS lookup needs may come from the `.expo` record. */
  fingerprintCache?: boolean;
}

/**
 * Decide the plan, backend and all.
 *
 * The table is run **twice**, and deliberately: the first pass is what tells us whether this
 * project needs a native build at all and for which platform, and only then is there a question
 * worth asking the machine. The table itself is a pure function either way, so the second pass
 * costs nothing measurable — and paying for it keeps `decideStartPlan` a function of *project*
 * state, with the host and the config staying the caller's business (llp/0004 §Where a build runs).
 *
 * **Which question the draft earns depends on whether it builds**, and the two are exclusive:
 *
 * - A plan that builds asks the *toolchain* — can this machine compile for this platform — because
 *   that decides whether the steps are `expo run:*` or `eas build`.
 * - A plan that does not build asks the *device* — has it got the app already — because that is the
 *   assumption a buildless plan is making (llp/0004 §A current build is not an installed app).
 *
 * Neither is asked when the answer cannot change anything: a caller who asked for the cloud is not
 * made to wait on two subprocesses about this machine's Xcode, and a plan whose own `expo run:*`
 * installs the app is not made to wait on two about a simulator.
 */
export async function resolveStartPlanAsync(
  projectRoot: string,
  state: ProjectState,
  options: ResolveStartPlanOptions = {}
): Promise<StartPlan> {
  const {
    requestedBackend = null,
    requestedTarget = null,
    hostPlatform,
    probeAppPresence = probeAppPresenceAsync,
    lookUpEasBuild = (root, platform) =>
      lookUpEasSimulatorBuildAsync(root, platform, { fingerprintCache: options.fingerprintCache }),
    hasSimulatorProfile = (root) => hasBuildProfileSync(root, EAS_SIMULATOR_PROFILE),
    fingerprintCache: _fingerprintCache,
    ...planOptions
  } = options;

  const { settings } = readAgentCliSettings(projectRoot);
  const runTarget = selectRunTarget({
    requested: requestedTarget,
    configured: settings.target,
  });

  const draft = decideStartPlan(state, { ...planOptions, runTarget });
  if (!draft.buildLocation) {
    // @ref llp/0004-smart-start-and-project-state.rfc.md §A current build is not an installed app
    //
    // The device question is asked only where its answer would be acted on, and every guard here
    // is one of the ways it would not be:
    //
    // - The rule has to be one that assumed an installed app. `web` opens a browser, `expo-go` is
    //   a runtime `expo start` offers to install itself, `not-expo-app` has no app. A plan that
    //   builds never reaches this branch, and rightly: it ends in `expo run:*`, which installs
    //   what it built.
    // - This run has to be the one that opens the app. The install exists to serve the open, so a
    //   `--no-open` caller — `smoke`, which installs the app itself in its own phase, or an agent
    //   that opens with `navigate` — keeps the serve-only plan, and this also keeps `dev` from
    //   touching a device a caller said to leave alone. `status` passes no `requestedPlatform`,
    //   so it skips too, which keeps its report instant and internally consistent.
    // - The backend has to be local. `expo run:* --no-bundler` compiles when the toolchain cache
    //   is cold, and a caller who routed builds to EAS with `--eas` or config did not ask for a
    //   local compile on the way to a dev server.
    // - The device has to be on this machine. An EAS Simulator session started with `--build-id`
    //   has the app by construction (llp/0027), so there is no presence to ask about, and no
    //   local tool to ask it with.
    const opensOn =
      planOptions.open !== false &&
      planOptions.deviceBackend !== 'eas' &&
      (planOptions.requestedPlatform === 'ios' || planOptions.requestedPlatform === 'android')
        ? planOptions.requestedPlatform
        : null;
    if (!awaitsADevice(draft) || opensOn == null) {
      return draft;
    }
    if ((requestedBackend ?? settingsBuildBackend(settings, opensOn)) === 'eas') {
      return draft;
    }
    const { presence, installDevice } = await probeAppPresence(projectRoot, opensOn);
    if (presence === 'missing') {
      // The install needs the local toolchain even when nothing compiles — `expo run:ios` runs
      // through Xcode either way — so a machine without it keeps the serve-only plan rather than
      // gaining a step that can only fail. The same probe a building plan pays for, on the one
      // fresh path that is about to act like one.
      const toolchain = await detectToolchainAsync(opensOn);
      if (toolchain.status !== 'present') {
        return draft;
      }
    }
    // Run again rather than patch the draft: the table is the one place a rule and its steps are
    // decided together, and a plan assembled anywhere else is a second table to keep in step.
    return decideStartPlan(state, {
      ...planOptions,
      runTarget,
      appPresence: presence,
      installDevice,
    });
  }

  const { platform } = draft.buildLocation;
  const configured = settingsBuildBackend(settings, platform);
  const explicit = requestedBackend ?? configured;
  const probe: ToolchainProbe | null =
    explicit === 'eas' ? null : await detectToolchainAsync(platform);

  const buildBackend = selectBuildBackend({
    platform,
    hostPlatform: hostPlatform ?? process.platform,
    requested: requestedBackend,
    configured,
    probe,
  });

  // @ref llp/0027-everything-on-eas.rfc.md §Reuse
  // Two more facts, only for a build that runs on EAS for a device that is on EAS: whether the
  // simulator profile the build names exists in `eas.json`, and whether EAS already has the build.
  // The second is not asked of a project that has yet to install `expo-dev-client`: that install
  // moves the fingerprint, so a build found now is a build of a project that is about to change.
  const onEas = buildBackend.runsOn === 'eas' && planOptions.deviceBackend === 'eas';
  const easBuild =
    onEas && draft.rule !== 'needs-dev-client' ? await lookUpEasBuild(projectRoot, platform) : null;

  const plan = decideStartPlan(state, {
    ...planOptions,
    runTarget,
    buildBackend,
    easJson: buildBackend.runsOn === 'eas' ? easJsonExistsSync(projectRoot) : undefined,
    ...(onEas ? { easBuild, easSimulatorProfile: hasSimulatorProfile(projectRoot) } : {}),
  });

  // The probe's caveats — an SDK the tooling finds and a tool of it the shell does not — belong to
  // a plan that still builds here. A plan that moved to the cloud has no use for them.
  return plan.buildLocation?.runsOn === 'local' && probe ? applyToolchainProbe(plan, probe) : plan;
}
