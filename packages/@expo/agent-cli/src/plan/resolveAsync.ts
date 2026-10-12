// @ref llp/0015-backend-selection-and-config.rfc.md §The selection
// The one place a plan is made from everything outside the project: the developer's config, the
// flags they typed, this host, and what the toolchain probe found. Everything it calls is pure
// except the probe and two file reads, and it is the only module that knows the order they go in.

import {
  probeAppPresenceAsync,
  type AppPresenceDevice,
  type AppPresenceProbe,
} from '../device/appPresence';
import type { AcquireResult } from '../deviceBinding';
import { easJsonExistsSync } from '../followups/projectFiles';
import type { ProjectState, StartPlan } from '../project/types';
import { readAgentCliSettings, settingsBuildBackend } from '../settings';
import type { AgentCliSettings } from '../settings/types';
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

/** The plan, and the device `dev` bound while it was decided. */
export interface ResolvedStartPlan {
  plan: StartPlan;
  /** Null when the caller passed no `acquireDevice`, or its callback answered null. */
  acquired: AcquireResult | null;
}

export interface ResolveStartPlanOptions extends DecideStartPlanOptions {
  /** Where a flag on this command line asked the build to run, or null when none did. */
  requestedBackend?: BuildBackend | null;
  /** Which app a flag on this command line asked for, or null when none did. */
  requestedTarget?: RunTarget | null;
  /** `process.platform`. Injected so the selection can be exercised for other hosts. */
  hostPlatform?: NodeJS.Platform;
  /** Injected for tests, so the device question is answerable without a device. */
  probeAppPresence?: (
    projectRoot: string,
    platform: 'ios' | 'android',
    bound: AppPresenceDevice
  ) => Promise<AppPresenceProbe>;
  /**
   * Bind this worktree's device for a native draft, before the presence probe asks it.
   *
   * @ref llp/0031-ios-binding.plan.md §How `dev` uses it
   * Only `dev` passes one. It runs for every `expo-go`, `dev-client` and `bare` draft of a native
   * platform without `--eas`, and before the `--no-open` exit, because the install step must be
   * pinned whether or not this run opens the app. Null means the run bound nothing.
   */
  acquireDevice?: (draft: StartPlan) => Promise<AcquireResult | null>;
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
): Promise<ResolvedStartPlan> {
  const {
    requestedBackend = null,
    requestedTarget = null,
    hostPlatform,
    probeAppPresence = probeAppPresenceAsync,
    acquireDevice,
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
    return await resolveServingDraftAsync(projectRoot, state, draft, {
      planOptions: { ...planOptions, runTarget },
      settings,
      requestedBackend,
      probeAppPresence,
      acquireDevice,
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
  return {
    plan: plan.buildLocation?.runsOn === 'local' && probe ? applyToolchainProbe(plan, probe) : plan,
    acquired: null,
  };
}

/**
 * A draft that builds nothing: bind the device, then ask it whether the app is there.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §A current build is not an installed app
 * @ref llp/0031-ios-binding.plan.md §How `dev` uses it — the exits, in order. The device question
 * is asked only where its answer would be acted on: a `web` or `none` draft has no app on a device,
 * `--eas` puts the device on EAS, an `expo-go` draft is a runtime `dev` installs itself, a
 * `--no-open` caller keeps the serve-only plan, and a build routed to EAS did not ask for a local
 * compile on the way to a dev server. The binding happens before the `expo-go` and `--no-open`
 * exits, because the install step must be pinned whether or not this run opens the app.
 */
async function resolveServingDraftAsync(
  projectRoot: string,
  state: ProjectState,
  draft: StartPlan,
  {
    planOptions,
    settings,
    requestedBackend,
    probeAppPresence,
    acquireDevice,
  }: {
    planOptions: DecideStartPlanOptions;
    settings: AgentCliSettings;
    requestedBackend: BuildBackend | null;
    probeAppPresence: NonNullable<ResolveStartPlanOptions['probeAppPresence']>;
    acquireDevice: ResolveStartPlanOptions['acquireDevice'];
  }
): Promise<ResolvedStartPlan> {
  const requested = planOptions.requestedPlatform;
  if (
    draft.target === 'web' ||
    draft.target === 'none' ||
    (requested !== 'ios' && requested !== 'android') ||
    planOptions.deviceBackend === 'eas'
  ) {
    return { plan: draft, acquired: null };
  }
  const acquired = (await acquireDevice?.(draft)) ?? null;
  if (draft.target === 'expo-go' || planOptions.open === false) {
    return { plan: draft, acquired };
  }
  if ((requestedBackend ?? settingsBuildBackend(settings, requested)) === 'eas') {
    return { plan: draft, acquired };
  }
  const { presence, installDevice } = await probeAppPresence(projectRoot, requested, {
    device: acquired?.device ?? null,
    action: acquired?.action ?? null,
  });
  if (presence === 'missing') {
    // The install needs the local toolchain even when nothing compiles — `expo run:ios` runs
    // through Xcode either way — so a machine without it keeps the serve-only plan rather than
    // gaining a step that can only fail. The same probe a building plan pays for, on the one
    // fresh path that is about to act like one.
    const toolchain = await detectToolchainAsync(requested);
    if (toolchain.status !== 'present') {
      return { plan: draft, acquired };
    }
  }
  // Run again rather than patch the draft: the table is the one place a rule and its steps are
  // decided together, and a plan assembled anywhere else is a second table to keep in step.
  return {
    plan: decideStartPlan(state, { ...planOptions, appPresence: presence, installDevice }),
    acquired,
  };
}
