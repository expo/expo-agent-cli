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
import { selectRunTarget } from './runTarget';
import type { DecideStartPlanOptions, StartPlanRule } from './types';

/**
 * The rules whose plan is "the app is already on a device, so just serve it".
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §A current build is not an installed app
 *
 * The two rows that assume an installed app without ever having asked. Every other buildless rule
 * has nothing to ask about: `web` opens a browser, `expo-go` runs in a published app that
 * `expo start` offers to install itself, and `not-expo-app` has no app.
 */
const AWAITS_A_DEVICE = new Set<StartPlanRule | string>(['dev-client-fresh', 'bare-fresh']);

export interface ResolveStartPlanOptions extends DecideStartPlanOptions {
  /** Where a flag on this command line asked the build to run, or null when none did. */
  requestedBackend?: BuildBackend | null;
  /** Which app a flag on this command line asked for, or null when none did. */
  requestedTarget?: RunTarget | null;
  /** `process.platform`. Injected so the selection can be exercised for other hosts. */
  hostPlatform?: NodeJS.Platform;
  /** Injected for tests, so the device question is answerable without a device. */
  probeAppPresence?: (projectRoot: string, platform: 'ios' | 'android') => Promise<AppPresenceProbe>;
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
    const opensOn =
      planOptions.open !== false &&
      (planOptions.requestedPlatform === 'ios' || planOptions.requestedPlatform === 'android')
        ? planOptions.requestedPlatform
        : null;
    if (!AWAITS_A_DEVICE.has(draft.rule) || opensOn == null) {
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

  const plan = decideStartPlan(state, {
    ...planOptions,
    runTarget,
    buildBackend,
    easJson: buildBackend.runsOn === 'eas' ? easJsonExistsSync(projectRoot) : undefined,
  });

  // The probe's caveats — an SDK the tooling finds and a tool of it the shell does not — belong to
  // a plan that still builds here. A plan that moved to the cloud has no use for them.
  return plan.buildLocation?.runsOn === 'local' && probe ? applyToolchainProbe(plan, probe) : plan;
}
