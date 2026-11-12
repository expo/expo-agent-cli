// @ref llp/0004-smart-start-and-project-state.rfc.md §Plan contract
import {
  acquireDeviceAsync,
  acquireLine,
  deviceIdOf,
  devicesDisabled,
  hostBindsPlatform,
  inspectBindingAsync,
  localBackendOf,
  type AcquireResult,
  type DevicePlatform,
} from '../deviceBinding';
import { isExplicitChoiceRefusal } from '../deviceBinding/errors';
import { previewExplicitDeviceAsync } from '../deviceBinding/preview';
import { readDevServerLockAsync } from '../devLock/client';
import type { DevServerLockInfo } from '../devLock/types';
import { buildStartPlanFollowUps, followUpsEnabled, reportFollowUps } from '../followups';
import { Log } from '../log';
import { assertEasProjectConfiguredAsync } from '../needsHuman/easProject';
import { emitStartPlan } from '../plan/emit';
import { readLastBuildRecord } from '../plan/lastBuild';
import { rerunDevCommand } from '../plan/rerun';
import { resolveStartPlanAsync } from '../plan/resolveAsync';
import type { PlanPlatform } from '../plan/types';
import { PROGRAM_NAME, PROGRAM_PREFIX } from '../programName';
import { probeProjectStateAsync } from '../project/probe';
import type { ProjectState, StartPlan } from '../project/types';
import { CONFIG_LOCATION } from '../settings/read';
import {
  EAS_REQUIREMENT,
  EAS_WHERE,
  LOCAL_WHERE,
  localRequirement,
  localTool,
} from '../toolchain/runsOn';
import { CommandError } from '../utils/errors';
import { detachedPidLine } from './childVerdict';
import { otherPlatformSessionError } from '../device/cloudErrors';
import { otherPlatformSessionAsync } from './openAppEas';
import { easOpenPlatform } from './resolveOptions';
import { explicitRequestOf, withoutDeviceArgs } from './deviceOption';
import {
  findUntrackedDevServerAsync,
  planDevServerPortAsync,
  portDemandedError,
  replaceUntrackedDevServerAsync,
  warnPortMove,
} from './devServerPort';
import { executeDevPlanAsync, type ExecutedDevPlan } from './executeDevPlanAsync';
import { isDevServerStep, withDevice, withForwardedExpoArgs } from './forwardedArgs';
import { recordLastDevRequest } from './lastRequest';
import { resolvePlannedPortAsync } from './portCollision';
import { type DevOptions } from './resolveOptions';
import { PLANNED, resolveRunFollowUpsAsync } from './runFollowUps';
import { devServerRunningStopAsync } from './runningDevServer';

/**
 * Probe the project, emit the plan, and run it.
 *
 * @returns 0 after a successful foreground run or plan, or the detached parent's result.
 */
export async function devAsync(projectRoot: string, options: DevOptions): Promise<number> {
  // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — line 1 of the detached
  // log, so a parent can tell which run wrote it.
  if (options.detachedChild) {
    Log.progress(detachedPidLine(process.pid));
  }
  if (options.device !== undefined && boundPlatform(options) == null) {
    throw deviceNotBindableError(options);
  }

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — before the probe, because
  // the child does the probe: this run's whole job is to start that child and report on it.
  if (options.detach) {
    const { devDetachAsync } = require('./detachAsync') as typeof import('./detachAsync');
    return await devDetachAsync(projectRoot, options, { publicDev: true });
  }

  if (options.detachedChild) {
    const platform = easOpenPlatform(options);
    const other = platform ? await otherPlatformSessionAsync(projectRoot, platform) : null;
    if (platform && other)
      throw otherPlatformSessionError(other.platform, {
        wanted: platform,
        sessionId: other.sessionId,
        devServerRunning: false,
      });
  }

  if (options.mode !== 'plan' && options.deviceBackend === 'eas') {
    await assertEasProjectConfiguredAsync(projectRoot);
  }

  // @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port — one dev server per project.
  // The lock is read once, before the project is probed. A run stops here on a live one and spends
  // nothing below this line, the last-request record included: a request the lock refused never
  // replaces the one that started the running server. A plan goes on, because it prints the rule
  // and the reasons, and stops in its port block on the same lock.
  const lock = await readDevServerLockAsync(projectRoot);
  if (lock && options.mode !== 'plan') {
    throw await devServerRunningStopAsync(projectRoot, lock, options.platform, {
      eas: options.deviceBackend === 'eas',
    });
  }
  recordLastDevRequest(projectRoot, options);
  // Judged before the probe, stopped after the refusals: a run that refuses leaves it serving.
  const orphan = await findUntrackedDevServerAsync(projectRoot, lock, options);

  const state = await probeProjectStateAsync(projectRoot, {
    fingerprintCache: options.fingerprintCache,
  });
  // @ref llp/0035-one-device-per-worktree.rfc.md §How `dev` uses it — the resolver binds the device for a
  // draft that builds nothing, before its presence probe; a draft that builds is bound below, after
  // the refusals, so no simulator is created for a run that then refuses.
  const acquireDevice = deviceCallbackFor(projectRoot, options, lock, orphan.claim.claimedPort);
  // @ref llp/0015-backend-selection-and-config.rfc.md §The selection
  // One call that folds in everything outside the project: the developer's config, the flags they
  // typed, this host and the toolchain probe. The backend is chosen **here**, before the plan is
  // printed, so the steps an agent approves are the steps that run — never swapped mid-run
  // (llp/0008 §Plan-with-cost dry run).
  const {
    plan: forwardedPlan,
    acquired: boundEarly,
    dropped,
  } = await resolveDevPlanAsync(projectRoot, state, options, acquireDevice);

  let plan = await planDevServerPortAsync(projectRoot, lock, forwardedPlan, options, orphan.claim);
  warnDroppedExpoArgs(plan, dropped);

  // A draft that builds is bound here, not in the resolver: after the port check above and the
  // refusals below, so a run that refuses creates no simulator, and `--plan` only inspects.
  const bindsHere = forwardedPlan.buildLocation != null;
  const stopped = plan.devServerPort?.state === 'running';
  let acquired = boundEarly;
  const implicitEas = isImplicitEas(plan);

  // @ref llp/0009-smart-followups.rfc.md §Examples per command
  // `--plan` stops here, so its follow-ups are about the plan itself and the plan object is the
  // whole answer.
  if (options.mode === 'plan') {
    // A plan that stops binds nothing, so it says nothing about a device.
    if (!implicitEas && !stopped) {
      if (bindsHere) {
        acquired = await acquireDevice(plan);
      }
      plan = await withPlannedDevice(projectRoot, plan, acquired, options);
    }
    emitPlanOnly(plan, state, options);
    return 0;
  }

  // @ref llp/0015-backend-selection-and-config.rfc.md §The selection — named, not taken.
  // Detection may say the cloud is the only route this host leaves; it may not spend the caller's
  // EAS credits on that finding. A flag or the config is a person's own choice and runs.
  if (implicitEas) {
    throw implicitEasRouteError(plan, options.platform);
  }

  if (options.deviceBackend !== 'eas' && plan.buildLocation?.runsOn === 'eas') {
    await assertEasProjectConfiguredAsync(projectRoot);
  }

  plan = await replaceUntrackedDevServerAsync(projectRoot, plan, orphan, options);
  if (bindsHere) {
    acquired = await acquireDevice(plan);
  }
  if (acquired) {
    plan = withDevice(plan, deviceIdOf(acquired.device));
  }

  // @ref llp/0010-agent-conventions.rfc.md §The `--json` error envelope
  // The plan is always emitted before anything runs — on the `cli:start_plan` event for a driving
  // agent, and as a table for a person. In `--json` mode it is *not* printed here: stdout is
  // reserved for the one object this run prints when it ends, which is either the plan with its
  // follow-ups or the error envelope. Printing the plan first and then running a dev server that
  // appends its log to the same stream is what made this command's output unparseable.
  emitStartPlan(plan, {
    mode: 'smart',
    print: options.json ? 'none' : 'text',
    followups: [],
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Where a build runs
  // On stderr, and before the first step, because this is the one thing that decides whether the
  // plan below is worth starting: a build that cannot run here fails many minutes in, at a compiler
  // error about a toolchain, and the command that does work is `eas build`. Said out loud even in
  // `--json` mode, where the plan carrying the same fact is not printed until the run is over.
  warnUnbuildable(plan);

  if (plan.devServerPort?.movedFrom != null) {
    warnPortMove(
      { busy: plan.devServerPort.movedFrom, to: plan.devServerPort.port, when: 'plan' },
      plan.devServerPort.movedFrom
    );
  }

  // The follow-ups of a run are the *dev server's*, and in `--json` mode they are computed after
  // it so they can name the port it actually took. A terminal cannot wait for that: the bundler
  // takes the screen and anything printed afterwards scrolls away with its output.
  if (!options.json) {
    reportFollowUps('dev', await resolveRunFollowUpsAsync(projectRoot, plan, options, PLANNED), {});
  }

  // @ref llp/0008-guardrails.rfc.md §The plan is announced, not negotiated — the plan was printed
  // above, and then it runs. `dev` was asked to get this app onto a device, and a build is how that
  // is done; there is no second act of consent, in a terminal or out of one. `--plan` is the run
  // that stops.
  const run = await executeDevPlanAsync(projectRoot, plan, state, options, acquired);

  if (options.json) {
    await reportRunResultAsync(projectRoot, run, options);
  }

  return 0;
}

async function resolveDevPlanAsync(
  projectRoot: string,
  state: ProjectState,
  options: DevOptions,
  acquireDevice: (draft: StartPlan) => Promise<AcquireResult | null>
) {
  const { plan: resolvedPlan, acquired: boundEarly } = await resolveStartPlanAsync(
    projectRoot,
    state,
    {
      acquireDevice,
      settings: options.settings,
      platform: options.platform,
      requestedPlatform: options.platform,
      open: options.open,
      lastBuild: readLastBuildRecord(projectRoot),
      requestedBackend: options.buildBackend,
      requestedTarget: options.runTarget,
      // @ref llp/0027-everything-on-eas.rfc.md
      deviceBackend: options.deviceBackend,
      fingerprintCache: options.fingerprintCache,
    }
  );
  // @ref llp/0015-backend-selection-and-config.rfc.md §The device backend
  const resolved =
    options.deviceBackendSource === 'config' && options.open
      ? { ...resolvedPlan, reasons: [...resolvedPlan.reasons, configSessionReason()] }
      : resolvedPlan;

  // @ref llp/0015-backend-selection-and-config.rfc.md §The plan approved is the plan run
  const { plan: forwardedPlan, dropped } = withForwardedExpoArgs(resolved, options.expoArgs);

  return { plan: forwardedPlan, acquired: boundEarly, dropped };
}

/** In `--json` mode, print the one object for a finished run. */
async function reportRunResultAsync(
  projectRoot: string,
  run: ExecutedDevPlan,
  options: DevOptions
): Promise<void> {
  // One object, when the run is over and there is something true to say about it.
  const ran = run.plan;
  // A run whose last step started no dev server (a forwarded `--no-bundler`) has nothing that
  // reported a port, so its follow-ups read the plan, as they do before a run.
  const followups = await resolveRunFollowUpsAsync(
    projectRoot,
    ran,
    options,
    run.devServer ? { phase: 'ran', devServer: run.devServer } : PLANNED
  );
  reportFollowUps('dev', followups, { json: true });
  Log.log(JSON.stringify({ ...ran, followups }, null, 2));
}

/** Print the `--plan` result with its follow-ups. */
function emitPlanOnly(plan: StartPlan, state: ProjectState, options: DevOptions): void {
  const followups = followUpsEnabled(options.followups)
    ? // The typed flag, not the resolved platform: this is the plan the caller asked for, and the
      // command that runs it has to ask for the same one (F103).
      buildStartPlanFollowUps(plan, state, options.platform, options.callerArgv, {
        eas: options.deviceBackend === 'eas',
      })
    : [];
  emitStartPlan(plan, { mode: 'plan', json: options.json, followups });
  reportFollowUps('dev', followups, { json: options.json });
}

/** Warn that the last step is not `expo start`, so the forwarded options were not passed on. */
function warnDroppedExpoArgs(plan: StartPlan, dropped: string[]): void {
  const last = plan.steps.at(-1);
  if (dropped.length && last) {
    const directCommand =
      last.argv[0] === 'expo'
        ? `${PROGRAM_PREFIX} ${last.argv.slice(1).join(' ')}`
        : `npx ${last.argv.join(' ')}`;
    Log.warn(
      `The plan ends with "${last.argv.join(' ')}" instead of "expo start", so these options were not passed on: ${dropped.join(' ')}. Run "${PROGRAM_PREFIX} start ${dropped.join(' ')}" once the app is installed, or pass them to "${directCommand}" yourself.`
    );
  }
}

/** True when the plan builds on EAS only because detection found no other route. */
function isImplicitEas(plan: StartPlan): boolean {
  return plan.buildLocation?.runsOn === 'eas' && plan.buildLocation.selection?.implicit === true;
}

/**
 * The callback the resolver runs for a native draft, and `devAsync` runs for a draft that builds.
 *
 * @ref llp/0035-one-device-per-worktree.rfc.md §How `dev` uses it
 * Only a plan reaches this with this project's dev-server lock live, and it answers null before
 * the binding is read: a run stopped on that lock before the probe (llp/0004 §A busy port). Then
 * only where this host runs the platform's device; nothing for `--eas`, whose device is a session;
 * nothing under `AGENT_CLI_NO_DEVICE`. A run then refuses a named `--port` that is taken, when the
 * draft serves, so no device is created for a run that then stops on the port. `--plan` inspects
 * the own binding and acquires nothing.
 */
function deviceCallbackFor(
  projectRoot: string,
  options: DevOptions,
  lock: DevServerLockInfo | null,
  claimedPort: number | null // a killed run's dev server's port, busy until this run replaces it
): (draft: StartPlan) => Promise<AcquireResult | null> {
  return async (draft) => {
    if (lock) {
      return null;
    }
    const platform = boundPlatform(options);
    if (platform == null) {
      return null;
    }
    if (options.mode === 'plan') {
      return options.device === undefined
        ? await inspectOwnDeviceAsync(projectRoot, platform)
        : null;
    }
    if (options.port != null && options.port !== claimedPort && draft.steps.some(isDevServerStep)) {
      const planned = await resolvePlannedPortAsync(options.port);
      if (!planned.bindable) {
        throw await portDemandedError(options.port, options.platform);
      }
    }
    const acquired = await acquireDeviceAsync(projectRoot, platform, {
      explicit: explicitRequestOf(options.device, options.callerArgv),
    });
    Log.progress(acquireLine(acquired));
    return acquired;
  };
}

/**
 * The platform this run binds a local device for, or null when it binds none: `--web`, `--eas`,
 * devices off, or a host that cannot run the platform's device, where `dev` serves for a device
 * somewhere else, as on main.
 */
function boundPlatform(options: DevOptions): DevicePlatform | null {
  const platform = options.platform;
  return (platform === 'ios' || platform === 'android') &&
    options.deviceBackend !== 'eas' &&
    !devicesDisabled() &&
    hostBindsPlatform(platform)
    ? platform
    : null;
}

/** `--device` on a run that binds no local device, which would drop the device it names. */
function deviceNotBindableError(options: DevOptions): CommandError {
  const why =
    options.platform === 'web'
      ? '--web serves the app to a browser, which needs no device'
      : devicesDisabled()
        ? 'AGENT_CLI_NO_DEVICE=1 turns every device off'
        : options.platform === 'ios'
          ? 'only macOS runs an iOS simulator'
          : 'this machine has no Android SDK';
  const command = rerunDevCommand(options.platform, withoutDeviceArgs(options.callerArgv));
  const error = new CommandError(
    'BAD_ARGS',
    `--device names a local device to bind, and ${why}, so nothing would use it.\nHow: remove --device, then run "${command}".`
  );
  error.suggestedCommand = command;
  return error;
}

/** `--plan`'s read of the own binding: the device as `reused` when it is up or down, else null. */
async function inspectOwnDeviceAsync(
  projectRoot: string,
  platform: DevicePlatform
): Promise<AcquireResult | null> {
  const inspection = await inspectBindingAsync(projectRoot, platform, localBackendOf(platform));
  return inspection.binding && (inspection.state === 'up' || inspection.state === 'not-up')
    ? { device: inspection.binding.device, justBooted: false, action: 'reused' }
    : null;
}

/** The `--plan` view: the steps pinned to the bound device, or the reason none is pinned yet. */
async function withPlannedDevice(
  projectRoot: string,
  plan: StartPlan,
  acquired: AcquireResult | null,
  options: DevOptions
): Promise<StartPlan> {
  const selectedPlatform = boundPlatform(options);
  const explicit = explicitRequestOf(options.device, options.callerArgv);
  if (selectedPlatform && explicit) {
    try {
      const { device, summary } = await previewExplicitDeviceAsync(
        projectRoot,
        selectedPlatform,
        explicit
      );
      return {
        ...withDevice(plan, deviceIdOf(device)),
        explicitDevice: { refuses: false, summary },
      };
    } catch (error) {
      if (!isExplicitChoiceRefusal(error)) throw error;
      return {
        ...plan,
        explicitDevice: {
          refuses: true,
          summary: error.message.split('\n')[0]!,
          how: error.suggestedCommand ?? null,
        },
      };
    }
  }
  if (acquired) {
    return withDevice(plan, deviceIdOf(acquired.device));
  }
  const platform = boundPlatform(options);
  return platform
    ? {
        ...plan,
        reasons: [
          ...plan.reasons,
          `The run will reuse or ${platform === 'ios' ? 'create a simulator' : 'start an emulator instance'} for this worktree, and pin the build steps to it.`,
        ],
      }
    : plan;
}

function configSessionReason(): string {
  return `The app runs on an EAS Simulator session because ${CONFIG_LOCATION} sets deviceBackend to "eas". A session bills until it stops: "${PROGRAM_PREFIX} dev:stop --eas" ends it, and --local runs on this machine instead.`;
}

/**
 * The stop for a plan whose EAS route nobody chose.
 *
 * @ref llp/0015-backend-selection-and-config.rfc.md §The selection
 * Exit 1 with the two ways out, like every other refusal of a command line that has not said
 * enough: the platform flag, `--eas` against `--local`. The plan is not run and nothing is spawned,
 * so nothing has been billed by the time this is read.
 */
function implicitEasRouteError(plan: StartPlan, platform: PlanPlatform): CommandError {
  const location = plan.buildLocation!;
  const error = new CommandError(
    'EAS_ROUTE_NOT_CHOSEN',
    [
      `This machine cannot build for ${platform}, and nothing asked for the build to run on EAS — so nothing ran.`,
      `Why: ${location.selection?.because ?? `this machine has no ${localTool(location.platform)}.`} A build on EAS and an EAS Simulator session use EAS credits, and this CLI spends them only when asked: with --eas on the command line, or "buildBackend": "eas" under expo.agent-cli in package.json.`,
      `How: run "${PROGRAM_PREFIX} dev --${platform} --eas" to build on EAS and run the app on an EAS Simulator session, or install ${localRequirement(location.platform)} and run "${PROGRAM_PREFIX} dev --${platform} --local" to build here. "${PROGRAM_PREFIX} dev --${platform} --plan" shows the steps either way.`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} dev --${platform} --eas`;
  return error;
}

/**
 * Warn, once, when the plan builds here and this machine cannot.
 *
 * @ref llp/0015-backend-selection-and-config.rfc.md §The selection
 * This is now the *rare* case, and the change is the point of the whole feature: detection routes
 * a build it knows cannot happen here to the cloud while the plan is being made, so a local plan
 * on a machine with no toolchain is one somebody asked for by name. The warning says who asked, so
 * the reader knows which line to change.
 *
 * Only for `missing`: `unknown` has established nothing about the machine, and a warning about a
 * toolchain that is probably installed is noise on every run that follows.
 */
function warnUnbuildable(plan: StartPlan): void {
  const location = plan.buildLocation;
  if (location?.runsOn !== 'local' || location.status !== 'missing') {
    return;
  }
  const tool = localTool(location.platform);
  const asked =
    location.selection?.source === 'flag'
      ? ' --local asked for this build to run here.'
      : location.selection?.source === 'config'
        ? ` The ${PROGRAM_NAME} config asks for this build to run here.`
        : '';
  Log.warn(
    `This plan builds ${LOCAL_WHERE} and this machine does not have ${tool}: ${location.detail}${asked} The build step will fail once it reaches the compiler. To build for ${location.platform} without ${tool}, run "${location.alternativeCommand}", which builds ${EAS_WHERE} and needs ${EAS_REQUIREMENT}.`
  );
}
