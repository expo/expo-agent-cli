// @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port is not a step only a person can complete
// This project's own dev server, as its lock and `/status` say, and what a run does with it.
//
// One rule for the reuse: a reuse plan has no serving step. `expo start` is dropped, `expo run:*`
// becomes `--no-bundler`, and the open after the steps, when one runs, goes to the lock's URL.

import type { DevServerLockInfo } from '../devLock';
import { DEFAULT_DEV_SERVER_PORT } from '../devLock/port';
import { EXIT_OUTCOME_FAILED } from '../exitCodes';
import { isPlatformFlag } from '../plan/platformFlags';
import type { NativePlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import type { DevServerPort, PlanStep, StartPlan } from '../project/types';
import { smokeCommand, statedSmokePlatform } from '../smoke/suggest';
import { CommandError } from '../utils/errors';
import { withoutPortArgs } from './forwardedArgs';
import type { DevOptions } from './resolveOptions';

/** This project's own dev server on the port a run would use, as its lock and `/status` say. */
export type OwnDevServer =
  | { kind: 'none' }
  /**
   * `missing`: server options the plan asks for that the running server was not started with.
   * `extra`: mode options the running server was started with that the plan does not ask for, or
   * null when its options are unknown.
   */
  | { kind: 'serving'; lock: DevServerLockInfo; missing: string[]; extra: string[] | null }
  | { kind: 'starting'; lock: DevServerLockInfo }
  /** The lock's port answers `/status` with another project's root. */
  | { kind: 'foreign'; lock: DevServerLockInfo; reportedProjectRoot: string }
  /**
   * The run needs the server on `port`, and this project's dev server serves on another port:
   * the caller `named` it, or a `run:* --no-bundler` with no open after it points the app at 8081.
   */
  | { kind: 'elsewhere'; lock: DevServerLockInfo; port: number; named: boolean };

/**
 * What this project's dev server, as its live lock names it, is to a run.
 *
 * The lock is published when the dev server process starts if its arguments name a port, which
 * `dev` always passes, and `/status` answers only once Metro listens. A lock whose `/status` does
 * not answer one probe is a `run:*` build that has not reached Metro yet, or a Metro that is not
 * answering: the port is spoken for, and there is nothing to open the app against.
 *
 * A live lock is this project's evidence. Its port is `foreign` only when `/status` names another
 * project's root. No root header, or a root that is a parent of this project (a monorepo
 * `metro.config.js` `projectRoot`) in the same checkout, is this project's server
 * (`matchProjectRoot`).
 *
 * `expo run:* --no-bundler` builds and launches the app against port 8081: the Expo CLI's
 * `resolveBundlerProps` reads neither `--port` nor `RCT_METRO_PORT` there. Only the open after the
 * steps moves the app to the lock's port, so without that open a lock on another port is
 * `elsewhere`.
 *
 * @param serving the plan's last dev-server step, or null for no option comparison (the
 * `--detach` parent, whose plan is the child's).
 */
export async function ownDevServerAsync(
  projectRoot: string,
  lock: DevServerLockInfo | null,
  options: Pick<DevOptions, 'port'> & { opens: boolean },
  serving: PlanStep | null
): Promise<OwnDevServer> {
  if (!lock) {
    return { kind: 'none' };
  }
  const { probeBundlerAsync } =
    require('../runtime/bundlerStatus') as typeof import('../runtime/bundlerStatus');
  const probe = await probeBundlerAsync(lock.url, { projectRoot });
  if (probe.projectRootMatched === false && probe.reportedProjectRoot != null) {
    return { kind: 'foreign', lock, reportedProjectRoot: probe.reportedProjectRoot };
  }
  if (!probe.answering) {
    return { kind: 'starting', lock };
  }
  // A second dev server for this project cannot hold the lock, so nothing could find or stop it.
  const installs = serving != null && serving.argv[1] !== 'start' && !options.opens;
  const port = options.port ?? (installs ? DEFAULT_DEV_SERVER_PORT : null);
  if (port != null && port !== lock.port) {
    return { kind: 'elsewhere', lock, port, named: options.port != null };
  }
  const mismatch = serving ? startOptionsMismatch(serving, lock.args) : { missing: [], extra: [] };
  return { kind: 'serving', lock, ...mismatch };
}

/**
 * The error a run stops with for this dev server, or null when the run goes on. The `--detach`
 * parent stops only on `foreign` and `elsewhere`.
 *
 * @param caller the caller's own `dev` command, which a stop that may pass repeats.
 */
export function ownDevServerStop(
  own: OwnDevServer,
  caller: Pick<DevOptions, 'detachArgv' | 'platform'>
): CommandError | null {
  switch (own.kind) {
    case 'starting':
      return devServerStartingError(own.lock);
    case 'foreign':
      return devServerPortForeignError(own.lock, own.reportedProjectRoot, caller);
    case 'elsewhere':
      return devServerOnOtherPortError(own, statedSmokePlatform(caller.platform));
    case 'serving':
      return mismatched(own)
        ? devServerOptionsMismatchError(own.lock, own.missing, own.extra)
        : null;
    case 'none':
      return null;
  }
}

/**
 * Options that change neither the bundle nor where it is served. The run targets choose the URL
 * scheme, which this CLI's open sets itself, and one server serves Expo Go, a development build and
 * the web. `--max-workers` is Metro's parallelism, and `--scheme` names a scheme the open sets.
 */
const NOT_COMPARED = ['--go', '--dev-client', '--web', '--max-workers', '--scheme'];

/** Aliases of `expo start` options, by the spelling compared (the Expo CLI's `start` table). */
const OPTION_ALIASES: Record<string, string> = {
  '-c': '--clear',
  '--reset-cache': '--clear',
  '-m': '--host',
  '-d': '--dev-client',
  '-g': '--go',
  '-w': '--web',
  '--lan': '--host lan',
  '--localhost': '--host localhost',
  '--host tunnel': '--tunnel',
  '--tunnel expo': '--tunnel',
};

/** `expo start` options that take a value, which is part of the option compared. */
const VALUE_OPTIONS = ['--host', '--max-workers', '--private-key-path', '--scheme'];

/**
 * `expo start` options that choose how the bundle is built, not where it is served. A run reusing a
 * server started with one it does not ask for gets that bundle: a plain `dev` against a `--no-dev`
 * server gets a production-style bundle with no HMR. They are compared in both directions.
 */
const MODE_OPTIONS = ['--no-dev', '--minify', '--offline', '--https'];

/** `--tunnel` takes a provider only when the next token names one, as the Expo CLI reads it. */
const TUNNEL_PROVIDERS = ['expo', 'ngrok'];

/**
 * The server options of `expo start` arguments (without the command), in one spelling each.
 *
 * `--port` is left out (the run takes the lock's port), as are {@link NOT_COMPARED}, `--host lan`
 * (the Expo CLI's default host) and everything after `--`. An option that takes a value is one
 * option with it (`--host tunnel`), in either spelling (`--host=tunnel`).
 */
export function serverOptions(args: readonly string[]): string[] {
  const own = withoutPortArgs(args);
  const separator = own.indexOf('--');
  const tokens = separator >= 0 ? own.slice(0, separator) : own;
  const options = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const equals = token.indexOf('=');
    const key = equals > 0 ? token.slice(0, equals) : token;
    const name = OPTION_ALIASES[key] ?? key;
    let option = name;
    if (equals > 0) {
      option = `${name} ${token.slice(equals + 1)}`;
    } else if (VALUE_OPTIONS.includes(name) && tokens[index + 1] != null) {
      option = `${name} ${tokens[++index]}`;
    } else if (name === '--tunnel' && TUNNEL_PROVIDERS.includes(tokens[index + 1] ?? '')) {
      option = `--tunnel ${tokens[++index]}`;
    }
    option = OPTION_ALIASES[option] ?? option;
    if (!NOT_COMPARED.includes(name) && option !== '--host lan') {
      options.add(option);
    }
  }
  return [...options];
}

/**
 * How the plan's serving step and the running dev server's options differ, where a reuse would
 * lose something.
 *
 * A reuse starts no server, and a running server's options cannot be changed. `missing` holds the
 * server options the step asks for that the server lacks. Only `expo start` asks for server
 * options: `expo run:*` passes none, and a reuse installs it with `--no-bundler`. `--clear` is
 * always missing: it acts once at start, so a server started with it earlier has not cleared
 * anything for this run. `extra` holds the {@link MODE_OPTIONS} the server was started with and the
 * step does not ask for. Host options are compared one way: a server reachable over a tunnel still
 * serves a run that did not ask for one.
 *
 * @param running the lock's `args`, starting with the command, or null when its options are
 * unknown: `missing` is then compared against a bare `start`, and `extra` is null.
 */
export function startOptionsMismatch(
  step: PlanStep,
  running: readonly string[] | null
): { missing: string[]; extra: string[] | null } {
  const carried = running ? serverOptions(running.slice(1)) : [];
  const asked = step.argv[1] === 'start' ? serverOptions(step.argv.slice(2)) : [];
  return {
    missing: asked.filter((option) => option === '--clear' || !carried.includes(option)),
    extra: running
      ? carried.filter((option) => MODE_OPTIONS.includes(option) && !asked.includes(option))
      : null,
  };
}

/** Whether a reuse would lose an option. Unknown options lose one only when the run asks for one. */
function mismatched({ missing, extra }: { missing: string[]; extra: string[] | null }): boolean {
  return missing.length > 0 || (extra?.length ?? 0) > 0;
}

/** How the running server's options differ, as a sentence part: `without --tunnel and with --no-dev`. */
function optionsDiffer(missing: string[], extra: string[] | null): string {
  if (extra == null) {
    return `and its options are unknown (started by an older version), while this run asks for ${missing.join(' ')}`;
  }
  return [
    missing.length ? `without ${missing.join(' ')}` : null,
    extra.length ? `with ${extra.join(' ')}, which this run does not ask for` : null,
  ]
    .filter(Boolean)
    .join(' and ');
}

/**
 * The plan that reuses this project's running dev server: no serving step.
 *
 * `expo start` is dropped. `expo run:*` becomes `--no-bundler`, without `--port`, which the Expo
 * CLI refuses with `--no-bundler`: it builds and installs, and the open after the steps connects
 * the app to the running server. Nothing depends on the Expo CLI finding its own server.
 */
export function withReusedDevServer(
  plan: StartPlan,
  serving: PlanStep,
  lock: DevServerLockInfo,
  opens: boolean
): StartPlan {
  if (serving.argv[1] === 'start') {
    return { ...plan, steps: plan.steps.filter((step) => step !== serving) };
  }
  const installed: PlanStep = {
    ...serving,
    argv: [serving.argv[0]!, ...withoutPortArgs(serving.argv.slice(1)), '--no-bundler'],
    reason: `${serving.reason} With --no-bundler instead: this project's dev server is running on port ${lock.port}, so the step starts none${opens ? ', and the app is opened against it' : ''}.`,
  };
  return { ...plan, steps: plan.steps.map((step) => (step === serving ? installed : step)) };
}

/** The plan's `devServerPort` when this project's dev server holds the port. */
export function ownDevServerPort(own: Exclude<OwnDevServer, { kind: 'none' }>): DevServerPort {
  const port = own.lock.port;
  switch (own.kind) {
    case 'elsewhere':
      return { port: own.port, movedFrom: null, state: 'elsewhere', running: port };
    case 'starting':
    case 'foreign':
      return { port, movedFrom: null, state: own.kind };
    case 'serving':
      return mismatched(own)
        ? { port, movedFrom: null, state: 'mismatch', missing: own.missing, extra: own.extra }
        : { port, movedFrom: null, state: 'reused' };
  }
}

/**
 * What the plan says about its dev server's port, beyond the port itself.
 *
 * A port the plan probed is only the port that was free when the plan was printed, so a `--plan`
 * run says the pick is made again when the plan runs. A lock's port and a named `--port` are not
 * picked, so nothing is said about them.
 *
 * This project's own dev server on the lock's port says what the plan does with it. One still
 * starting, one without an option the `start` asks for, and a port that answers for another
 * project are named, because the run stops on each.
 *
 * @param plan the plan before the reuse removed its serving step.
 */
export function portReasons(
  plan: StartPlan,
  serving: PlanStep,
  own: OwnDevServer,
  options: Pick<DevOptions, 'mode' | 'port'> & { opens: boolean }
): string[] {
  if (own.kind === 'starting') {
    return [
      `The dev server is starting on port ${own.lock.port}; this run stops. Run again once it answers, and it is reused.`,
    ];
  }
  if (own.kind === 'foreign') {
    return [
      `The dev server lock names port ${own.lock.port}, but the server there reports another project root (${own.reportedProjectRoot}); the run stops instead of starting another.`,
    ];
  }
  if (own.kind === 'elsewhere') {
    return [
      own.named
        ? `This project's dev server is running on port ${own.lock.port}, not the named port ${own.port}; the run stops instead of starting a second one.`
        : `This project's dev server is running on port ${own.lock.port}, and run:* --no-bundler points the app at port ${own.port} with no open after it; the run stops.`,
    ];
  }
  if (own.kind === 'serving' && mismatched(own)) {
    return [
      `This project's dev server is running on port ${own.lock.port} ${optionsDiffer(own.missing, own.extra)}; the run stops instead of reusing it.`,
    ];
  }
  if (own.kind === 'serving') {
    const running = `The dev server is already running on port ${own.lock.port}`;
    if (serving.argv[1] !== 'start') {
      const opened = options.opens ? ', and the app is opened against it' : '';
      return [`${running}; the install uses the running server${opened}.`];
    }
    if (plan.steps.length === 1) {
      return serving.argv.includes('--web')
        ? [`${running}; the run starts nothing, and the web app is served at ${own.lock.url}.`]
        : [`${running}; the run reports it and starts nothing.`];
    }
    const earlier = plan.steps.some((step) => step.argv[0] === 'eas') ? 'build' : 'install';
    return [`${running}; the ${earlier} uses it instead of starting another.`];
  }
  if (options.mode === 'plan' && options.port == null) {
    return ['The dev server port is picked again when the plan runs.'];
  }
  return [];
}

/**
 * The stop for a run whose project's dev server is still starting.
 *
 * An outcome (llp/0010 §Exit codes): a second dev server would collide on the same port, and the
 * running one has no Metro to open the app against yet.
 */
function devServerStartingError(lock: DevServerLockInfo): CommandError {
  const error = new CommandError(
    'DEV_SERVER_STARTING',
    [
      `This project's dev server is starting on port ${lock.port} (pid ${lock.pid}), so nothing was started.`,
      `Why: its lock is published but /status does not answer: a run:* build that has not reached Metro yet, or a Metro that is not answering.`,
      `How: watch it with "${PROGRAM_PREFIX} dev:logs" and run "${PROGRAM_PREFIX} status" when it is done, or stop it with "${PROGRAM_PREFIX} dev:stop".`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} dev:logs`;
  error.exitCode = EXIT_OUTCOME_FAILED;
  return error;
}

/**
 * The stop for a serving step whose project gained a dev server after the plan was decided.
 *
 * An outcome (llp/0010 §Exit codes): another run of this project holds the lock when the serving
 * step takes it, right before its spawn. A second dev server could not hold the lock, so nothing
 * could find or stop it. The run does not switch to that server: the plan approved is the plan run.
 *
 * @param lock the running server's lock, or null when its holder did not say where it listens.
 * @param built what the steps before this one left for the next run, or null when nothing.
 */
export function devServerAppearedError(
  lock: DevServerLockInfo | null,
  options: { platform: NativePlatform | null; built: string | null }
): CommandError {
  const where = lock ? ` on port ${lock.port}` : '';
  const use = options.platform
    ? `"${PROGRAM_PREFIX} status" or "${smokeCommand(options.platform)}"`
    : `"${PROGRAM_PREFIX} status"`;
  const error = new CommandError(
    'DEV_SERVER_APPEARED',
    [
      `Another run of this project started a dev server${where}${options.built ? ' while this one built' : ''}, so this step did not start a second one.`,
      `Why: one dev server per project${options.built ? `; ${options.built}` : ''}.`,
      `How: use the running server (${use}), or stop it with "${PROGRAM_PREFIX} dev:stop" and run again.`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} status`;
  error.exitCode = EXIT_OUTCOME_FAILED;
  return error;
}

/**
 * The stop for a reuse run whose dev server stopped or changed while its steps ran.
 *
 * An outcome (llp/0010 §Exit codes): the open would deep-link the app to a server that is gone or
 * no longer the one the plan reused.
 *
 * @param built what the steps left for the next run, or null when nothing.
 */
export function devServerGoneError(
  lock: DevServerLockInfo,
  stopped: boolean,
  built: string | null
): CommandError {
  const error = new CommandError(
    'DEV_SERVER_GONE',
    [
      `This project's dev server on port ${lock.port}, which this run reused, ${stopped ? 'stopped' : 'changed'} while the steps ran, so the app was not opened.`,
      `Why: the open goes to the running server the plan reused${built ? `; ${built}` : ''}.`,
      `How: run this command again; it reuses a running dev server or starts one. "${PROGRAM_PREFIX} status" shows what runs now.`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} status`;
  error.exitCode = EXIT_OUTCOME_FAILED;
  return error;
}

/** The caller's `dev` arguments without its platform flag, so a command can put `--<platform>` first. */
export function withoutPlatformFlag(argv: string[]): string[] {
  const separator = argv.indexOf('--');
  return argv.filter(
    (arg, index) => !isPlatformFlag(arg) || (separator !== -1 && index > separator)
  );
}

/**
 * The stop for a run whose lock's port answers for another project.
 *
 * An outcome (llp/0010 §Exit codes): the lock says this project's dev server is alive, and the
 * server on its port reports another project root, so the run has nothing to reuse and no port to
 * start on.
 */
function devServerPortForeignError(
  lock: DevServerLockInfo,
  reportedProjectRoot: string,
  { detachArgv, platform }: Pick<DevOptions, 'detachArgv' | 'platform'>
): CommandError {
  const again = [`${PROGRAM_PREFIX} dev --${platform}`, ...withoutPlatformFlag(detachArgv)].join(
    ' '
  );
  const error = new CommandError(
    'DEV_SERVER_PORT_FOREIGN',
    [
      `This project's dev server lock names port ${lock.port}, but the server answering there reports another project root (${reportedProjectRoot}), so nothing was started.`,
      `Why: the lock holder (pid ${lock.pid}) is alive, and another project's dev server answers on its port: /status names neither this project's root nor a directory of this checkout that contains it. This project's dev server may be in the middle of its busy-port retry, which moves it to a free port. Reusing the server on port ${lock.port} would open another project's app.`,
      `How: run "${again}" again in a few seconds. If the stop repeats, stop this project's dev server with "${PROGRAM_PREFIX} dev:stop", which releases its lock, and run the command again.`,
    ].join('\n')
  );
  error.suggestedCommand = again;
  error.exitCode = EXIT_OUTCOME_FAILED;
  return error;
}

/**
 * The stop for a run that names a port while this project's dev server runs on another.
 *
 * An outcome (llp/0010 §Exit codes): a second dev server for this project cannot hold the lock, so
 * nothing could find or stop it, and reporting the running server would name a port the caller did
 * not ask for.
 */
function devServerOnOtherPortError(
  { lock, port, named }: OwnDevServer & { kind: 'elsewhere' },
  smoke: NativePlatform | null
): CommandError {
  const use = smoke
    ? `"${smokeCommand(smoke)}" or "${PROGRAM_PREFIX} status"`
    : `"${PROGRAM_PREFIX} status"`;
  const lines = named
    ? [
        `This project's dev server is running on port ${lock.port} (pid ${lock.pid}), not on the named port ${port}, so nothing was started.`,
        `Why: one project has one dev server lock, and a second dev server on port ${port} could not hold it, so nothing could find or stop that server.`,
        `How: use the running server (${use}), stop it with "${PROGRAM_PREFIX} dev:stop", or drop --port.`,
      ]
    : [
        `This project's dev server is running on port ${lock.port} (pid ${lock.pid}), not on port ${port}, so nothing was started.`,
        `Why: the install runs "expo run:*" with --no-bundler, which builds and launches the app against port ${port}, and this run opens no app after it (--no-open or AGENT_CLI_NO_DEVICE) to move the app to port ${lock.port}.`,
        `How: run without --no-open, so the app is opened against the running server, or stop it with "${PROGRAM_PREFIX} dev:stop" and run this command again.`,
      ];
  const error = new CommandError('DEV_SERVER_ON_OTHER_PORT', lines.join('\n'));
  error.suggestedCommand = `${PROGRAM_PREFIX} status`;
  error.exitCode = EXIT_OUTCOME_FAILED;
  return error;
}

/**
 * The stop for a run that would reuse a dev server whose options differ from what it asks for.
 *
 * An outcome (llp/0010 §Exit codes), thrown before any step: a reuse starts no server, and a
 * running dev server cannot gain `--tunnel` or `--clear`, or drop `--no-dev`. Without the stop,
 * `dev --eas` pays for an `eas build` and then waits on a tunnel that never comes, `dev --clear`
 * clears nothing, and a plain `dev` gets a production-style bundle with no HMR.
 */
function devServerOptionsMismatchError(
  lock: DevServerLockInfo,
  missing: string[],
  extra: string[] | null
): CommandError {
  const error = new CommandError(
    'DEV_SERVER_OPTIONS_MISMATCH',
    [
      `This project's dev server is running on port ${lock.port} ${optionsDiffer(missing, extra)}, so nothing was started.`,
      `Why: the run would reuse that server, and the options of a running dev server cannot be added or dropped.`,
      `How: stop it with "${PROGRAM_PREFIX} dev:stop" and run this command again${missing.length ? `, or run without ${missing.join(' ')}` : ''}.`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} dev:stop`;
  error.exitCode = EXIT_OUTCOME_FAILED;
  return error;
}
