// @ref llp/0004-smart-start-and-project-state.rfc.md §Plan contract
// @ref llp/0030-one-device-per-agent.rfc.md §Every verb uses the claim
// What `@expo/agent-cli dev` does: probe the project, decide what must run, emit the plan, then
// (unless `--plan` stopped us) run its steps as subprocesses. The plain `expo start` wrapper is
// `@expo/agent-cli start`, whose dev-server runner and follow-ups this reuses.

import type { OpenAppOnEasReport } from './openAppEas';
import { outputTail } from '../deploy/parseOutput';
import { readLastLoggedDevServerPort, readPortArg } from '../devLock/port';
import { EXIT_OUTCOME_FAILED } from '../exitCodes';
import {
  buildStartPlanFollowUps,
  followUpsEnabled,
  reportFollowUps,
  resolveDevServerPort,
  type FollowUp,
} from '../followups';
import { Log } from '../log';
import { classifySubprocessFailure, lastNonEmptyLine } from '../needsHuman/detect';
import { assertEasProjectConfiguredAsync } from '../needsHuman/easProject';
import { needsHumanErrorFrom } from '../needsHuman/error';
import { emitStartPlan } from '../plan/emit';
import { event as planEvent } from '../plan/events';
import { readLastBuildRecord, recordLastBuildFingerprint } from '../plan/lastBuild';
import { resolveStartPlanAsync, type PlanDevices } from '../plan/resolveAsync';
import { isPlatformFlag } from '../plan/platformFlags';
import type { NativePlatform, PlanPlatform } from '../plan/types';
import { PROGRAM_NAME, PROGRAM_PREFIX } from '../programName';
import { defaultSmokePlatformAsync, smokeCommand } from '../smoke/suggest';
import { clearFingerprintMemo } from '../project/fingerprint';
import { clearFingerprintCache } from '../project/fingerprintCache';
import { probeProjectStateAsync } from '../project/probe';
import type { PlanStep, ProjectState, StartPlan } from '../project/types';
import { resolveStartFollowUpsAsync } from '../start/followUps';
import { runDevServerAsync, type DevServerRun } from '../start/startAsync';
import {
  localRequirement,
  localTool,
  EAS_REQUIREMENT,
  EAS_SIMULATOR_PROFILE,
  EAS_WHERE,
  LOCAL_WHERE,
} from '../toolchain/runsOn';
import { classifyEasFailure } from '../utils/easFailure';
import { ensureSimulatorProfileSync } from '../utils/easJson';
import { CommandError } from '../utils/errors';
import { runExpoAsync, spawnExpoAsync } from '../utils/expoCli';
import { isInteractive } from '../utils/interactive';
import type { SubprocessOutput } from '../utils/subprocess';
import {
  looksLikeWrapperCrash,
  wrapperCrashDetail,
  type WrapperCrashTool,
} from '../utils/wrapperCrash';
import { appReachedDevice } from './buildEvidence';
import { event as devEvent } from './events';
import {
  forwardedStepArgs,
  isDevServerStep,
  withDevServerPort,
  withForwardedExpoArgs,
  withPortArg,
} from './forwardedArgs';
import {
  defaultMetroPort,
  detectPortCollision,
  findFreePortAsync,
  formatPortMove,
  resolvePlannedPortAsync,
  type PortCollision,
} from './portCollision';
import type { DevOptions } from './resolveOptions';
import { easCommandPrefix } from '../utils/easCli';

/**
 * Probe the project, emit the plan, and run it.
 *
 * @returns 0 in `--plan` mode, otherwise the exit code of the first step that failed, or of the
 * last step when every step succeeded.
 */
export async function devAsync(projectRoot: string, options: DevOptions): Promise<number> {
  if (options.mode !== 'plan' && options.deviceBackend === 'eas') {
    await assertEasProjectConfiguredAsync(projectRoot);
  }

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — before the probe, because
  // the child does the probe: this run's whole job is to start that child and report on it.
  if (options.detach) {
    const { devDetachAsync } = require('./detachAsync') as typeof import('./detachAsync');
    return await devDetachAsync(projectRoot, options);
  }

  const state = await probeProjectStateAsync(projectRoot, {
    fingerprintCache: options.fingerprintCache,
  });
  const devices = planDevices(projectRoot, options);
  // A device the caller named is resolved first: a run boots it, so the presence probe below asks
  // that device, and a name that matches nothing stops `--plan` as it stops the run.
  if (options.device && devices && options.platform !== 'web') {
    await devices.runDevice(options.platform);
  }
  // @ref llp/0015-backend-selection-and-config.rfc.md §The selection
  // One call that folds in everything outside the project: the developer's config, the flags they
  // typed, this host and the toolchain probe. The backend is chosen **here**, before the plan is
  // printed, so the steps an agent approves are the steps that run — never swapped mid-run
  // (llp/0008 §Plan-with-cost dry run).
  const resolved = await resolveStartPlanAsync(projectRoot, state, {
    // The caller's own flag, which the resolver requires: the plan builds for this platform and
    // `expo start` opens the app on it — booting a simulator or an emulator when none is up, the
    // same way `expo run:ios` and `expo run:android` do.
    platform: options.platform,
    requestedPlatform: options.platform,
    open: options.open,
    lastBuild: readLastBuildRecord(projectRoot),
    requestedBackend: options.buildBackend,
    requestedTarget: options.runTarget,
    // @ref llp/0027-everything-on-eas.rfc.md — `--eas` puts the device on EAS too, which changes
    // the build profile, adds the tunnel, and lets the resolver ask EAS for a build it already has.
    deviceBackend: options.deviceBackend,
    fingerprintCache: options.fingerprintCache,
    devices,
  });

  // @ref llp/0015-backend-selection-and-config.rfc.md §The plan approved is the plan run
  // Here, before anything is printed. The options a caller typed for `expo start` used to be folded
  // in while the step ran, so `--plan --tunnel` printed a command without `--tunnel` and the run
  // passed it [observed — friction run 7, F71; live run S5].
  const { plan: forwardedPlan, dropped } = withForwardedExpoArgs(resolved, options.expoArgs);

  // @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port is not a step only a person can
  // complete — the port is picked here, before the plan is printed, and set on every step that
  // serves. Left to `expo run:*`, a busy port skips its dev server, deep-links the app to whatever
  // holds the port, and exits 0 [observed — live suite, 2026-10-05].
  const serving = forwardedPlan.steps.filter(isDevServerStep).at(-1);
  let plan: StartPlan = forwardedPlan;
  if (serving) {
    const planned = await resolvePlannedPortAsync(options.port);
    if (!planned.bindable && options.port != null && options.mode !== 'plan') {
      throw await portDemandedError(projectRoot, options.port, options.platform);
    }
    plan = {
      ...withDevServerPort(forwardedPlan, planned.port),
      // A port the plan probed is only the port that was free when the plan was printed. A named
      // `--port` is not picked, so nothing is said about it.
      reasons:
        options.mode === 'plan' && options.port == null
          ? [...forwardedPlan.reasons, 'The dev server port is picked again when the plan runs.']
          : forwardedPlan.reasons,
      devServerPort:
        options.port != null
          ? { port: planned.port, movedFrom: null, state: 'named', taken: !planned.bindable }
          : { port: planned.port, movedFrom: planned.movedFrom, state: 'picked' },
    };
  }

  if (dropped.length) {
    const last = plan.steps[plan.steps.length - 1]!;
    const directCommand =
      last.argv[0] === 'expo'
        ? `${PROGRAM_PREFIX} ${last.argv.slice(1).join(' ')}`
        : `npx ${last.argv.join(' ')}`;
    Log.warn(
      `The plan ends with "${last.argv.join(' ')}" instead of "expo start", so these options were not passed on: ${dropped.join(' ')}. Run "${PROGRAM_PREFIX} start ${dropped.join(' ')}" once the app is installed, or pass them to "${directCommand}" yourself.`
    );
  }

  // @ref llp/0009-smart-followups.rfc.md §Examples per command
  // `--plan` stops here, so its follow-ups are about the plan itself and the plan object is the
  // whole answer.
  if (options.mode === 'plan') {
    const followups = followUpsEnabled(options.followups)
      ? // The typed flag, not the resolved platform: this is the plan the caller asked for, and the
        // command that runs it has to ask for the same one (F103).
        buildStartPlanFollowUps(plan, state, options.platform)
      : [];
    emitStartPlan(plan, { mode: 'plan', json: options.json, followups });
    reportFollowUps('dev', followups, { json: options.json });
    return 0;
  }

  // @ref llp/0015-backend-selection-and-config.rfc.md §The selection — named, not taken.
  // Detection may say the cloud is the only route this host leaves; it may not spend the caller's
  // EAS credits on that finding. A flag or the config is a person's own choice and runs.
  if (plan.buildLocation?.runsOn === 'eas' && plan.buildLocation.selection?.implicit) {
    throw implicitEasRouteError(plan, options.platform);
  }

  if (options.deviceBackend !== 'eas' && plan.buildLocation?.runsOn === 'eas') {
    await assertEasProjectConfiguredAsync(projectRoot);
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
    reportFollowUps('dev', await resolveRunFollowUpsAsync(projectRoot, plan, options, null), {});
  }

  // @ref llp/0008-guardrails.rfc.md §The plan is announced, not negotiated — the plan was printed
  // above, and then it runs. `dev` was asked to get this app onto a device, and a build is how that
  // is done; there is no second act of consent, in a terminal or out of one. `--plan` is the run
  // that stops.
  const run = await executePlanAsync(projectRoot, plan, state, options);

  // @ref llp/0010-agent-conventions.rfc.md §The `--json` error envelope
  // A plan whose step failed has no result to report, so it reports a failure. It used to print
  // the plan object with its success-shaped follow-ups and leave only the exit code disagreeing —
  // and when the code was the Expo CLI's own `7`, an agent read a started dev server on stdout,
  // nothing on stderr, and "a person must finish this" from the exit code
  // [observed — friction run 2, 2026-08-23: `dev --yes --json --ios`, when `--yes` still existed].
  if (run.exitCode !== 0 && run.failure) {
    throw planStepFailedError(run.failure, stepOutputFor(options), run.exitCode, options.platform);
  }

  if (options.json) {
    // One object, when the run is over and there is something true to say about it.
    const ran = planAsRun(plan, run);
    const followups = await resolveRunFollowUpsAsync(projectRoot, ran, options, run.devServer);
    reportFollowUps('dev', followups, { json: true });
    Log.log(JSON.stringify({ ...ran, followups }, null, 2));
  }

  return run.exitCode;
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

/**
 * Where the output of the plan's subprocesses goes.
 *
 * `--json` owns stdout, so nothing a subprocess prints may reach it. A run with no terminal keeps
 * the output *and* prints it, because a step that stopped on a question the Expo CLI asked says so
 * on a stream that would otherwise go nowhere. A person watching gets the tools' own stdio, which
 * is what makes the bundler's keypress menu and its signals work.
 */
function stepOutputFor(options: DevOptions): SubprocessOutput {
  if (options.json) {
    return 'capture';
  }
  return isInteractive() ? 'inherit' : 'tee';
}

/** The step that ended a plan, and everything known about how it ended. */
interface StepFailure {
  step: PlanStep;
  /** The CLI arguments it actually ran with, which is what a reader has to reproduce. */
  args: string[];
  /** Whether this step is the one that starts the dev server. */
  devServerStep: boolean;
  /** What the step exited with, which is the `expo` CLI's own code. */
  exitCode: number;
  /**
   * Whether this failed step's build was recorded anyway, because its app reached a device.
   *
   * The one thing a reader of a failed `expo run:*` cannot see for themselves, and the one that
   * decides what the next command costs: fifteen minutes, or seconds (F121, `./buildEvidence.ts`).
   */
  buildRecorded: boolean;
  stdout: string;
  stderr: string;
  /**
   * The file that actually ran, when the step resolved one.
   *
   * Kept because it is the only fact that resolves a wrapper crash: the reader has to look at the
   * file under that name, not at the package they believe they installed (`wrapperCrash.ts`).
   * Null for a dev-server step, whose output nothing captures anyway.
   */
  binPath: string | null;
}

/** What one execution of a plan amounts to. */
interface PlanRun {
  exitCode: number;
  /** The dev server the run started, or null when it started none. */
  devServer: DevServerRun | null;
  /** The step that stopped the plan, or null when every step succeeded. */
  failure: StepFailure | null;
  /** The step that served, with the arguments it last ran with, or null when no step served. */
  serving: { index: number; args: string[] } | null;
}

async function executePlanAsync(
  projectRoot: string,
  plan: StartPlan,
  state: ProjectState,
  options: DevOptions
): Promise<PlanRun> {
  const output = stepOutputFor(options);
  let devServer: DevServerRun | null = null;
  let exitCode = 0;
  // @ref llp/0026-dev-owns-the-open.rfc.md — the open is armed once per plan, whatever the port
  // retry does: the second bind is the same dev server, not a second app to open.
  let openArmed = false;
  // @ref llp/0027-everything-on-eas.rfc.md §The open is a session — the EAS build the session
  // installs: the one the plan found, or the one this run's `eas build` step makes below.
  let easBuildId: string | null = plan.easBuild?.id ?? null;
  let serving: PlanRun['serving'] = null;

  for (const [index, step] of plan.steps.entries()) {
    let args = resolveStepArgs(step, options, index === plan.steps.length - 1);
    planEvent('start_plan_step', {
      id: step.id,
      argv: [step.argv[0]!, ...args],
      index: index + 1,
      total: plan.steps.length,
    });

    const devServerStep = isDevServerStep(step);
    // The open belongs to the `expo start` step alone: `expo run:*` installs and launches the app
    // itself, and a build step serves nothing to open.
    const opensApp = devServerStep && step.argv[1] === 'start' && shouldOpenApp(options);
    let stepRunning = false;
    const runStep = async (stepArgs: string[]) => {
      if (!devServerStep) {
        return await runStepAsync(projectRoot, step, stepArgs, output);
      }
      stepRunning = true;
      let openTask: Promise<OpenAppOnEasReport | null> | undefined;
      const ownsEasLifecycle = options.deviceBackend === 'eas' && opensApp;
      const interrupted = () => {
        stepRunning = false;
      };
      // Keep signal handling installed until the in-flight open and exact-ID cleanup finish.
      if (ownsEasLifecycle) {
        process.on('SIGINT', interrupted);
        process.on('SIGTERM', interrupted);
      }
      return await runDevServerAsync(projectRoot, stepArgs, {
        agentSkills: options.agentSkills,
        output,
        onDevServer: opensApp
          ? (server) => {
              if (openArmed) {
                return;
              }
              openArmed = true;
              // Open alongside Metro. A failed open must not stop it; the EAS receipt is
              // awaited at shutdown so an in-flight creation cannot escape cleanup.
              openTask = openAppForRunAsync(
                projectRoot,
                plan,
                options,
                server.url,
                () => stepRunning,
                easBuildId
              );
            }
          : undefined,
      }).finally(async () => {
        stepRunning = false;
        try {
          if (ownsEasLifecycle && openTask) {
            Log.progress('Finishing EAS session work before exiting.');
            const session = await openTask;
            if (session?.started && session.sessionId) {
              const { stopEasSessionAsync } =
                require('./openAppEas') as typeof import('./openAppEas');
              const stopped = await stopEasSessionAsync(projectRoot, session.sessionId);
              if (stopped.ok) {
                Log.progress(
                  `Stopped EAS Simulator session ${session.sessionId}, created by this run.`
                );
              } else {
                Log.warn(
                  `Could not stop EAS Simulator session ${session.sessionId}: ${stopped.reason}. Run "${easCommandPrefix()} simulator:stop --id ${session.sessionId}".`
                );
              }
            }
          }
        } finally {
          if (ownsEasLifecycle) {
            process.off('SIGINT', interrupted);
            process.off('SIGTERM', interrupted);
          }
        }
      });
    };

    // @ref llp/0027-everything-on-eas.rfc.md §The build is a simulator build
    // Said in the plan's reasons, and done here, right before the build that names the profile:
    // `eas build --profile development-simulator` against an `eas.json` without it stops at "profile
    // not found", after the upload. The write is three keys under `build`, and nothing else moves.
    if (step.id === 'eas-build' && options.deviceBackend === 'eas') {
      if (ensureSimulatorProfileSync(projectRoot)) {
        devEvent('eas_json_profile_added', { profile: EAS_SIMULATOR_PROFILE });
        Log.progress(`Added the "${EAS_SIMULATOR_PROFILE}" build profile to eas.json.`);
      }
    }

    let spawnedAt = Date.now();
    let result = await runStep(args);

    // @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol — the port carve-out. Checked
    // before the classifier below, because a busy port is the one stop in the Expo CLI's prompt
    // family that a machine can get past on its own. Whatever the exit code: `expo run:*` that
    // skipped its dev server exits 0.
    if (devServerStep) {
      const collision = portCollisionIn(projectRoot, args, result as DevServerRun, spawnedAt);
      if (collision) {
        // A port the caller named is a requirement, not a preference: silently moving the dev
        // server somewhere else would leave every command the caller had already written — and
        // every URL it had already printed — pointing at nothing.
        if (options.port != null) {
          throw await portDemandedError(projectRoot, options.port, options.platform);
        }
        const askedPort = readPortArg(args) ?? defaultMetroPort();
        // One retry, and so one per plan: no plan `decideStartPlan` makes has two dev-server steps.
        const retry = await retryOnFreePortAsync(collision, args, plan.devServerPort, runStep);
        if (retry) {
          args = retry.args;
          result = retry.result;
          spawnedAt = retry.spawnedAt;
        }
        // A collision still in the output after the retry fails the run, whatever the exit code:
        // `expo run:*` that skipped its dev server again exits 0 with nothing serving.
        if (portCollisionIn(projectRoot, args, result as DevServerRun, spawnedAt) != null) {
          planEvent('start_plan_step_exit', { id: step.id, code: result.exitCode });
          throw await portTakenAfterRetryError({
            step,
            args,
            askedPort,
            movedTo: retry ? readPortArg(retry.args) : null,
            exitCode: result.exitCode,
            callerArgv: options.detachArgv,
            platform: options.platform,
          });
        }
      }
      devServer = result as DevServerRun;
      serving = { index, args };
    }
    exitCode = result.exitCode;
    planEvent('start_plan_step_exit', { id: step.id, code: exitCode });

    if (
      exitCode !== 0 &&
      step.id === 'install' &&
      appReachedDevice(`${result.stdout}\n${result.stderr}`)
    ) {
      // @ref llp/0004-smart-start-and-project-state.rfc.md §A current build is not an installed app
      // The install step's job is the app on the device, and the output says it got there — so a
      // non-zero exit is about what `expo run:*` does *after* the install, which on a Mac without
      // the Automation grant is the AppleScript launch (observed 2026-09-04, and the reason
      // `installDevBuildAsync` judges this command by its result rather than its exit code). The
      // dev server still to come deep-links into the app itself, so the launch is not load-bearing
      // here. Failing the plan over it would stop the one step the caller was waiting for.
      Log.warn(
        `The ${step.argv[1]} install put the app on the device, then exited with ${exitCode} — most likely the launch, which the dev server's own open replaces. Continuing.`
      );
      exitCode = 0;
    } else if (exitCode !== 0) {
      // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
      // F121, and **before** the needs-human throw below rather than after it: `expo run:*` builds,
      // installs and launches in one subprocess, and a launch that failed is not a build that did.
      // A build whose app is on the device is a fact of its own, so it is recorded here, and the
      // step failure below is reported exactly as it was. The `macos-automation` recovery — start
      // the dev server and deep-link in — no longer walks back into the same fifteen-minute build,
      // which is what made that handoff wrong rather than merely incomplete.
      const buildRecorded = recordBuildReachedDevice(projectRoot, step, state, result);
      const failure: StepFailure = {
        step,
        args,
        devServerStep,
        exitCode,
        buildRecorded,
        stdout: result.stdout,
        stderr: result.stderr,
        // A dev-server step answers with a `DevServerRun`, which resolved no binary of its own.
        binPath: 'binPath' in result ? (result.binPath ?? null) : null,
      };
      // @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol, layer 3 — a step that
      // stopped because the Expo CLI needed an answer, or because macOS refused it a permission,
      // is not a failed command: it is a command waiting on a person. Nothing is captured in
      // `inherit` mode, so there is nothing to classify there.
      //
      assertNotNeedsHuman(failure, options.platform);
      // Every later step depends on this one having worked, so the plan stops here.
      return { exitCode, devServer, failure, serving };
    }

    recordBuildOf(projectRoot, step, state);
    if (step.id === 'eas-build' && options.deviceBackend === 'eas') {
      // The build that just finished is the newest finished one of its profile, and its id is what
      // the session installs. Asked of EAS rather than parsed out of the step, whose output went to
      // the terminal (`./openAppEas.ts` §findLatestSimulatorBuildIdAsync).
      const { findLatestSimulatorBuildIdAsync } =
        require('./openAppEas') as typeof import('./openAppEas');
      easBuildId = await findLatestSimulatorBuildIdAsync(
        projectRoot,
        resolveEasBuildPlatform(step)
      );
      if (easBuildId) {
        devEvent('eas_build_named', { buildId: easBuildId });
      } else {
        Log.warn(
          `The build finished, and "eas build:list" did not name it — so no EAS Simulator session will be started with it. Once "${easCommandPrefix()} build:list --build-profile ${EAS_SIMULATOR_PROFILE} --status finished" shows it, run this command again: the plan will find the build and skip straight to the session.`
        );
      }
    }
    // @ref llp/0023-fingerprint-caching.rfc.md §What invalidates an answer
    // After the step, not before: an install, a prebuild or a build has just changed the project,
    // and every fingerprint measured before it is a statement about the project as it was.
    //
    // **Both caches, not only the memo.** The pinned files are stamps of the project's own config
    // and lockfiles and say nothing about `ios/` or `android/`, so `expo prebuild` — which creates
    // them — moves nothing the record is keyed on. Its expiry would catch that eventually; dropping
    // the record here catches it now, for the one prebuild this CLI runs itself.
    clearFingerprintMemo(projectRoot);
    clearFingerprintCache(projectRoot);
  }

  return { exitCode, devServer, failure: null, serving };
}

/**
 * The collision a dev-server step's output reports, or null.
 *
 * A dev server that logged where it listens bound its port, so nothing in its output is a bind
 * collision. The log is read here rather than trusted from the port watch, because the watch stops
 * before a `run:*` build ends.
 *
 * A collision that names another port is not this step's: a `run:*` step's output carries Gradle
 * and Xcode output too, and an `EADDRINUSE` there is some other listener. A collision that names no
 * port (`Use port N instead?` alone) still counts.
 *
 * @param args the arguments the step ran with; its port is their `--port`, else Expo's default.
 * @param spawnedAt Epoch milliseconds the step was started at; an earlier log entry is not its own.
 */
function portCollisionIn(
  projectRoot: string,
  args: string[],
  result: DevServerRun,
  spawnedAt: number
): PortCollision | null {
  if (
    result.port?.source === 'log' ||
    readLastLoggedDevServerPort(projectRoot, { since: spawnedAt }) != null
  ) {
    return null;
  }
  const collision = detectPortCollision(`${result.stderr}\n${result.stdout}`);
  const stepPort = readPortArg(args) ?? defaultMetroPort();
  if (collision?.requestedPort != null && collision.requestedPort !== stepPort) {
    return null;
  }
  return collision;
}

/**
 * The plan as it ran: the serving step's last arguments, and the port the dev server ended on.
 *
 * The planned port is the hint and the retry can move it, so the `--json` object, like the
 * follow-ups, names the port that serves.
 */
function planAsRun(plan: StartPlan, run: PlanRun): StartPlan {
  const { serving } = run;
  if (!serving || !plan.devServerPort) {
    return plan;
  }
  const reported = run.devServer?.port;
  const port =
    reported && (reported.source === 'log' || reported.source === 'arg')
      ? reported.port
      : plan.devServerPort.port;
  return {
    ...plan,
    steps: plan.steps.map((step, index) =>
      index === serving.index ? { ...step, argv: [step.argv[0]!, ...serving.args] } : step
    ),
    devServerPort:
      port === plan.devServerPort.port
        ? plan.devServerPort
        : {
            port,
            movedFrom: plan.devServerPort.movedFrom ?? plan.devServerPort.port,
            state: 'picked',
          },
  };
}

/** What one step run amounts to, for the retry that may replace it. */
type StepResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The file that ran, when this step resolved one. @see StepFailure.binPath */
  binPath?: string | null;
};

/**
 * Start the dev server again on a port this CLI picked, after the Expo CLI stopped on a busy one.
 *
 * Only reached when the caller named no `--port`: they asked for "a dev server", and which port it
 * lands on is this command's to decide — which is exactly what the Expo CLI's own question is for,
 * and exactly what a run with no terminal cannot answer.
 *
 * The plan already gave the step a free port, so this covers the race between that bind test and
 * the dev server's own bind.
 *
 * @param planned the port the plan picked, which is the one the step asked for.
 * @returns the second run and the arguments it used, or null when no free port could be found.
 */
async function retryOnFreePortAsync(
  collision: PortCollision,
  args: string[],
  planned: StartPlan['devServerPort'],
  runStep: (stepArgs: string[]) => Promise<StepResult>
): Promise<{ args: string[]; result: StepResult; spawnedAt: number } | null> {
  const asked = planned?.port ?? collision.requestedPort ?? defaultMetroPort();
  // The CLI's own offer first: it walked to that port, so it is the one it would have taken.
  const free = await findFreePortAsync(collision.offeredPort ?? asked + 1);
  const busy = planned?.port ?? collision.requestedPort;

  devEvent('start_plan_port_retry', {
    busyPort: busy,
    offeredPort: collision.offeredPort,
    port: free,
  });

  if (free == null) {
    return null;
  }

  warnPortMove(
    { busy, to: free, when: 'retry' },
    planned?.movedFrom ?? planned?.port ?? collision.requestedPort
  );
  const retryArgs = withPortArg(args, free);
  const spawnedAt = Date.now();
  return { args: retryArgs, result: await runStep(retryArgs), spawnedAt };
}

/**
 * Say that the dev server is not on the port the caller expected.
 *
 * On stderr even in `--json` mode, where stdout is the one object this run prints, because every
 * URL the caller built on the expected port is stale. A `--detach` parent does not read this: it
 * compares the plan in the child's log with the lock the child publishes (llp/0004 §A busy port is
 * not a step only a person can complete).
 *
 * @param expected the port the caller expected, which the hint names.
 */
function warnPortMove(move: Parameters<typeof formatPortMove>[0], expected: number | null): void {
  Log.warn(
    `${formatPortMove(move)} ${
      expected == null
        ? 'Pass --port to name one yourself.'
        : `Pass --port ${expected} to require that port instead of moving, which fails when it is taken.`
    }`
  );
}

/**
 * The failure for a `--port` that was named and could not be had.
 *
 * An **outcome**, not a tool error and not a person: the command worked, and the thing it was asked
 * to do did not happen (llp/0010 §Exit codes). It never suggests the command that just failed —
 * running it again unchanged stops in the same place until the port is freed.
 */
async function portDemandedError(
  projectRoot: string,
  port: number,
  platform: PlanPlatform
): Promise<CommandError> {
  const { findPortListenerAsync } = require('./portListener') as typeof import('./portListener');
  const { readDevServerLockAsync } = require('../devLock') as typeof import('../devLock');
  const [listener, lock, free, defaultPlatform] = await Promise.all([
    findPortListenerAsync(port),
    readDevServerLockAsync(projectRoot),
    findFreePortAsync(port + 1),
    defaultSmokePlatformAsync(projectRoot),
  ]);
  // The smoke example needs a device platform, which the caller's `--web` is not.
  const smokePlatform = platform === 'web' ? defaultPlatform : platform;

  // The most useful special case: the process on that port is this project's own dev server, so
  // there is nothing to start and nothing to fix.
  const ours = lock != null && lock.port === port;
  const holder = listener
    ? `pid ${listener.pid}${listener.command ? ` (${listener.command})` : ''}`
    : 'a process this machine would not name';

  const error = new CommandError(
    'PORT_IN_USE',
    [
      `Port ${port} is taken, so no dev server was started on it.`,
      ours
        ? `Why: this project's own dev server is already on port ${port}, held by ${holder}. Nothing was started, because there is already one there.`
        : `Why: ${holder} is listening on it, and --port ${port} is a requirement rather than a preference — moving the dev server to another port would leave every URL and every command that names ${port} pointing at nothing.`,
      ours
        ? `How: use the dev server that is running ("${smokeCommand(smokePlatform)}" checks its bundle and its app), or stop it first with "${PROGRAM_PREFIX} dev:stop".`
        : `How: free the port with "${PROGRAM_PREFIX} dev:stop --port ${port} --force", which stops it only when it answers as an Expo dev server${listener ? ` and pid ${listener.pid} looks like one` : ''}${free == null ? '' : `, or start on a free port instead with "${PROGRAM_PREFIX} dev --${platform} --port ${free}"`}. Leaving --port out lets this command pick a free port on its own.`,
    ].join('\n')
  );
  // Never the command that just failed: it would stop in exactly the same place.
  error.suggestedCommand = ours
    ? smokeCommand(smokePlatform)
    : free == null
      ? `${PROGRAM_PREFIX} dev:stop --port ${port} --force`
      : `${PROGRAM_PREFIX} dev --${platform} --port ${free}`;
  error.exitCode = EXIT_OUTCOME_FAILED;
  return error;
}

/**
 * The failure for a dev-server step whose port was still taken after the one retry.
 *
 * An outcome (llp/0010 §Exit codes): the run's code is 20, and the Expo CLI's own code, which is 0
 * when `expo run:*` skipped its dev server, is named in the text. Never the command that just
 * failed: running it again repeats the same race. The port it names is the one the last attempt
 * lost, and the process on it is named the way `portDemandedError` names it.
 */
async function portTakenAfterRetryError(stop: {
  step: PlanStep;
  args: string[];
  askedPort: number;
  /** The port the retry moved the dev server to, or null when no free port was found. */
  movedTo: number | null;
  exitCode: number;
  /** The caller's own `dev` arguments, which the suggested command repeats with a free port. */
  callerArgv: string[];
  platform: PlanPlatform;
}): Promise<CommandError> {
  const { askedPort, movedTo } = stop;
  const { findPortListenerAsync } = require('./portListener') as typeof import('./portListener');
  const { isExpoDevServerAsync, looksLikeDevServerProcess } =
    require('./stopAsync') as typeof import('./stopAsync');
  const taken = movedTo ?? askedPort;
  const [listener, free, answersAsDevServer] = await Promise.all([
    findPortListenerAsync(taken),
    findFreePortAsync(taken + 1),
    isExpoDevServerAsync(taken),
  ]);
  const holder = listener
    ? `pid ${listener.pid}${listener.command ? ` (${listener.command})` : ''}`
    : 'a process this machine would not name';
  const invocation = `npx ${stop.step.argv[0]} ${stop.args.join(' ')}`;
  const why =
    movedTo != null
      ? `Why: the step asked for port ${askedPort}, which was taken, and the one retry moved it to port ${movedTo}, which ${holder} bound before the dev server did.`
      : `Why: ${holder} holds port ${askedPort}, and no free port was found to retry on.`;
  // The platform flag first, so the command reads as `dev --<platform> …` wherever it was typed.
  const separator = stop.callerArgv.indexOf('--');
  const rest = stop.callerArgv.filter(
    (arg, index) => !isPlatformFlag(arg) || (separator !== -1 && index > separator)
  );
  const onFreePort =
    free == null
      ? null
      : `${PROGRAM_PREFIX} dev --${stop.platform} ${withPortArg(rest, free).join(' ')}`;
  const forceStop =
    answersAsDevServer && listener != null && looksLikeDevServerProcess(listener)
      ? `${PROGRAM_PREFIX} dev:stop --port ${taken} --force`
      : null;
  const how = onFreePort
    ? `How: start on a free port with "${onFreePort}".`
    : forceStop
      ? `How: stop the dev server on port ${taken} with "${forceStop}", which stops it only when it answers as an Expo dev server, then run this command again.`
      : `How: stop ${holder} on port ${taken} yourself, then run this command again.`;
  const error = new CommandError(
    'PORT_TAKEN_AFTER_RETRY',
    [
      `No dev server was started: "${invocation}" stopped on a busy port and exited ${stop.exitCode}.`,
      why,
      how,
    ].join('\n')
  );
  const suggested = onFreePort ?? forceStop;
  if (suggested) {
    error.suggestedCommand = suggested;
  }
  error.exitCode = EXIT_OUTCOME_FAILED;
  return error;
}

/** Run a plan step that is not a dev server, in the output mode this run is in. */
async function runStepAsync(
  projectRoot: string,
  step: PlanStep,
  args: string[],
  output: SubprocessOutput
): Promise<StepResult> {
  if (step.argv[0] === 'eas') {
    return await runEasStepAsync(projectRoot, args, output);
  }
  if (output === 'inherit') {
    // Nothing is captured, so there is nothing for the wrapper-crash guard to read either.
    const exitCode = await runExpoAsync(projectRoot, args);
    return { exitCode, stdout: '', stderr: '', binPath: null };
  }
  const { cli, result } = await spawnExpoAsync(projectRoot, args, { output });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    binPath: cli.command,
  };
}

/**
 * Run one `eas` step of a plan.
 *
 * @ref llp/0015-backend-selection-and-config.rfc.md §Running an `eas` step
 * The EAS CLI is reached as a subprocess like every other member of the family (llp/0001
 * constraint 5), and it is resolved with the *throwing* resolver: a plan that chose the cloud
 * cannot do its job without it, so an unreachable CLI is an error rather than a step that quietly
 * does nothing. Since wave 18 that error is a last resort — the ladder's third rung runs the
 * published `eas-cli` through `npx`, so a machine that simply never installed it builds anyway, and
 * a cloud build is a step whose minutes make the first download's a rounding error. The output mode
 * is the plan's own — `inherit` is what makes the EAS CLI's own progress and its credential
 * questions reach the person watching.
 */
async function runEasStepAsync(
  projectRoot: string,
  args: string[],
  output: SubprocessOutput
): Promise<StepResult> {
  const { resolveEasCliOrThrow, easCliArgs } =
    require('../utils/easCli') as typeof import('../utils/easCli');
  const { spawnSubprocessAsync } =
    require('../utils/subprocess') as typeof import('../utils/subprocess');

  const easCli = resolveEasCliOrThrow(projectRoot);
  const result = await spawnSubprocessAsync(easCli.command, easCliArgs(easCli, args), {
    cwd: projectRoot,
    output,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    // The file, as this field promises, which on the runner rung is the runner. Nothing downstream
    // reads it except the wrapper-crash guard, and a wrapper crash is a claim about a binary
    // somebody installed under the name `eas` — never about `npx`, which reports its own failures.
    binPath: easCli.command,
  };
}

/**
 * Turn a step the registry recognises into the handoff it is.
 *
 * Two scenarios reach this today, and they need different prose. A prompt — `Input is required,
 * but 'npx expo' is in non-interactive mode.` — is the definition of exit 7: no re-run of the same
 * command gets past it, because what it is waiting for is an answer. A macOS Automation refusal is
 * the same shape for a different reason: the permission is granted by a person clicking a switch,
 * and until then `expo start --ios` cannot finish. Anything else the classifier recognises keeps
 * the registry row's own code and a message that names the step and quotes what the tool printed.
 *
 * @throws {NeedsHumanError} when the registry recognises what stopped the step.
 */
function assertNotNeedsHuman(failure: StepFailure, platform: PlanPlatform): void {
  const invocation = invocationOf(failure);
  const needsHuman = classifySubprocessFailure({
    // The registry is keyed by tool, and an `eas build` that stops for a login is a different
    // scenario from an `expo start` that stops for a prompt.
    tool: failure.step.argv[0] === 'eas' ? 'eas' : 'expo',
    invocation,
    exitCode: failure.exitCode,
    stdout: failure.stdout,
    stderr: failure.stderr,
  });
  if (!needsHuman) {
    return;
  }

  throw needsHumanErrorFrom(
    needsHuman,
    stopPromptFor(needsHuman.scenario, failure, invocation, platform)
  );
}

/** The what / why / how of one recognised stop, per scenario. */
function stopPromptFor(
  scenario: string,
  failure: StepFailure,
  invocation: string,
  platform: PlanPlatform
): { message: string; code?: string } {
  if (scenario === 'macos-automation') {
    // The *first* line of the crash, not the last: an unhandled rejection ends with Node's own
    // version footer, and quoting that under "What the tool printed" says nothing at all.
    const said = firstLineMatching(failure, /osascript|Apple events|\(-1743\)/i);
    return {
      message: [
        `The plan stopped at "${failure.step.id}": macOS refused "${invocation}" permission to control Simulator.app.`,
        `Why: the Expo CLI's launch step drives Simulator.app through AppleScript, and macOS refuses an application that has not been granted Automation permission. The Expo CLI does not catch that rejection, so it ends the whole process${failure.devServerStep ? ' — the dev server this run started exited with it, and nothing is listening for this project now' : ''}.`,
        `How: grant the permission in System Settings › Privacy & Security › Automation, then run this command again. To keep going without it, run "${PROGRAM_PREFIX} dev --${platform} --detach" — the build is recorded, so the next run starts the dev server and opens the app through "xcrun simctl openurl", which needs no grant.`,
        // @ref llp/0004 §Implemented in v1 — F121. The `How:` above is the
        // recovery that used to walk straight back into a fifteen-minute rebuild, because the build
        // this run finished was not recorded. It is now, and the reader is told so on the line that
        // sends them there.
        failure.buildRecorded
          ? `Note: the app it built is installed on the simulator already, so that build is recorded and "${PROGRAM_PREFIX} dev --${platform}" starts a dev server rather than building again.`
          : '',
        said ? `\nWhat the tool printed:\n${said}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  // @ref llp/0027-everything-on-eas.rfc.md §What EAS said — the EAS CLI said what was missing,
  // and the person-shaped half is the choice of account, not a question in a terminal.
  if (scenario === 'eas-project-unlinked') {
    const cause = classifyEasFailure(`${failure.stdout}\n${failure.stderr}`);
    return {
      message: [
        `The plan stopped at "${failure.step.id}": "${invocation}" refused, because this project is not linked to an EAS project.`,
        `Why: ${cause?.why ?? 'the EAS CLI reported that this project is not linked to an EAS project, so there is nothing on EAS to act on.'}`,
        `How: ${cause?.how ?? `link it once with "${easCommandPrefix()} init --account <account-name> --non-interactive", then run this command again.`}`,
      ].join('\n'),
    };
  }

  // A prompt is the one case where the *last* line is the answer: it is the question the CLI
  // stopped on, and nothing was printed after it.
  //
  // The port question is deliberately not among these any more: it is recognised before the
  // classifier runs and either retried on a free port or reported as an outcome
  // (`detectPortCollision`, `portDemandedError`). What is left here genuinely needs the person.
  //
  // **The code is the registry row's own, never one spelled here.** A plan runs steps of two CLIs
  // (llp/0015 §Running an `eas` step), and an `eas build` that stopped for a login is a different
  // scenario, with a different recovery, from an `expo start` that stopped for a prompt — which is
  // the whole reason the classifier is told which tool ran. Naming `EXPO_NEEDS_INPUT` here
  // flattened all four rows onto the Expo CLI's, so an agent branching on the code was told to
  // answer a question when what it had to do was sign in.
  const asked = lastNonEmptyLine(failure.stderr) ?? lastNonEmptyLine(failure.stdout);
  const cli = `${cliNameOf(failure.step)} CLI`;
  return {
    message: [
      `The plan stopped at "${failure.step.id}": "${invocation}" needed an answer and this run has no terminal to give one.`,
      `Why: the ${cli} asks before it does something it cannot decide, and a run with no terminal fails there instead of prompting. The question it asked is quoted below.`,
      `How: run the command above in a terminal once and answer it. If the answer is a value this CLI takes as a flag, pass that flag instead — "${PROGRAM_PREFIX} dev --help" lists them.`,
      asked ? `\nWhat it asked for:\n${asked}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/** The command a reader has to type to reproduce one step, exactly as it ran. */
function invocationOf(failure: StepFailure): string {
  return `npx ${failure.step.argv[0]} ${failure.args.join(' ')}`;
}

/** The CLI a step drives, as a reader would name it in a sentence. */
function cliNameOf(step: PlanStep): string {
  return step.argv[0] === 'eas' ? 'EAS' : 'Expo';
}

/** The first line of a captured failure that says something about the cause, or null for none. */
function firstLineMatching(failure: StepFailure, pattern: RegExp): string | null {
  return (
    `${failure.stderr}\n${failure.stdout}`
      .split('\n')
      .map((line) => line.trim())
      .find((line) => pattern.test(line)) ?? null
  );
}

/**
 * A step that failed and that nothing recognised.
 *
 * The plan object is not an answer here: it describes what the run *meant* to do, and printing it
 * with its follow-ups after a step failed told a driving agent that a dev server was up when none
 * was [observed — friction run 2, 2026-08-23]. The **forwarded exit code is kept**, per llp/0010
 * §Exit codes: inventing one would hide the code the tool actually reported. Only the payload
 * changes — from a success-shaped plan to the error envelope every other `--json` failure prints.
 */
function planStepFailedError(
  failure: StepFailure,
  output: SubprocessOutput,
  exitCode: number,
  platform: PlanPlatform
): CommandError {
  const invocation = invocationOf(failure);
  // @ref llp/0001-agentic-cli-on-expo-cli.rfc.md §Constraints — the process on the other side of
  // the spawn is whatever this machine has under that name, and sometimes it is a wrapper, a shim
  // or a stale link. Quoting *its* bytes under "What the tool printed" tells the reader the Expo or
  // EAS CLI said them, and an agent then acts on a sentence no Expo tool wrote (`wrapperCrash.ts`).
  // The guard needs captured output, so it can only fire in `capture` mode — which is the mode a
  // driving agent runs in, and the only one where anything is quoted at all.
  const tool: WrapperCrashTool = failure.step.argv[0] === 'eas' ? 'eas' : 'expo';
  const wrapperCrash =
    output === 'capture' &&
    failure.binPath != null &&
    looksLikeWrapperCrash({
      tool,
      exitCode: failure.exitCode,
      stdout: failure.stdout,
      stderr: failure.stderr,
    });
  // In `tee` and `inherit` mode the tool's own output already reached the terminal, and repeating
  // it would bury the three lines that say what to do.
  const tail = output === 'capture' ? outputTail(`${failure.stdout}${failure.stderr}`, 12) : '';
  // @ref llp/0027-everything-on-eas.rfc.md §What EAS said — an `eas` step that stopped on a
  // sentence this CLI recognises (an unlinked project, a signed-out machine) gets the fix as its
  // `How:`, not "run it yourself and read the output". Only what was captured can be read.
  const cause =
    tool === 'eas' && output !== 'inherit'
      ? classifyEasFailure(`${failure.stdout}\n${failure.stderr}`)
      : null;
  const error = new CommandError(
    'PLAN_STEP_FAILED',
    [
      `The plan stopped at "${failure.step.id}": "${invocation}" exited ${exitCode}.`,
      failure.devServerStep
        ? `Why: that step is the one that starts the dev server, and its process has exited, so no dev server is running for this project. The exit code above is the ${cliNameOf(failure.step)} CLI's own, not this command's.`
        : `Why: every later step of the plan depends on this one, so nothing after it ran. The exit code above is the ${cliNameOf(failure.step)} CLI's own, not this command's.`,
      // @ref llp/0004 §Implemented in v1 — said out loud because it is the
      // fact that decides what the next command costs, and nothing in the tool's own output says
      // it. Without this line the reader re-runs a step whose expensive half already worked.
      failure.buildRecorded
        ? `Note: the app it built is installed on the device, so that build is recorded — the next "${PROGRAM_PREFIX} dev --${platform}" starts a dev server for it instead of building again.`
        : '',
      cause ? `The EAS CLI said: ${cause.why}` : '',
      cause
        ? `How: ${cause.how}`
        : `How: run the command above yourself to see it fail with its whole output, or run "${PROGRAM_PREFIX} dev --${platform} --plan" to see the steps this plan is made of.`,
      wrapperCrash
        ? wrapperCrashDetail({ tool, exitCode: failure.exitCode }, failure.binPath!)
        : tail
          ? `\nWhat the tool printed:\n${tail}`
          : '',
    ]
      .filter(Boolean)
      .join('\n')
  );
  // The fix, when there is one, and never the command that just failed in that case (F67).
  error.suggestedCommand = cause?.command ?? invocation;
  error.exitCode = exitCode;
  return error;
}

/**
 * The follow-ups of a run, which are the dev server's.
 *
 * `devServer` is what the run learned about the server it started, and null before it has started
 * one. The port is only claimed when something reported it: `source: 'default'` means neither the
 * dev server nor the command line named one, and a URL built on that assumption is how this
 * command came to tell an agent to open a *different project's* app
 * [observed — friction run, 2026-08-23].
 *
 * The dev-server options a follow-up may quote are the **plan's last step**, never the caller's own
 * arguments. They are the same list for a plan that ends in `expo start`, and they differ for every
 * plan that does not: `--tunnel` cannot be forwarded to `expo run:ios`, and reading the raw
 * arguments once made it print a development-build URL naming a port the step did not serve on
 * [F120, observed — wave 29 live, 2026-08-27]. The plan is the argv that will run (llp/0015 §The
 * plan approved is the plan run), so it is the one thing a follow-up may read.
 */
async function resolveRunFollowUpsAsync(
  projectRoot: string,
  plan: StartPlan,
  options: DevOptions,
  devServer: DevServerRun | null
): Promise<FollowUp[]> {
  const planArgs = plan.steps.at(-1)?.argv.slice(1) ?? [];
  const port = devServer
    ? // After the run: what the dev server reported, and nothing when it reported nothing.
      devServer.port && devServer.port.source !== 'default'
      ? devServer.port.port
      : null
    : // Before it: the port the plan's own last step carries, or the one the Expo CLI defaults to.
      resolveDevServerPort(planArgs);

  return await resolveStartFollowUpsAsync(
    projectRoot,
    { ...options, expoArgs: planArgs },
    {
      expoGo: plan.target === 'expo-go',
      web: plan.target === 'web',
      eas: options.deviceBackend === 'eas',
      port,
      // Whatever the plan's own probe established, and null when it planned no build and probed
      // nothing. The cloud-build rung reads it to say why the cloud is still worth choosing.
      localBuild: plan.buildLocation?.status ?? null,
    }
  );
}

/**
 * Turn one plan step into `expo` CLI arguments.
 *
 * The plan owns the arguments of every step. The user's own `expo start` options are appended
 * to the last step only when that step is `expo start`, because `expo prebuild` and
 * `expo run:*` accept a different set of options.
 */
function resolveStepArgs(step: PlanStep, options: DevOptions, isLast: boolean): string[] {
  assertRunnableStep(step);
  // Idempotent, and folded in a second time on purpose: the plan the run reads already carries the
  // forwarded options (`withForwardedExpoArgs`, above), and a flag the argv holds is never added
  // twice. What this call is still for is the assertion above and a step that was rebuilt since.
  return forwardedStepArgs(step, options.expoArgs, { isLast }).args;
}

/**
 * This worktree's device for the plan: a run claims it, and `--plan` peeks, which reads the same
 * answer and claims, reaps and boots nothing (llp/0030 §Every verb uses the claim).
 *
 * Both resolve the device a run may boot or create, so `--plan` names the device the run builds
 * for and never stops where the run would boot one. A simulator the run creates has no id yet, so
 * its build is unpinned in the plan. No device pins nothing, but booted devices that other
 * worktrees hold stop the run with `DEVICES_ALL_CLAIMED`.
 * Absent for the EAS device and for a harness that must not touch this machine's devices
 * (`AGENT_CLI_NO_DEVICE`).
 */
function planDevices(projectRoot: string, options: DevOptions): PlanDevices | undefined {
  if (options.deviceBackend === 'eas' || process.env.AGENT_CLI_NO_DEVICE === '1') {
    return undefined;
  }
  const resolveAsync = (platform: NativePlatform, allowBoot: boolean) => {
    const { resolveClaimedDeviceAsync } =
      require('../device/claimedDevice') as typeof import('../device/claimedDevice');
    return resolveClaimedDeviceAsync({
      mode: options.mode === 'plan' ? 'peek' : 'claim',
      platform,
      projectRoot,
      explicit: options.device,
      allowBoot,
    });
  };
  return {
    async runDevice(platform) {
      const { expoRunDeviceArgumentAsync } =
        require('../device/installDevBuild') as typeof import('../device/installDevBuild');
      const { runDeviceRefusedError } =
        require('../plan/resolveAsync') as typeof import('../plan/resolveAsync');
      const resolved = await resolveAsync(platform, true);
      if (!resolved.ok) {
        // An unpinned `expo run:*` takes the first booted device, so it may run unpinned only when
        // no booted device is another worktree's: then the Expo CLI finds or creates one, as before.
        if (resolved.kind === 'no-device' && resolved.holders.length === 0) {
          return null;
        }
        throw resolved.error;
      }
      if (resolved.state == null) {
        return { argument: null, device: { action: 'create', id: null, name: null, state: null } };
      }
      const { action, id, name, state } = resolved;
      const argument = await expoRunDeviceArgumentAsync(projectRoot, platform, id);
      if (!argument.ok) {
        throw runDeviceRefusedError(platform, argument.reason);
      }
      return { argument: argument.value, device: { action, id, name, state } };
    },
    async bootedDevice(_projectRoot, platform) {
      const resolved = await resolveAsync(platform, false);
      return resolved.ok && resolved.state === 'booted'
        ? { deviceId: resolved.id, backend: resolved.backend }
        : null;
    },
  };
}

/**
 * Whether this run opens the app itself once the dev server is up.
 *
 * @ref llp/0026-dev-owns-the-open.rfc.md
 * Only for a native platform (`--web` is served, not opened), only when running rather than
 * planning, and not under `--no-open`. `AGENT_CLI_NO_DEVICE` turns it off for a harness whose
 * machines must not have their simulators touched — the stubbed e2e tier sets it.
 */
function shouldOpenApp(options: DevOptions): boolean {
  return (
    options.mode === 'run' &&
    options.open &&
    (options.platform === 'ios' || options.platform === 'android') &&
    // The harness switch is about *this machine's* devices. An EAS Simulator session is reached
    // through the `eas` on PATH, which the stubbed tier doubles, so the open runs there.
    (options.deviceBackend === 'eas' || process.env.AGENT_CLI_NO_DEVICE !== '1')
  );
}

/**
 * Open the app for a running dev server, and say what happened on stderr.
 *
 * Never throws and never stops the server: the app not opening is a warning with the `navigate`
 * door in it, because the dev server is still doing its job.
 */
async function openAppForRunAsync(
  projectRoot: string,
  plan: StartPlan,
  options: DevOptions,
  devServerUrl: string,
  stillWanted: () => boolean,
  easBuildId: string | null = null
): Promise<OpenAppOnEasReport | null> {
  const platform = options.platform as NativePlatform;
  if (options.deviceBackend === 'eas') {
    return await openAppOnEasForRunAsync(
      projectRoot,
      plan,
      platform,
      devServerUrl,
      stillWanted,
      easBuildId
    );
  }
  const { openAppOnDeviceAsync, openAppFailureLine } =
    require('./openApp') as typeof import('./openApp');
  try {
    const report = await openAppOnDeviceAsync(projectRoot, {
      platform,
      device: options.device,
      expoGo: plan.target === 'expo-go',
      devServerUrl,
      stillWanted,
      interactive: isInteractive(),
    });
    if (report.opened) {
      Log.progress(
        `Opened the app on the ${platform === 'ios' ? 'iOS simulator' : 'Android device'}${
          report.booted ? ' it booted' : ''
        }.`
      );
    } else if (stillWanted()) {
      Log.warn(openAppFailureLine(platform, report.reason ?? 'no reason was given'));
    }
  } catch (error: unknown) {
    // `openAppOnDeviceAsync` promises not to throw; this guard is for the promise breaking.
    Log.warn(
      `The app was not opened: ${error instanceof Error ? error.message.split('\n', 1)[0] : String(error)}`
    );
  }
  return null;
}

/**
 * Open the app on an EAS Simulator session for a running dev server, and say what happened.
 *
 * @ref llp/0027-everything-on-eas.rfc.md §The open is a session
 * The same contract as the local open: never throws, never stops the server, and a session that
 * was started says so with the command that stops it — it bills until then.
 */
async function openAppOnEasForRunAsync(
  projectRoot: string,
  plan: StartPlan,
  platform: NativePlatform,
  devServerUrl: string,
  stillWanted: () => boolean,
  easBuildId: string | null
): Promise<OpenAppOnEasReport | null> {
  const { openAppOnEasAsync, openAppOnEasFailureLine } =
    require('./openAppEas') as typeof import('./openAppEas');
  try {
    const report = await openAppOnEasAsync(projectRoot, {
      platform,
      expoGo: plan.target === 'expo-go',
      devServerUrl,
      buildId: easBuildId,
      stillWanted,
    });
    if (report.opened && stillWanted()) {
      Log.progress(
        `Opened the app on EAS Simulator session ${report.sessionId ?? '(id unknown)'}${
          report.started ? ', started by this run' : ', which was already up'
        }.${report.sessionUrl ? ` Watch it at ${report.sessionUrl}.` : ''} ${
          report.started
            ? `This run stops the session when the dev server exits. Use Ctrl-C or "${PROGRAM_PREFIX} dev:stop --eas".`
            : `It bills until "${PROGRAM_PREFIX} dev:stop --eas".`
        }`
      );
    } else if (stillWanted()) {
      Log.warn(openAppOnEasFailureLine(platform, report.reason ?? 'no reason was given'));
    }
    return report;
  } catch (error: unknown) {
    // `openAppOnEasAsync` promises not to throw; this guard is for the promise breaking.
    Log.warn(
      `The app was not opened on EAS: ${error instanceof Error ? error.message.split('\n', 1)[0] : String(error)}`
    );
  }
  return null;
}

/** The platform an `eas build` step builds for, read off its argv. */
function resolveEasBuildPlatform(step: PlanStep): NativePlatform {
  const index = step.argv.indexOf('--platform');
  return step.argv[index + 1] === 'android' ? 'android' : 'ios';
}

/**
 * Record what a successful `expo run:*` built, so the next run can skip the build.
 *
 * The hash comes from the probe, meaning it describes the project as it was *before* prebuild
 * ran. That is the same hash the next probe computes for an unchanged project, which is what
 * makes the comparison in `decideStartPlan` work.
 *
 * The probe's `sources` go in with it, because a hash alone lets a later `@expo/agent-cli impact` say the
 * native surface changed and never what changed (llp/0011 §The record has to hold the sources).
 * They are already in hand: the probe computed them to get the hash.
 */
function recordBuildOf(projectRoot: string, step: PlanStep, state: ProjectState): void {
  const platform = resolveBuildPlatform(step);
  if (platform && state.fingerprint.hash) {
    recordLastBuildFingerprint(projectRoot, platform, {
      hash: state.fingerprint.hash,
      sources: state.fingerprint.sources ?? null,
    });
  }
}

/**
 * Record the build of a step that **failed**, when its own output shows the app reached a device.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
 * The other half of {@link recordBuildOf}, and the whole of F121. `expo run:*` is one subprocess
 * that builds, installs and launches, so its exit code is the *launch's* answer as often as the
 * compiler's — and a plan that rebuilds because the launch failed spends fifteen minutes to change
 * nothing. What is read is the install (`./buildEvidence.ts`), because the record is a claim about
 * the app on a device rather than about a binary in a build directory.
 *
 * @returns whether a build was recorded, which is what the failure report has to say out loud.
 */
function recordBuildReachedDevice(
  projectRoot: string,
  step: PlanStep,
  state: ProjectState,
  result: StepResult
): boolean {
  if (resolveBuildPlatform(step) == null) {
    return false;
  }
  if (!appReachedDevice(`${result.stdout}\n${result.stderr}`)) {
    return false;
  }
  recordBuildOf(projectRoot, step, state);
  // Only when something was written: a project with no fingerprint records nothing, and a report
  // that promised the next plan would skip the build would be promising the opposite of the truth.
  return state.fingerprint.hash != null;
}

function resolveBuildPlatform(step: PlanStep): NativePlatform | null {
  if (step.argv[0] !== 'expo') {
    // @ref llp/0015-backend-selection-and-config.rfc.md §What the EAS route is made of
    // Deliberately not `eas build`. The record answers "does the app **installed on a device**
    // match this project", and a cloud build ends in an artifact that nothing here has installed.
    // Recording it would mark the next plan fresh against a build no device is running.
    return null;
  }
  if (step.argv[1] === 'run:ios') {
    return 'ios';
  }
  return step.argv[1] === 'run:android' ? 'android' : null;
}

/** The CLIs a plan step may invoke. Everything else is a step this version cannot run. */
const RUNNABLE_CLIS = ['expo', 'eas'];

/**
 * A plan step runs the `expo` CLI or the `eas` one. This guard turns a step for any other
 * (`expo-doctor`, `fingerprint`) into a clear error instead of a wrong invocation.
 */
function assertRunnableStep(step: PlanStep): void {
  if (!RUNNABLE_CLIS.includes(step.argv[0]!)) {
    throw new CommandError(
      'UNSUPPORTED_PLAN_STEP',
      `Cannot run the plan step "${step.id}": it invokes "${step.argv[0]}", and this version of ${PROGRAM_NAME} only runs the ${RUNNABLE_CLIS.map((cli) => `"${cli}"`).join(' and ')} CLIs. Update ${PROGRAM_NAME}, or run the step yourself with "npx ${step.argv.join(' ')}".`
    );
  }
}
