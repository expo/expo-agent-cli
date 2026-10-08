import { holdDevServerLockAsync } from '../devLock';
import type { ResolvedDevServerPort } from '../devLock/port';
import { dependsOnDevClientSync, reportFollowUps } from '../followups';
import { probeBundlerAsync } from '../runtime/bundlerStatus';
import { autoSyncSkillsAsync } from '../skills/skillsAsync';
import { CommandError } from '../utils/errors';
import { runExpoAsync, spawnExpoAsync } from '../utils/expoCli';
import { buildLogPath, buildStepPlatform } from '../dev/buildLog';
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
  const run = await runDevServerAsync(projectRoot, ['start', ...options.expoArgs], {
    agentSkills: options.agentSkills,
  });
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
 * `src/devLock/` is taken here, because this is the one place that knows a dev server is starting
 * and can wait for the port it ends up on. It is held for exactly as long as the subprocess runs.
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
  }: {
    agentSkills: boolean;
    output?: SubprocessOutput;
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
      autoSyncSkillsAsync(projectRoot, { silent: output === 'capture' }).catch(() => {});
    }, SKILLS_SYNC_IDLE_DELAY_MS);
    // Don't let a pending sync hold the CLI open.
    timer.unref?.();
  }

  // The lock is taken at the spawn when the arguments name a port, else when the dev server
  // reports one. `holdDevServerLockAsync` swallows every failure: a lock is a convenience, and the
  // dev server is the command.
  const startedAt = Date.now();
  let running = true;
  let port: ResolvedDevServerPort | null = null;
  // The lock answers `arg` at the spawn and `log` when Metro reports, so the open is guarded here.
  let opened = false;
  const open = (server: { url: string; port: number }) => {
    if (!opened) {
      opened = true;
      onDevServer?.(server);
    }
  };
  const run = spawnDevServerAsync(projectRoot, args, output).finally(() => {
    running = false;
  });
  const lock = holdDevServerLockAsync(projectRoot, args, {
    since: startedAt,
    isRunning: () => running,
    // Wakes the port watch the moment the dev server is gone, so a start that fails immediately
    // is not held up waiting for a port that will never be reported.
    stopped: run.then(
      () => undefined,
      () => undefined
    ),
    // What the dev server itself said, which is the only thing a caller may claim about it.
    onResolved: (resolved) => {
      port = resolved;
      if (!onDevServer) {
        return;
      }
      const server = { url: `http://127.0.0.1:${resolved.port}`, port: resolved.port };
      // `log` is the dev server saying where it listens. `arg` is only the port the command line
      // named, which `dev` always passes, so the open waits until `/status` answers there and
      // names no other project's root, and never comes when the dev server exits first. The lock
      // tells `arg` at the spawn and `log` later, and `open` fires once. `default` is a
      // guess, and an open aimed at a guessed port is the false green the lock exists to prevent.
      if (resolved.source === 'log') {
        open(server);
      } else if (resolved.source === 'arg') {
        void openWhenAnsweringAsync(server.url, projectRoot, () => running && !opened).then(
          (answered) => {
            if (answered) {
              open(server);
            }
          }
        );
      }
    },
  });

  try {
    const result = await run;
    // Awaited here, not only in the `finally`: the lock is what resolves the port, and a caller
    // that has to report where the dev server was needs that answer to be part of the result
    // rather than to arrive after it. `holdDevServerLockAsync` never rejects.
    await lock;
    return { ...result, port };
  } finally {
    clearTimeout(timer);
    (await lock)?.release();
  }
}

/** How often an open aimed at a named port asks `/status` again. */
export const STATUS_POLL_INTERVAL_MS = 500;

/**
 * Ask `url`'s `/status` until it answers for `projectRoot`, or until `isRunning` says the dev
 * server is gone.
 *
 * A port named on the command line can be held by another project's Metro, which answers `/status`
 * as well as this one would. Its project root header tells them apart: a foreign root ends the
 * poll without an open, and the busy-port retry of `dev` handles the step. A dev server that names
 * no root is this one: this process spawned it on that port. A root that contains this project is
 * this one too when it is in the same checkout (`matchProjectRoot`, for a monorepo
 * `metro.config.js`).
 */
async function openWhenAnsweringAsync(
  url: string,
  projectRoot: string,
  isRunning: () => boolean
): Promise<boolean> {
  while (isRunning()) {
    const probe = await probeBundlerAsync(url, {
      timeoutMs: STATUS_POLL_INTERVAL_MS,
      projectRoot,
    });
    if (probe.projectRootMatched === false) {
      return false;
    }
    if (probe.answering) {
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
  output: SubprocessOutput
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (output === 'inherit') {
    return { exitCode: await runExpoAsync(projectRoot, args), stdout: '', stderr: '' };
  }

  // @ref llp/0012-build-explain.rfc.md §What ships, and what is reserved
  // `expo run:*` builds, installs and serves in one subprocess, and its output is what
  // `inspect:build-log --local` explains afterwards. Every byte goes to the platform's build log
  // as it arrives (`src/dev/buildLog.ts`); a plain `expo start` builds nothing and writes none.
  const buildPlatform = buildStepPlatform(args);
  const { result } = await spawnExpoAsync(projectRoot, args, {
    output,
    ci: false,
    ...(buildPlatform ? { logFile: buildLogPath(projectRoot, buildPlatform) } : null),
  });
  if (result.spawnError) {
    throw new CommandError(
      'EXPO_CLI_NOT_FOUND',
      `Could not run the Expo CLI (${result.spawnError.code ?? result.spawnError.message}), so no dev server was started. Install Expo in the project with "npm install expo", then run this command again.`
    );
  }
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
}
