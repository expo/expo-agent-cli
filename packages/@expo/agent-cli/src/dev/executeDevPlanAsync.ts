// @ref llp/0004-smart-start-and-project-state.rfc.md §Plan contract
import { outputTail } from '../deploy/parseOutput';
import { type AcquireResult } from '../deviceBinding';
import { withLeaseExtendedAsync } from '../deviceBinding/renew';
import type { RunLock } from '../devLock';
import { Log } from '../log';
import { classifySubprocessFailure } from '../needsHuman/detect';
import { needsHumanErrorFrom } from '../needsHuman/error';
import { lastNonEmptyLine } from '../needsHuman/promptShape';
import { event as planEvent } from '../plan/events';
import { recordLastBuildFingerprint } from '../plan/lastBuild';
import type { NativePlatform, PlanPlatform } from '../plan/types';
import { PROGRAM_NAME, PROGRAM_PREFIX } from '../programName';
import { clearFingerprintMemo } from '../project/fingerprint';
import { clearFingerprintCache } from '../project/fingerprintCache';
import type { PlanStep, ProjectState, StartPlan } from '../project/types';
import { type DevServerRun } from '../start/startAsync';
import { dropEasNoneEntry } from '../status/easBuilds';
import { EAS_SIMULATOR_PROFILE } from '../toolchain/runsOn';
import { easCommandPrefix } from '../utils/easCli';
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
import { isDevServerStep } from './forwardedArgs';
import { type DevOptions } from './resolveOptions';
import { DevServerStepRunner } from './runDevServerStep';
import { withRunAsync, type RunSteps } from './runSteps';
import type { DevRun } from './devRun';

export interface ExecutedDevPlan {
  /** The final plan, including the serving step's actual arguments and port when known. */
  plan: StartPlan;
  /** The serving step's result, or null when no serving step ran. */
  devServer: DevServerRun | null;
}

interface ServingStep {
  index: number;
  args: string[];
  result: DevServerRun;
}

type PlanOutcome =
  | { status: 'completed'; serving: ServingStep | null }
  | { status: 'failed'; failure: StepFailure };

type RunScope = { lock: RunLock; steps: RunSteps };

interface StepFailure {
  step: PlanStep;
  args: string[];
  devServerStep: boolean;
  exitCode: number;
  buildRecorded: boolean;
  stdout: string;
  stderr: string;
  binPath: string | null;
}

type StepResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  binPath?: string | null;
};

/**
 * Execute the announced plan's argv under one run scope. Report ordinary failures after it closes.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §Dev-server lock
 */
export async function executeDevPlanAsync(
  projectRoot: string,
  plan: StartPlan,
  state: ProjectState,
  options: DevOptions,
  acquired: AcquireResult | null,
  owned: DevRun
): Promise<ExecutedDevPlan> {
  const output = stepOutputFor(options);
  const server = new DevServerStepRunner(projectRoot, plan, options, acquired, output);
  const outcome = await withRunAsync(
    projectRoot,
    plan,
    server.easPlatform,
    (lock, steps) =>
      runPlanStepsAsync(projectRoot, plan, state, options, output, server, { lock, steps }),
    owned
  );
  if (outcome.status === 'failed') {
    const { failure } = outcome;
    throw planStepFailedError(failure, output, failure.exitCode, options.platform);
  }
  return {
    plan: planAsRun(plan, outcome.serving),
    devServer: outcome.serving?.result ?? null,
  };
}

async function runPlanStepsAsync(
  projectRoot: string,
  plan: StartPlan,
  state: ProjectState,
  options: DevOptions,
  output: SubprocessOutput,
  server: DevServerStepRunner,
  scope: RunScope
): Promise<PlanOutcome> {
  // @ref llp/0027-everything-on-eas.rfc.md §The open is a session
  let easBuildId = plan.easBuild?.id ?? null;
  let serving: ServingStep | null = null;
  for (const [index, step] of plan.steps.entries()) {
    scope.steps.assertNotInterrupted();
    assertRunnableStep(step);
    let args = step.argv.slice(1);
    planEvent('start_plan_step', {
      id: step.id,
      argv: [step.argv[0]!, ...args],
      index: index + 1,
      total: plan.steps.length,
    });
    prepareEasBuildStep(projectRoot, step, options);
    const devServerStep = isDevServerStep(step);
    let result: StepResult;
    if (devServerStep) {
      const attempt = await server.runAsync(step, args, easBuildId, scope);
      serving = { index, ...attempt };
      args = attempt.args;
      result = attempt.result;
    } else {
      result = await scope.steps.stepAsync((signal) =>
        withLeaseExtendedAsync(projectRoot, () =>
          runStepAsync(projectRoot, step, args, output, signal)
        )
      );
      scope.steps.assertNotInterrupted();
    }
    planEvent('start_plan_step_exit', { id: step.id, code: result.exitCode });
    const failure = settleStepFailure(
      projectRoot,
      step,
      state,
      {
        args,
        devServerStep,
        ...result,
      },
      options.platform
    );
    if (failure) return { status: 'failed', failure };
    recordBuildOf(projectRoot, step, state);
    if (step.id === 'eas-build') {
      dropEasNoneEntry(projectRoot, resolveEasBuildPlatform(step));
      if (options.deviceBackend === 'eas') {
        easBuildId = await findBuiltEasIdAsync(projectRoot, step);
      }
    }
    // @ref llp/0023-fingerprint-caching.rfc.md §What invalidates an answer
    clearFingerprintMemo(projectRoot);
    clearFingerprintCache(projectRoot);
  }
  return { status: 'completed', serving };
}

// @ref llp/0027-everything-on-eas.rfc.md §The build is a simulator build
function prepareEasBuildStep(projectRoot: string, step: PlanStep, options: DevOptions): void {
  if (step.id !== 'eas-build') return;
  dropEasNoneEntry(projectRoot, resolveEasBuildPlatform(step));
  if (options.deviceBackend === 'eas' && ensureSimulatorProfileSync(projectRoot)) {
    devEvent('eas_json_profile_added', { profile: EAS_SIMULATOR_PROFILE });
    Log.progress(`Added the "${EAS_SIMULATOR_PROFILE}" build profile to eas.json.`);
  }
}

function settleStepFailure(
  projectRoot: string,
  step: PlanStep,
  state: ProjectState,
  run: StepResult & { args: string[]; devServerStep: boolean },
  platform: PlanPlatform
): StepFailure | null {
  if (run.exitCode === 0) return null;
  if (step.id === 'install' && appReachedDevice(`${run.stdout}\n${run.stderr}`)) {
    Log.warn(
      `The ${step.argv[1]} install put the app on the device, then exited with ${run.exitCode} — most likely the launch, which the dev server's own open replaces. Continuing.`
    );
    return null;
  }
  const failure: StepFailure = {
    ...run,
    step,
    buildRecorded: recordBuildReachedDevice(projectRoot, step, state, run),
    binPath: run.binPath ?? null,
  };
  assertNotNeedsHuman(failure, platform);
  return failure;
}

async function findBuiltEasIdAsync(projectRoot: string, step: PlanStep): Promise<string | null> {
  const { findLatestSimulatorBuildIdAsync } =
    require('./openAppEas') as typeof import('./openAppEas');
  const buildId = await findLatestSimulatorBuildIdAsync(projectRoot, resolveEasBuildPlatform(step));
  if (buildId) {
    devEvent('eas_build_named', { buildId });
  } else {
    Log.warn(
      `The build finished, and "eas build:list" did not name it — so no EAS Simulator session will be started with it. Once "${easCommandPrefix()} build:list --build-profile ${EAS_SIMULATOR_PROFILE} --status finished" shows it, run this command again: the plan will find the build and skip straight to the session.`
    );
  }
  return buildId;
}

function planAsRun(plan: StartPlan, serving: ServingStep | null): StartPlan {
  if (!serving || !plan.devServerPort) {
    return plan;
  }
  const reported = serving.result.port;
  const port =
    reported && (reported.source === 'reported' || reported.source === 'arg')
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

// The Expo CLI's interactive Metro menu needs inherited terminal stdio.
function stepOutputFor(options: DevOptions): SubprocessOutput {
  if (options.json) {
    return 'capture';
  }
  return isInteractive() ? 'inherit' : 'tee';
}

async function runStepAsync(
  projectRoot: string,
  step: PlanStep,
  args: string[],
  output: SubprocessOutput,
  signal: AbortSignal
): Promise<StepResult> {
  if (step.argv[0] === 'eas') {
    return await runEasStepAsync(projectRoot, args, output, signal);
  }
  if (output === 'inherit') {
    const exitCode = await runExpoAsync(projectRoot, args, { signal });
    return { exitCode, stdout: '', stderr: '', binPath: null };
  }
  const { cli, result } = await spawnExpoAsync(projectRoot, args, { output, signal });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    binPath: cli.command,
  };
}

// @ref llp/0015-backend-selection-and-config.rfc.md §Running an `eas` step
async function runEasStepAsync(
  projectRoot: string,
  args: string[],
  output: SubprocessOutput,
  signal: AbortSignal
): Promise<StepResult> {
  const { resolveEasCliOrThrow, easCliArgs } =
    require('../utils/easCli') as typeof import('../utils/easCli');
  const { spawnSubprocessAsync } =
    require('../utils/subprocess') as typeof import('../utils/subprocess');

  const easCli = resolveEasCliOrThrow(projectRoot);
  const result = await spawnSubprocessAsync(easCli.command, easCliArgs(easCli, args), {
    cwd: projectRoot,
    output,
    signal,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    binPath: easCli.command,
  };
}

function assertNotNeedsHuman(failure: StepFailure, platform: PlanPlatform): void {
  const invocation = invocationOf(failure);
  const needsHuman = classifySubprocessFailure({
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
        // @ref llp/0004-smart-start-and-project-state.rfc.md §Implemented in v1 (F121)
        failure.buildRecorded
          ? `Note: the app it built is installed on the simulator already, so that build is recorded and "${PROGRAM_PREFIX} dev --${platform}" starts a dev server rather than building again.`
          : '',
        said ? `\nWhat the tool printed:\n${said}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  // @ref llp/0027-everything-on-eas.rfc.md §What EAS said
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

  // The Expo CLI appends the required question to its non-interactive error.
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

function invocationOf(failure: StepFailure): string {
  return `npx ${failure.step.argv[0]} ${failure.args.join(' ')}`;
}

function cliNameOf(step: PlanStep): string {
  return step.argv[0] === 'eas' ? 'EAS' : 'Expo';
}

function firstLineMatching(failure: StepFailure, pattern: RegExp): string | null {
  return (
    `${failure.stderr}\n${failure.stdout}`
      .split('\n')
      .map((line) => line.trim())
      .find((line) => pattern.test(line)) ?? null
  );
}

// @ref llp/0010-agent-conventions.rfc.md §Exit codes
function planStepFailedError(
  failure: StepFailure,
  output: SubprocessOutput,
  exitCode: number,
  platform: PlanPlatform
): CommandError {
  const invocation = invocationOf(failure);
  // @ref llp/0001-agentic-cli-on-expo-cli.rfc.md §Constraints
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
  const tail = output === 'capture' ? outputTail(`${failure.stdout}${failure.stderr}`, 12) : '';
  // @ref llp/0027-everything-on-eas.rfc.md §What EAS said
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
      // @ref llp/0004-smart-start-and-project-state.rfc.md §Implemented in v1 (F121)
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
  error.suggestedCommand = cause?.command ?? invocation;
  error.exitCode = exitCode;
  return error;
}

function resolveEasBuildPlatform(step: PlanStep): NativePlatform {
  const index = step.argv.indexOf('--platform');
  return step.argv[index + 1] === 'android' ? 'android' : 'ios';
}

// @ref llp/0011-impact-and-freshness.rfc.md §The record has to hold the sources
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
 * `expo run:*` can fail at launch after the app was installed. Use the install evidence.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §Implemented in v1 (F121)
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
  return state.fingerprint.hash != null;
}

function resolveBuildPlatform(step: PlanStep): NativePlatform | null {
  if (step.argv[0] !== 'expo') {
    // @ref llp/0015-backend-selection-and-config.rfc.md §What the EAS route is made of
    return null;
  }
  if (step.argv[1] === 'run:ios') {
    return 'ios';
  }
  return step.argv[1] === 'run:android' ? 'android' : null;
}

const RUNNABLE_CLIS = ['expo', 'eas'];

function assertRunnableStep(step: PlanStep): void {
  if (!RUNNABLE_CLIS.includes(step.argv[0]!)) {
    throw new CommandError(
      'UNSUPPORTED_PLAN_STEP',
      `Cannot run the plan step "${step.id}": it invokes "${step.argv[0]}", and this version of ${PROGRAM_NAME} only runs the ${RUNNABLE_CLIS.map((cli) => `"${cli}"`).join(' and ')} CLIs. Update ${PROGRAM_NAME}, or run the step yourself with "npx ${step.argv.join(' ')}".`
    );
  }
}
