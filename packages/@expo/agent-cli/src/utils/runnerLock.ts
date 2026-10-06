// @ref llp/0015-backend-selection-and-config.rfc.md §Resolving the EAS CLI — the single rung.
// @ref llp/0021-honest-reports.rfc.md §The rules.
//
// One spawn of a package spec at a time, per process.
//
// Wave 18 made the package runner the only rung to the EAS CLI, which fixed the impostor class and
// brought one property of the runners with it: **a runner keeps a scratch directory per package
// spec**. `bunx eas-cli@latest` resolves and installs into `$TMPDIR/bunx-<uid>-eas-cli@latest`, and
// two `bunx` processes started milliseconds apart on the same spec are two writers of one directory.
// The loser does not queue. It exits 1 with empty stdout and bun's own progress on stderr —
// `Resolving dependencies` — which the caller then reports as what the *service* said about its
// builds.
//
// Observed [F93, live tier, 2026-08-27], six runs of `@expo/agent-cli status --explain` against a fresh copy
// of an EAS-linked project with no `.expo` cache: both platforms poisoned 2/6, one platform poisoned
// 1/6, clean 3/6. The identical argv run on its own exits 0 with the correct payload every time, and
// a ~50 ms skew between the two spawns made the collision disappear.
//
// **Why a mutex and not isolated caches** [decided — wave 22]. Three fixes were on the table:
//
//  1. A per-spec mutex in the spawn layer — this module.
//  2. A private cache directory per spawn (`BUN_INSTALL_CACHE_DIR`, `npm_config_cache`).
//  3. One resolution up front, then reuse of its result.
//
// (2) buys concurrency and pays for it in the one thing the runner rung exists to give: a warm cache.
// A private cache is cold by construction, so **every** lookup would download the CLI — the cost
// llp/0015 §Resolving the EAS CLI is careful to make a once-per-machine cost, turned into a
// per-spawn one. It is also a claim about two other tools' undocumented environment variables, which
// is the kind of claim llp/0002 will not let this CLI ship untested. (3) is a larger change than the
// defect: the specs differ per project and per caller, and "resolve once" needs a place to put the
// answer that outlives the process.
//
// (1) is the smallest fix that is honest about what it does. It serializes **only** spawns that share
// a scratch directory: two different specs still run concurrently, and nothing that is not a runner is
// touched at all. What it costs is the wall time of the second spawn, which for the case that found
// this is about a second on a command that opted into a network call.
//
// **Where it is applied.** All three spawn paths that can start a runner, because "the fix holds for
// status's two lookups" is not the claim worth making: `src/utils/subprocess.ts` (the EAS lookups,
// deploy, doctor, typecheck, config, auth, `create-expo`), `src/utils/spawnCapture.ts` (the cloud
// simulator's verbs) and `src/utils/inheritedRun.ts` (the `npx expo` fallback). A path that grows a
// fourth spawn helper has to come through here too, which is why the key is derived from the argv
// rather than passed in by each caller.
//
// **Across processes, a warm-up** [2026-10-05]. The mutex above holds in one process only, and two
// worktrees that start sessions at the same moment are two processes: one `bunx eas-cli@latest
// simulator …` exited 1 with only `Resolving dependencies` printed. On a cold scratch directory, 2
// of 6 concurrent `bunx eas-cli@latest --version` exited 1 with `TypeError: (0 ,
// minimatch_1.minimatch) is not a function`; on a warm one, 6 of 6 exited 0 [observed — bun 1.3,
// eas-cli 24.10.0]. So before the first runner spawn of a spec in a process, `warmUpRunnerAsync`
// takes a machine-wide `mkdir` lock (`./mkdirLock.ts`) and runs `<runner> <spec> --version` under
// it. That fills the directory. The real command then runs unlocked, so two long sessions are
// never serialized. Only `eas-cli` is warmed, because its `--version` is verified to print and
// exit. A spec that resolves to the project's own `node_modules` involves no install and is
// skipped.
//
// The lock lives in the Expo home. The runner's scratch directory is per user, and so is the home,
// so two worktrees share the lock. An e2e test gets a home of its own
// (`e2e/utils.ts`), so a slow warm-up in one test's project never spends another test's budget.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { env } from './env';
import { getExpoHomeDirectory } from './expoHome';
import { acquireMkdirLockAsync } from './mkdirLock';
import { killProcessTree, USE_PROCESS_GROUP } from './processGroup';
import { resolveSpawnTarget } from './windowsShim';

/** Runner names, without extension, whose scratch directory is shared per package spec. */
const RUNNER_NAMES = new Set(['npx', 'bunx']);

/** Executable suffixes a runner is spelled with on Windows. */
const EXECUTABLE_SUFFIXES = ['.cmd', '.exe', '.bat', '.ps1'];

/** The spec placeholder for a runner argv this module cannot read a package out of. */
const UNKNOWN_SPEC = '*';

/**
 * Which runner an executable is, or null when it is not one.
 *
 * The **base name**, because the path is not the thing that collides: `bunx` found at
 * `/opt/homebrew/bin/bunx` and a bare `bunx` share one scratch directory, and two locks for them
 * would be no lock at all.
 */
function runnerNameOf(command: string): string | null {
  // Split on both separators whatever the platform, because a Windows path may be carried on a test
  // running elsewhere and a name is cheap to be right about.
  const base = command.split(/[\\/]/).pop() ?? command;
  const lower = base.toLowerCase();
  const suffix = EXECUTABLE_SUFFIXES.find((extension) => lower.endsWith(extension));
  const name = suffix ? lower.slice(0, -suffix.length) : lower;
  return RUNNER_NAMES.has(name) ? name : null;
}

/**
 * The package spec a runner argv names, or null when nothing in it looks like one.
 *
 * The first argument that is not a flag. That is the whole rule, and it is enough because this CLI
 * writes exactly one runner flag onto a runner's command line — `--yes`, for npx's install prompt
 * (`src/utils/easCli.ts`) — and both runners take the spec immediately after their own flags.
 *
 * A flag that takes a **separate value** would break the rule, and none is written here; a spelling
 * this cannot read answers null and is serialized under {@link UNKNOWN_SPEC}, which over-serializes
 * rather than under-serializes. That asymmetry is deliberate: the cost of the first is a moment, and
 * the cost of the second is F93 back.
 */
function packageSpecOf(args: readonly string[]): string | null {
  for (const arg of args) {
    if (!arg.startsWith('-')) {
      return arg;
    }
  }
  return null;
}

/**
 * The lock key for one spawn, or null when the spawn is not a package runner at all.
 *
 * `<runner>:<spec>`. Keyed on the runner as well as the spec because the two runners keep separate
 * scratch directories — `npx eas-cli@latest` and `bunx eas-cli@latest` do not collide — so folding
 * them together would serialize a pair that never had a problem.
 */
export function runnerSpawnKey(command: string, args: readonly string[]): string | null {
  const runner = runnerNameOf(command);
  if (runner == null) {
    return null;
  }
  return `${runner}:${packageSpecOf(args) ?? UNKNOWN_SPEC}`;
}

/** The lock one spawn holds. Released exactly once, in a `finally`. */
export interface RunnerLock {
  /** How long this spawn waited for the runner ahead of it, in milliseconds. */
  queuedMs: number;
  /** Hand the lock to the next waiter, or leave it free. Calling it twice is a no-op. */
  release(): void;
}

/** One key's state: whether it is held, and who is waiting in the order they arrived. */
interface Queue {
  held: boolean;
  waiting: ((granted: boolean) => void)[];
}

const queues = new Map<string, Queue>();

/** Forget every lock and every waiter. For tests, and for nothing else. */
export function resetRunnerLocks(): void {
  queues.clear();
  warmUps.clear();
  warmed.clear();
}

/** Packages whose `--version` is verified to print and exit, so the warm-up does no real work. */
const WARM_UP_PACKAGES = new Set(['eas-cli']);

/** A warm-up lock this old has a dead holder: a live holder refreshes it, and a warm-up is short. */
export const RUNNER_WARM_UP_STALE_MS = 5 * 60_000;

const RUNNER_WARM_UP_HEARTBEAT_MS = 10_000;

/** The longest one warm-up may run. After it the real spawn runs anyway and reports for itself. */
const RUNNER_WARM_UP_TIMEOUT_MS = 180_000;

/** What one warm-up runs, and the machine-wide lock it runs under. */
export interface RunnerWarmUp {
  command: string;
  args: string[];
  lock: string;
}

/**
 * The warm-up a runner spawn needs, or null when it needs none.
 *
 * None for a command that is not a runner, a spec this module cannot read, a package outside
 * {@link WARM_UP_PACKAGES}, and an unversioned spec the project has installed: the runner then runs
 * the local copy and installs nothing.
 */
export function runnerWarmUpFor(
  command: string,
  args: readonly string[],
  cwd: string = process.cwd()
): RunnerWarmUp | null {
  const runner = runnerNameOf(command);
  const specIndex = args.findIndex((arg) => !arg.startsWith('-'));
  if (runner == null || specIndex < 0) {
    return null;
  }
  const spec = args[specIndex]!;
  const versionAt = spec.lastIndexOf('@');
  const name = versionAt > 0 ? spec.slice(0, versionAt) : spec;
  if (!WARM_UP_PACKAGES.has(name) || (versionAt <= 0 && isInstalledFrom(cwd, name))) {
    return null;
  }
  return {
    command,
    args: [...args.slice(0, specIndex + 1), '--version'],
    lock: path.join(
      getExpoHomeDirectory(),
      'agent-cli',
      'runner-locks',
      encodeURIComponent(`${runner}:${spec}`)
    ),
  };
}

/** Whether `node_modules/<name>` resolves from `cwd` or one of its parents. */
function isInstalledFrom(cwd: string, name: string): boolean {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'node_modules', name, 'package.json'))) {
      return true;
    }
    if (path.dirname(dir) === dir) {
      return false;
    }
  }
}

export type WarmUpSpawn = (
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number }
) => Promise<void>;

/** The warm-up in flight per lock, so concurrent callers in one process share one. */
const warmUps = new Map<string, Promise<void>>();

/** Locks this process has warmed already. */
const warmed = new Set<string>();

/**
 * Make sure the runner's install of the spec is complete before the real spawn.
 *
 * Null when there is nothing to wait for, so the caller can spawn in this tick
 * (§tryAcquireRunnerLock). The promise never rejects: a warm-up that fails or runs out leaves the
 * real spawn to report its own outcome.
 *
 * @param timeoutMs the caller's whole budget. The lock wait and the warm-up come out of it.
 */
export function warmUpRunnerAsync(
  command: string,
  args: readonly string[],
  { cwd, timeoutMs }: { cwd?: string; timeoutMs?: number },
  spawnWarmUp: WarmUpSpawn = spawnWarmUpAsync
): Promise<void> | null {
  if (env.AGENT_CLI_NO_RUNNER_WARM_UP) {
    return null;
  }
  const warmUp = runnerWarmUpFor(command, args, cwd);
  if (warmUp == null || warmed.has(warmUp.lock)) {
    return null;
  }
  let pending = warmUps.get(warmUp.lock);
  if (!pending) {
    pending = warmUnderLockAsync(warmUp, { cwd, timeoutMs }, spawnWarmUp).finally(() => {
      warmUps.delete(warmUp.lock);
      warmed.add(warmUp.lock);
    });
    warmUps.set(warmUp.lock, pending);
  }
  return pending;
}

async function warmUnderLockAsync(
  warmUp: RunnerWarmUp,
  { cwd, timeoutMs }: { cwd?: string; timeoutMs?: number },
  spawnWarmUp: WarmUpSpawn
): Promise<void> {
  const deadline = Date.now() + (timeoutMs ?? RUNNER_WARM_UP_TIMEOUT_MS);
  try {
    const lock = await acquireMkdirLockAsync(warmUp.lock, {
      staleMs: RUNNER_WARM_UP_STALE_MS,
      heartbeatMs: RUNNER_WARM_UP_HEARTBEAT_MS,
      deadline,
    });
    if (lock == null) {
      return;
    }
    try {
      await spawnWarmUp(warmUp.command, warmUp.args, {
        cwd,
        timeoutMs: Math.max(1, Math.min(RUNNER_WARM_UP_TIMEOUT_MS, deadline - Date.now())),
      });
    } finally {
      lock.release();
    }
  } catch {
    // An unwritable lock directory or a failed spawn: the real spawn still runs.
  }
}

/** What is left of a budget that started at `startedAt`, or undefined for no budget. */
export function remainingMs(timeoutMs: number | undefined, startedAt: number): number | undefined {
  return timeoutMs == null ? undefined : Math.max(1, timeoutMs - (Date.now() - startedAt));
}

/** Run the warm-up with no output, killing its tree at the deadline. */
function spawnWarmUpAsync(
  command: string,
  args: string[],
  { cwd, timeoutMs }: { cwd?: string; timeoutMs: number }
): Promise<void> {
  return new Promise<void>((resolve) => {
    const target = resolveSpawnTarget(command, args);
    const child = spawn(target.command, target.args, {
      cwd,
      stdio: 'ignore',
      shell: target.shell,
      detached: USE_PROCESS_GROUP,
    });
    const timer = setTimeout(() => killProcessTree(child), timeoutMs);
    timer.unref();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('close', done);
    child.once('error', done);
  });
}

function queueFor(key: string): Queue {
  let queue = queues.get(key);
  if (!queue) {
    queue = { held: false, waiting: [] };
    queues.set(key, queue);
  }
  return queue;
}

function lockFor(queue: Queue, queuedMs: number): RunnerLock {
  let released = false;
  return {
    queuedMs,
    release() {
      if (released) {
        return;
      }
      released = true;
      const next = queue.waiting.shift();
      if (next) {
        // Held straight through the handover: dropping `held` between two waiters would let a third
        // acquisition walk past the queue.
        next(true);
        return;
      }
      queue.held = false;
    },
  };
}

/**
 * Take the lock **now**, or answer null because somebody holds it.
 *
 * Synchronous, and that is load-bearing rather than an optimisation: `spawnSubprocessAsync` starts
 * the child in the same tick it is called in, and callers rely on it — a `.then` on the returned
 * promise runs after the process exists, and the tests of the spawn layer emit on the child they
 * mocked without awaiting anything. An `await` on an uncontended lock would move the spawn to a
 * microtask and quietly change that contract for every caller, to buy nothing.
 */
export function tryAcquireRunnerLock(key: string): RunnerLock | null {
  const queue = queueFor(key);
  if (queue.held) {
    return null;
  }
  queue.held = true;
  return lockFor(queue, 0);
}

/**
 * Take the lock for one package spec, waiting for whoever holds it.
 *
 * @param timeoutMs how long to wait before giving up. Unbounded when omitted — which is right for a
 * spawn that has no deadline of its own, and wrong for one that has: a caller who promised to answer
 * within a budget must not spend it invisibly in a queue. Every runner spawn this CLI makes under a
 * deadline passes it.
 * @returns the lock, or null when the wait expired. Null is not an error: the caller reports it as
 * the timeout it is, and the queue is left intact for whoever is behind.
 */
export function acquireRunnerLockAsync(
  key: string,
  { timeoutMs }: { timeoutMs?: number } = {}
): Promise<RunnerLock | null> {
  const free = tryAcquireRunnerLock(key);
  if (free) {
    return Promise.resolve(free);
  }
  const queue = queueFor(key);

  const startedAt = Date.now();
  return new Promise<RunnerLock | null>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const grant = (granted: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(granted ? lockFor(queue, Date.now() - startedAt) : null);
    };

    queue.waiting.push(grant);

    if (timeoutMs != null) {
      timer = setTimeout(() => {
        // Out of the queue first, so the holder's `release` never hands the baton to a waiter that
        // has already given up — which would leave the lock held by nobody.
        const index = queue.waiting.indexOf(grant);
        if (index >= 0) {
          queue.waiting.splice(index, 1);
        }
        grant(false);
      }, timeoutMs);
      // An unreferenced timer never keeps this process alive on its own.
      timer.unref?.();
    }
  });
}

/**
 * Run `work` holding the lock for one package spec.
 *
 * The unbounded form, for a caller with nothing to report a timeout as. A caller that has a deadline
 * uses {@link acquireRunnerLockAsync} and reports the null.
 */
export function withRunnerLockAsync<T>(key: string, work: () => Promise<T>): Promise<T> {
  // The free case starts `work` in this tick, for the reason `tryAcquireRunnerLock` gives.
  const free = tryAcquireRunnerLock(key);
  if (free) {
    return runAndRelease(free, work);
  }
  return acquireRunnerLockAsync(key).then((lock) => runAndRelease(lock!, work));
}

async function runAndRelease<T>(lock: RunnerLock, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } finally {
    lock.release();
  }
}
