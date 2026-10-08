// @ref llp/0015-backend-selection-and-config.rfc.md §The plan approved is the plan run
// @ref llp/0021-honest-reports.rfc.md §How they show up
// Folding the `expo start` options a caller typed into the plan that gets printed.
//
// `@expo/agent-cli dev` forwards what it does not own to the `expo start` its plan ends with, and it used to
// do that *while running the step* — after the plan had been emitted. So `dev --plan --json
// --tunnel` printed `argv: ["expo","start","--go"]` and the run executed
// `expo start --go --port 8190 --tunnel` [observed — friction run 7, F71; live run S5]. A plan
// that under-reports the command it will run is the one thing llp/0015 §The plan approved is the
// plan run forbids: the person or agent who approved it approved something else.
//
// The fix is ordering, not new behaviour. The forwarded options are resolved onto the plan's own
// steps *before* anything is printed, so the plan object, the `cli:start_plan` event, the
// confirmation table and the subprocess all read from the same argv.

import { isPlatformFlag } from '../plan/platformFlags';
import type { PlanStep, StartPlan } from '../project/types';

/** What one step runs with, once the caller's own `expo start` options are folded in. */
export interface ForwardedStepArgs {
  /** The step's arguments, without the CLI name. */
  args: string[];
  /**
   * Options that were **not** passed on, because this step is not `expo start`.
   *
   * A plan that ends in `expo prebuild` or `expo run:*` has nothing to forward to, and dropping a
   * flag silently is what made an unknown option read as though it had been understood
   * [friction run 5, F48-3]. Platform flags are not counted: they were already acted on, by
   * choosing the platform the step builds for.
   */
  dropped: string[];
}

/**
 * The arguments a step runs with.
 *
 * Pure, so the one rule that is easy to get wrong is testable: a flag the plan already sets is not
 * added a second time, and only the **last** step of a plan is the one the caller's options belong
 * to — the earlier ones are prebuilds and installs.
 */
export function forwardedStepArgs(
  step: PlanStep,
  expoArgs: readonly string[],
  { isLast }: { isLast: boolean }
): ForwardedStepArgs {
  const args = step.argv.slice(1);
  if (!isLast || expoArgs.length === 0) {
    return { args, dropped: [] };
  }
  if (step.argv[0] !== 'expo' || step.argv[1] !== 'start') {
    return { args, dropped: expoArgs.filter((arg) => !isPlatformFlag(arg)) };
  }
  return { args: [...args, ...expoArgs.filter((arg) => !args.includes(arg))], dropped: [] };
}

/**
 * The same plan, with the caller's `expo start` options on the step that will receive them.
 *
 * @returns the plan and whatever could not be forwarded, for the caller to say out loud.
 */
export function withForwardedExpoArgs(
  plan: StartPlan,
  expoArgs: readonly string[]
): { plan: StartPlan; dropped: string[] } {
  if (expoArgs.length === 0 || plan.steps.length === 0) {
    return { plan, dropped: [] };
  }
  const lastIndex = plan.steps.length - 1;
  let dropped: string[] = [];
  const steps = plan.steps.map((step, index) => {
    const resolved = forwardedStepArgs(step, expoArgs, { isLast: index === lastIndex });
    if (resolved.dropped.length) {
      dropped = resolved.dropped;
    }
    return { ...step, argv: [step.argv[0]!, ...resolved.args] };
  });
  return { plan: { ...plan, steps }, dropped };
}

/**
 * Whether this step starts the dev server, and so runs through the `@expo/agent-cli start` wrapper:
 * `expo start`, or an `expo run:*` that serves.
 *
 * `eas build` finishes with an artifact and starts nothing. The install step of an `*-install`
 * plan passes `--no-bundler` (llp/0004 §A current build is not an installed app): running it
 * through the dev-server runner would publish a lock naming a port nothing will listen on, for as
 * long as the install takes, and every reader of that lock (`status`, `smoke`, `dev:stop`, a
 * `--detach` parent waiting on another port) would be told about a dev server that does not exist.
 */
export function isDevServerStep(step: PlanStep): boolean {
  if (step.argv[0] !== 'expo' || step.argv.includes('--no-bundler')) {
    return false;
  }
  const command = step.argv[1];
  return command === 'start' || command === 'run:ios' || command === 'run:android';
}

/**
 * The options without `--port`, which `dev` resolves itself and sets on every step that serves.
 *
 * Only before a `--` separator, as `resolvePort` reads it: a `--port` after it is another tool's.
 */
export function withoutPortArgs(args: readonly string[]): string[] {
  const separator = args.indexOf('--');
  const own = separator >= 0 ? args.slice(0, separator) : args;
  const rest: string[] = [];
  for (let index = 0; index < own.length; index++) {
    const arg = own[index]!;
    if (arg === '--port' || arg === '-p') {
      index++;
    } else if (!/^(--port|-p)=/.test(arg)) {
      rest.push(arg);
    }
  }
  return separator >= 0 ? [...rest, ...args.slice(separator)] : rest;
}

/** Step arguments with `--port <port>` before any `--`, replacing any port they already name. */
export function withPortArg(args: readonly string[], port: number): string[] {
  const rest = withoutPortArgs(args);
  const separator = rest.indexOf('--');
  const portArgs = ['--port', String(port)];
  return separator >= 0
    ? [...rest.slice(0, separator), ...portArgs, ...rest.slice(separator)]
    : [...rest, ...portArgs];
}

/**
 * The same plan, with `--device <id>` on every `run` and `install` step, replacing any `--device`
 * there. A plan with neither is returned as it is.
 *
 * @ref llp/0031-ios-binding.plan.md §How `dev` uses it — after `withForwardedExpoArgs`, so a
 * `--device` the caller typed for `expo start` is replaced by the bound device, and before the
 * `--port` block.
 */
export function withDevice(plan: StartPlan, deviceId: string): StartPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      step.id === 'run' || step.id === 'install'
        ? { ...step, argv: [...withoutDeviceArgs(step.argv), '--device', deviceId] }
        : step
    ),
  };
}

function withoutDeviceArgs(argv: readonly string[]): string[] {
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--device' || arg === '-d') {
      index++;
    } else if (!/^(--device|-d)=/.test(arg)) {
      rest.push(arg);
    }
  }
  return rest;
}

/**
 * The same plan, with `--port` on every step that serves, and on no other step.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port is not a step only a person can
 * complete. An `expo run:*` that serves writes the port to `RCT_METRO_PORT` and
 * `-PreactNativeDevServerPort`, so the binary and its deep link name the port the dev server takes.
 * An install step with `--no-bundler` gets none: the Expo CLI refuses `--port` with `--no-bundler`,
 * and the open deep-links the app to the dev server anyway.
 */
export function withDevServerPort(plan: StartPlan, port: number): StartPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      isDevServerStep(step)
        ? { ...step, argv: [step.argv[0]!, ...withPortArg(step.argv.slice(1), port)] }
        : step
    ),
  };
}
