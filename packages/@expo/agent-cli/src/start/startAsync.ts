import { withLeaseExtendedAsync } from '../deviceBinding/renew';
import { publishDevServerPortAsync, withRunLockAsync, type RunLock } from '../devLock';
import type { ResolvedDevServerPort } from '../devLock/port';
import type { DevServerLockInfo } from '../devLock/types';
import { dependsOnDevClientSync, reportFollowUps } from '../followups';
import { findPortListenersAsync } from '../dev/portListener';
import { probeBundlerAsync } from '../runtime/bundlerStatus';
import { autoSyncSkillsAsync } from '../skills/skillsAsync';
import { CommandError } from '../utils/errors';
import { canOpenStartup, startupSignal, trackStartupTask } from '../utils/startupTasks';
import { runExpoAsync, spawnExpoAsync } from '../utils/expoCli';
import type { SubprocessOutput } from '../utils/subprocess';
import { resolveStartFollowUpsAsync } from './followUps';
import type { StartOptions } from './resolveOptions';

/** How long to wait after spawning `expo start` before syncing skills. */
export const SKILLS_SYNC_IDLE_DELAY_MS = 3000;

/** What one dev-server run amounts to, for a caller that has to report on it. */
export interface DevServerRun {
  /** The exit code of the subprocess. */
  exitCode: number;
  /** What it printed, empty in `inherit` mode where this process never saw it. */
  stdout: string;
  stderr: string;
  /**
   * The port the dev server ended up on, as the lock resolved it, or null when the lock could not
   * run at all. `source: 'default'` means nothing reported one — there is no port to point at.
   */
  port: ResolvedDevServerPort | null;
}

/**
 * Run `expo start` as a subprocess and sync skills a few seconds later.
 *
 * @returns the exit code of the `expo start` subprocess.
 */
export async function startAsync(projectRoot: string, options: StartOptions): Promise<number> {
  // @ref llp/0009-smart-followups.rfc.md §Examples per command
  // The follow-ups go out before the subprocess does: once Metro streams into this terminal,
  // anything printed after it scrolls away with the bundler output.
  //
  // This command runs no probe, by design, so which app the URL is for is decided the way
  // `expo start` decides it: `--dev-client`, or the `expo-dev-client` dependency, means a
  // development build; anything else means Expo Go.
  reportFollowUps(
    'start',
    await resolveStartFollowUpsAsync(projectRoot, options, {
      expoGo: !options.expoArgs.includes('--dev-client') && !dependsOnDevClientSync(projectRoot),
      web: options.platform === 'web',
    })
  );

  // `@expo/agent-cli start` hands the terminal over untouched, whatever this process' streams are: it is
  // the "forward everything to `expo start`" command, and capturing its output would take the
  // bundler's interactive keypresses away from a person who has one.
  // `start` is a run of one step: its own lock, `serving`, released when the dev server exits.
  const run = await withRunLockAsync(projectRoot, (lock) =>
    runDevServerAsync(projectRoot, ['start', ...options.expoArgs], {
      agentSkills: options.agentSkills,
      lock,
      phase: 'serving',
    })
  );
  return run.exitCode;
}

/**
 * Run an `expo` command that starts a dev server (`start`, `run:ios`, `run:android`), publish
 * where that dev server listens, and sync skills a few seconds later.
 *
 * The delay keeps the dependency scan away from the first bundle, and the timer is
 * cancelled when the dev server exits first, so a failed start syncs nothing.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §Status — the dev-server lock of
 * `src/devLock/` is published here, because this is the one place that knows a dev server is
 * starting and can wait for the port it ends up on. The caller owns `lock` and ends it.
 *
 * @param args Arguments for the `expo` CLI, starting with the command name.
 * @returns the exit code of the subprocess.
 */
export async function runDevServerAsync(
  projectRoot: string,
  args: string[],
  {
    agentSkills,
    output = 'inherit',
    onDevServer,
    easPlatform = null,
    lock: runLock,
    phase,
    signal,
  }: {
    agentSkills: boolean;
    output?: SubprocessOutput;
    /** The platform of the EAS session this run opens the app on, named on the lock. */
    easPlatform?: DevServerLockInfo['easPlatform'];
    /**
     * The lock of the run this step belongs to. The step answers on it, or takes it, and leaves
     * the release to the run (llp/0004 §Dev-server lock).
     */
    lock: RunLock;
    /**
     * What the lock says at the spawn: `building` for a step that compiles before it serves. The
     * lock then says `serving` once /status answers for this project.
     */
    phase: 'building' | 'serving';
    /** Aborted before the spawn, no dev server starts and the call rejects with its reason. */
    signal?: AbortSignal;
    /**
     * Told once, the moment the dev server reports where it listens, or `/status` answers on the
     * port the arguments name.
     *
     * `dev` hangs its app-open on this (llp/0026): the port is only knowable after the spawn, and
     * the subprocess does not return until the dev server stops.
     */
    onDevServer?: (server: { url: string; port: number }) => void;
  }
): Promise<DevServerRun> {
  let timer: NodeJS.Timeout | undefined;
  if (agentSkills) {
    timer = setTimeout(() => {
      if (!startupSignal()?.aborted)
        void trackStartupTask(
          autoSyncSkillsAsync(projectRoot, { silent: output === 'capture' })
        ).catch(() => {});
    }, SKILLS_SYNC_IDLE_DELAY_MS);
    // Don't let a pending sync hold the CLI open.
    timer.unref?.();
  }

  // The lock is taken at the spawn when the arguments name a port, else when the dev server
  // reports one. `publishDevServerPortAsync` swallows every failure: a lock is a convenience, and
  // the dev server is the command.
  const startedAt = Date.now();
  let running = true;
  let port: ResolvedDevServerPort | null = null;
  const serverAt = ({ port }: ResolvedDevServerPort) => ({
    url: `http://127.0.0.1:${port}`,
    port,
  });
  // The lock answers `arg` at the spawn and `reported` when Metro reports, so the open is guarded here.
  let opened = false;
  const open = (server: { url: string; port: number }) => {
    if (!opened && canOpenStartup()) {
      opened = true;
      onDevServer?.(server);
    }
  };
  // @ref llp/0004-smart-start-and-project-state.rfc.md §Dev-server lock — a step that builds says
  // `serving` once this project's Metro answers `/status`, and a step that opens the app opens it
  // then. The wait reads the latest port each time, so a port Metro reports later counts. Plain
  // `start` neither builds nor opens, and sends no probe.
  const answers = phase === 'building' || onDevServer != null;
  let waiting = false;
  const waitForAnswer = (first: ResolvedDevServerPort) => {
    waiting = true;
    // A step that does not build has nothing left to wait for once its open went on Metro's report.
    const wanted = () => running && (phase === 'building' || !opened);
    void trackStartupTask(
      waitForOwnMetroAsync(() => serverAt(port ?? first).url, projectRoot, wanted).then(
        (answered) => {
          // Metro that exited meanwhile has nothing to answer for or to open the app on.
          if (!answered || !running) return;
          runLock.apply({ type: 'status-answered' });
          open(serverAt(port ?? first));
        }
      )
    ).catch(() => {});
  };
  const run = withLeaseExtendedAsync(projectRoot, () =>
    spawnDevServerAsync(projectRoot, args, output, signal)
  ).finally(() => {
    running = false;
  });
  const published = publishDevServerPortAsync(projectRoot, args, {
    since: startedAt,
    isRunning: () => running,
    phase,
    easPlatform,
    lock: runLock,
    // With `lsof`, never a request: a request to Metro is not the record's to make. Only a sole
    // listener: beside another (`[::1]` and `127.0.0.1`), which one is this run's is unknown.
    findListenerPid: async (listenPort) => {
      const listeners = await findPortListenersAsync(listenPort);
      return listeners.length === 1 ? listeners[0]!.pid : null;
    },
    // Wakes the port watch the moment the dev server is gone, so a start that fails immediately
    // is not held up waiting for a port that will never be reported.
    stopped: run.then(
      () => undefined,
      () => undefined
    ),
    // What the dev server itself said, which is the only thing a caller may claim about it.
    // `reported` is the dev server saying where it listens, so the open goes at once. `arg` is only
    // the port the command line named, which `dev` always passes, so the step waits until this
    // project's Metro answers `/status` there, and never opens when the dev server exits first.
    // `default` is a guess, and an open aimed at a guessed port is the false green the lock exists
    // to prevent.
    onResolved: (resolved) => {
      port = resolved;
      if (resolved.source === 'reported') open(serverAt(resolved));
      // A building step waits on any port: the answer must come from this project's Metro anyway.
      const worthWaiting = resolved.source !== 'default' || phase === 'building';
      if (answers && !waiting && worthWaiting) waitForAnswer(resolved);
    },
  });

  try {
    const result = await run;
    // Awaited here, not only in the `finally`: the lock is what resolves the port, and a caller
    // that has to report where the dev server was needs that answer to be part of the result
    // rather than to arrive after it. `publishDevServerPortAsync` never rejects.
    await published;
    return { ...result, port };
  } finally {
    clearTimeout(timer);
    // After the port watch, so every event of this step lands before Metro's exit.
    await published;
    runLock.apply({ type: 'server-exited' });
  }
}

/** How often a wait for this project's Metro asks `/status` again. */
export const STATUS_POLL_INTERVAL_MS = 500;

/**
 * Ask `url`'s `/status` until this project's Metro answers, or until `isRunning` says the dev
 * server is gone.
 *
 * Another project's Metro can answer on the port as well as this one would, and its project root
 * header tells them apart. Its answer does not end the wait: it may be a dev server that leaves
 * before this project's Metro binds the port. A server that stays there keeps this Metro from
 * binding, so the step exits, `isRunning` says so, and the busy-port retry of `dev` handles the
 * step. A dev server that names no root is this one: this process spawned it on that port. A root
 * that contains this project is this one too when it is in the same checkout (`matchProjectRoot`,
 * for a monorepo `metro.config.js`).
 */
async function waitForOwnMetroAsync(
  url: () => string,
  projectRoot: string,
  isRunning: () => boolean
): Promise<boolean> {
  while (isRunning()) {
    const probe = await probeBundlerAsync(url(), {
      timeoutMs: STATUS_POLL_INTERVAL_MS,
      projectRoot,
    });
    if (probe.answering && probe.projectRootMatched !== false) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Spawn the dev server, either handing the terminal over or keeping what it printed.
 *
 * `inherit` is what a person watching gets: the bundler's own output, its keypress menu, and its
 * signals. Everything else is a run nobody is watching — an agent, a log file, CI — where the
 * output has to be *kept* instead, because a dev server that stops on a question the Expo CLI
 * asked says so on a stream that would otherwise go nowhere (llp/0010 §Needs-human protocol).
 *
 * **`ci: false` is load-bearing here, and only here.** A dev server told `CI=1` turns Metro's file
 * watcher off and serves its start-up snapshot forever, so an agent that edits a file and then asks
 * `dev:wait` whether the project compiles is answered about code that no longer exists [observed —
 * live on an SDK 57 app, 2026-08-23: a syntax error appended to a route left `dev:wait` at exit 0].
 * The prompts still fail fast without it — that half is the pipe, not the variable. See
 * {@link spawnExpoAsync}.
 */
async function spawnDevServerAsync(
  projectRoot: string,
  args: string[],
  output: SubprocessOutput,
  signal: AbortSignal | undefined
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (output === 'inherit') {
    return { exitCode: await runExpoAsync(projectRoot, args, { signal }), stdout: '', stderr: '' };
  }

  const { result } = await spawnExpoAsync(projectRoot, args, { output, ci: false, signal });
  if (result.spawnError) {
    throw new CommandError(
      'EXPO_CLI_NOT_FOUND',
      `Could not run the Expo CLI (${result.spawnError.code ?? result.spawnError.message}), so no dev server was started. Install Expo in the project with "npm install expo", then run this command again.`
    );
  }
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
}
