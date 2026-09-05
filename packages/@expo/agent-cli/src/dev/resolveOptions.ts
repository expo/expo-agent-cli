import {
  isNativePlatformFlag,
  namedPlatformFlags,
  resolvePlatformFlag,
} from '../plan/platformFlags';
import type { PlanPlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import type { BuildBackend, RunTarget } from '../settings/types';
import { CommandError } from '../utils/errors';
import { DEFAULT_DETACH_TIMEOUT_MS } from './detachAsync';
import { assertKnownDevFlags } from './knownFlags';

/**
 * Flags that `@expo/agent-cli dev` handles itself and does not forward to the `expo` CLI.
 *
 * The same list `DEV_OWN_FLAGS` names, minus `--help`/`-h`, which never reach this resolver: the
 * command module answers them and exits before it is called.
 */
const AGENT_CLI_ONLY_FLAGS = [
  '--eas',
  '--local',
  '--no-open',
  '--no-agent-skills',
  '--no-followups',
  '--no-fingerprint-cache',
  '--plan',
  '--yes',
  '--json',
  '--detach',
  '--wait-ready',
];

/**
 * What `@expo/agent-cli dev` does with the project.
 *
 * @see llp/0004-smart-start-and-project-state.rfc.md §Plan contract
 */
export type DevMode =
  /** Emit the plan, then run its steps. The default. */
  | 'run'
  /** Emit the plan of what must run, then exit without running it (`--plan`). */
  | 'plan';

export interface DevOptions {
  mode: DevMode;
  /** Arguments to append after the plan's own, when spawning the `expo` CLI. */
  expoArgs: string[];
  /** Sync skills shortly after the dev server starts, cleared by `--no-agent-skills`. */
  agentSkills: boolean;
  /**
   * Platform asked for on the command line, which the plan engine targets.
   *
   * Required, like `smoke`'s: the plan differs per platform — what gets built, which device the
   * app lands on — and the old host-based guess was wrong on any Mac developing for Android.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §Which platform is the caller's to say
   */
  platform: PlanPlatform;
  /**
   * Where the caller asked the native build to run (`--eas`, `--local`), or null when neither.
   *
   * The top of the precedence ladder: a flag beats the project's `@expo/agent-cli` config, which beats
   * what the toolchain probe found (llp/0015 §The selection).
   */
  buildBackend: BuildBackend | null;
  /**
   * Which app the caller asked the plan to aim at (`--go`, `--dev-client`), or null when neither.
   *
   * Both are `expo start` flags this command also reads, so asking for a development build on a
   * project Expo Go could run needs no name of its own.
   */
  runTarget: RunTarget | null;
  /** Print the plan as JSON instead of a table (`--json`). */
  json: boolean;
  /** Attach the state-aware next actions to the output, cleared by `--no-followups`. */
  followups: boolean;
  /**
   * Whether the probe's fingerprint may be answered out of the project's own `.expo` record
   * (`--no-fingerprint-cache` clears it).
   *
   * @see llp/0023-fingerprint-caching.rfc.md
   * The hash this command reads decides whether the plan contains a build, so the flag exists here
   * for the same reason it exists on `status`: a caller who wants the plan decided on a measurement
   * rather than on a revalidated record can say so.
   */
  fingerprintCache: boolean;
  /** Approve a plan with build-class steps up front (`--yes`), so no confirmation is asked for. */
  yes: boolean;
  /**
   * Whether this run opens the app on the platform's device once the dev server is up.
   * `--no-open` clears it, for a caller that opens the app itself — `smoke` does, and so does an
   * agent that follows with `navigate`.
   *
   * The open is this command's own act (`./openApp.ts`), through the device tools and never
   * AppleScript, so it works headless and needs no macOS Automation grant.
   *
   * @ref llp/0026-dev-owns-the-open.rfc.md
   */
  open: boolean;
  /**
   * Port the dev server is asked to listen on (`--port`), or null when the command line names none.
   *
   * The flag was always forwarded to `expo start` — it is one of that CLI's — but it was in no
   * help text, so the way to avoid the "port 8081 is busy, use 8082?" question the Expo CLI asks
   * (and that a run with no terminal cannot answer) was undiscoverable. Naming it here also gives
   * the follow-ups a port they can vouch for.
   *
   * Naming it also makes the port a **requirement**: a run whose named port is taken fails rather
   * than moving to a free one (`src/dev/portCollision.ts`).
   */
  port: number | null;
  /**
   * Run the dev server in a process of its own and give the terminal back (`--detach`).
   *
   * @see llp/0004-smart-start-and-project-state.rfc.md §Daemonization
   */
  detach: boolean;
  /** Under `--detach`, also wait for the bundler to answer before reporting (`--wait-ready`). */
  waitReady: boolean;
  /** How long a detached start may take before the parent gives up on it. */
  detachTimeoutMs: number;
  /**
   * The command line to start the detached child with, i.e. this one minus the flags that are the
   * parent's. Recorded here so the resolver stays the one place that reads argv.
   */
  detachArgv: string[];
}

/**
 * Split `@expo/agent-cli dev` arguments into the `expo start` passthrough, the skill-sync decision, and
 * the plan-engine inputs.
 *
 * Running the plan is the default; `--plan` is the escape hatch that runs nothing at all. The
 * plain `expo start` wrapper is a command of its own now (`@expo/agent-cli start`), so this resolver has
 * no passthrough mode to pick.
 *
 * @see llp/0003-knowledge-tools-and-skills.rfc.md §Skills shipped from Expo modules
 * @see llp/0004-smart-start-and-project-state.rfc.md §Plan contract
 * @throws {CommandError} `BAD_ARGS` when an option belongs to neither CLI, when two options ask
 * for opposite things, or when `--port` names something that is not a port.
 */
export function resolveDevOptions(argv: string[]): DevOptions {
  // First, and before any of the combination rules below: an option neither this command nor
  // `expo start` has cannot have a meaningful interaction with one that exists, and it used to be
  // forwarded — reported by the Expo CLI a step later, or dropped outright by a plan that does not
  // end in `expo start` [friction run 5, F48-3].
  assertKnownDevFlags(argv);

  // For the errors below: the platform the caller named, read leniently, so every message can
  // quote a command line that would run. The strict read comes last — a caller with two things
  // wrong should hear about the more specific one first, the way `smoke` orders its errors.
  const example = resolvePlatformFlag(argv) ?? 'ios';

  const detach = argv.includes('--detach');
  const waitReady = argv.includes('--wait-ready');
  if (waitReady && !detach) {
    throw waitReadyWithoutDetach(example);
  }
  if (detach && argv.includes('--plan')) {
    throw detachWithPlan(example);
  }

  const buildBackend = resolveBuildBackend(argv, example);
  const runTarget = resolveRunTarget(argv, example);
  const port = resolvePort(argv, example);
  const open = !argv.includes('--no-open');

  return {
    mode: argv.includes('--plan') ? 'plan' : 'run',
    // `--port` is *not* stripped: it is an `expo start` flag and the plan's last step is the one
    // that acts on it. Reading it only records what was asked for. A native platform flag *is*
    // stripped: it names what the plan is for, and this command performs the open itself
    // (`./openApp.ts`) — handing it to `expo start` would open the app a second way, through the
    // osascript that dies without an Automation grant. `--web` stays: serving the web bundle is
    // `expo start`'s own job.
    expoArgs: argv.filter(
      (arg) => !AGENT_CLI_ONLY_FLAGS.includes(arg) && !isNativePlatformFlag(arg)
    ),
    agentSkills: !argv.includes('--no-agent-skills'),
    platform: resolveRequiredPlatform(argv),
    buildBackend,
    runTarget,
    json: argv.includes('--json'),
    followups: !argv.includes('--no-followups'),
    fingerprintCache: !argv.includes('--no-fingerprint-cache'),
    yes: argv.includes('--yes'),
    open,
    port,
    detach,
    waitReady,
    detachTimeoutMs: DEFAULT_DETACH_TIMEOUT_MS,
    // The child's argv is built from the same list, so a flag added to this command reaches the
    // detached run without a second place to remember.
    detachArgv: argv,
  };
}

/**
 * The platform this run is for. Required, and the one flag of this command with no default.
 *
 * It used to default from the host — iOS on a Mac, Android elsewhere — and the guessed platform
 * never reached `expo start`, so the plan opened nothing on a device. `smoke` dropped the same
 * guess for the same reason (llp/0005 §Which platform is the caller's to say); `dev` follows it,
 * with `--web` as a third answer because serving the web bundle is a plan this command owns.
 *
 * @ref llp/0025-dev-requires-platform.rfc.md
 *
 * @throws {CommandError} `BAD_ARGS` for no platform, or for two at once.
 */
function resolveRequiredPlatform(argv: string[]): PlanPlatform {
  const named = namedPlatformFlags(argv);
  if (named.length > 1) {
    throw new CommandError(
      'BAD_ARGS',
      `--${named[0]} and --${named[1]} name two platforms, and one run plans for one. Run it twice, once per platform.`
    );
  }
  if (named.length === 0) {
    // One line, like `smoke`'s: a required flag that was not passed is obvious from the command
    // line, and the reasoning lives here rather than in front of somebody who needs five characters.
    const error = new CommandError(
      'BAD_ARGS',
      `Missing platform. Usage: ${PROGRAM_PREFIX} dev --ios|--android|--web, for example: ${PROGRAM_PREFIX} dev --ios`
    );
    error.suggestedCommand = `${PROGRAM_PREFIX} dev --ios`;
    throw error;
  }
  return named[0]!;
}

/**
 * Where the caller asked the build to run, or null when they did not say.
 *
 * @throws {CommandError} `BAD_ARGS` when both flags are passed, which asks for two places at once.
 */
function resolveBuildBackend(argv: readonly string[], example: string): BuildBackend | null {
  const eas = argv.includes('--eas');
  const local = argv.includes('--local');
  if (eas && local) {
    throw opposite(
      '--eas and --local name two different places for one build, so this run has no build to plan.',
      'Why: --eas builds in the cloud on EAS, which needs an Expo account; --local builds on this machine, which needs Xcode or the Android SDK. A plan contains one build, and it happens in one place.',
      'How: pass whichever you meant. Passing neither lets this command choose — the plan says which place it picked and why, before anything runs.',
      `${PROGRAM_PREFIX} dev --${example} --plan --eas`
    );
  }
  return eas ? 'eas' : local ? 'local' : null;
}

/**
 * Which app the caller asked the plan to aim at, or null when they did not say.
 *
 * `--go` and `--dev-client` are `expo start`'s own flags and keep being forwarded to it. What is
 * new is that this command reads them *first*, as the run target the plan is decided against: a
 * project Expo Go can run is planned as a development build when `--dev-client` says so.
 *
 * @throws {CommandError} `BAD_ARGS` when both are passed.
 */
function resolveRunTarget(argv: readonly string[], example: string): RunTarget | null {
  const go = argv.includes('--go') || argv.includes('-g');
  const devClient = argv.includes('--dev-client') || argv.includes('-d');
  if (go && devClient) {
    throw opposite(
      '--go and --dev-client name two different apps to run the project in, so this run has no target to plan for.',
      'Why: --go runs the project inside Expo Go, which needs no native build; --dev-client runs it inside a development build of this project, which needs one. A plan aims at one of them.',
      'How: pass whichever you meant. Passing neither lets this command choose — Expo Go when it can run the project, a development build when it cannot.',
      `${PROGRAM_PREFIX} dev --${example} --plan --dev-client`
    );
  }
  return go ? 'expo-go' : devClient ? 'dev-build' : null;
}

/** Two flags that ask for opposite things, in the three sentences every error here is made of. */
function opposite(what: string, why: string, how: string, suggestedCommand: string): CommandError {
  const error = new CommandError('BAD_ARGS', [what, why, how].join('\n'));
  error.suggestedCommand = suggestedCommand;
  return error;
}

/** `--wait-ready` waits for a dev server this run would not have started. */
function waitReadyWithoutDetach(example: string): CommandError {
  // The smoke example needs a device platform, which `web` is not.
  const smokeExample = example === 'web' ? 'ios' : example;
  const error = new CommandError(
    'BAD_ARGS',
    [
      `--wait-ready only means something with --detach, and --detach was not passed.`,
      `Why: without --detach this command runs the dev server in the foreground and does not return until it stops, so there is no moment at which it could report that the bundler is ready.`,
      `How: pass both ("${PROGRAM_PREFIX} dev --${example} --detach --wait-ready"), or check a dev server that is already running with "${PROGRAM_PREFIX} smoke --${smokeExample}".`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} dev --${example} --detach --wait-ready`;
  return error;
}

/** `--plan` runs nothing, so there is nothing to detach. */
function detachWithPlan(example: string): CommandError {
  const error = new CommandError(
    'BAD_ARGS',
    [
      `--plan and --detach ask for opposite things, so this run would do nothing.`,
      `Why: --plan prints what would run and exits without running it, and --detach is about where the run goes. There is no plan-shaped thing to put in the background.`,
      `How: run "${PROGRAM_PREFIX} dev --${example} --plan" to see the plan, then "${PROGRAM_PREFIX} dev --${example} --detach --yes" to run it in the background.`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} dev --${example} --plan`;
  return error;
}

/**
 * The port `--port` asked for, or null when it was not passed.
 *
 * Only before a `--` separator, which is where `readPortArg` stops too: everything after it is
 * forwarded to something else, and a `--port` there is that tool's. An unusable value is reported
 * here rather than by `expo start` a minute later, which is what every other flag of this command
 * already does.
 */
function resolvePort(argv: string[], example: string): number | null {
  const separator = argv.indexOf('--');
  const own = separator >= 0 ? argv.slice(0, separator) : argv;

  let raw: string | undefined;
  let named = false;
  for (const [index, arg] of own.entries()) {
    if (arg === '--port' || arg === '-p') {
      named = true;
      raw = own[index + 1];
    } else if (/^(--port|-p)=/.test(arg)) {
      named = true;
      raw = arg.slice(arg.indexOf('=') + 1);
    }
  }
  if (!named) {
    return null;
  }

  // A flag that was passed and named nothing is a mistake, not an absent flag.
  const port = Number(raw);
  if (raw == null || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw badPort(raw ?? '', example);
  }
  return port;
}

function badPort(raw: string, example: string): CommandError {
  const error = new CommandError(
    'BAD_ARGS',
    [
      `--port must be a port number from 1 to 65535, but got ${raw || '(nothing)'}.`,
      `Why: the value is handed to "expo start", which listens on it.`,
      `How: pass one, as in "${PROGRAM_PREFIX} dev --${example} --port 8082". Leaving --port out lets the Expo CLI pick, which works when 8081 is free.`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} dev --${example} --port 8082`;
  return error;
}
