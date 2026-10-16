// @ref llp/0007-deploy-and-headless.rfc.md §deploy — EAS Hosting is the web rail.
// @ref llp/0015-backend-selection-and-config.rfc.md §Resolving the EAS CLI — the single rung.
// The EAS CLI is reached as a subprocess like the rest of the family (llp/0001 constraint 5), so
// the first question of anything that goes through EAS is which `eas` is going to run. A web deploy
// answers it before it exports; every other EAS-backed command answers it the same way, which is
// why the resolver is here and not under `deploy/`.
//
// **Three rungs, in order** [decided, Kudo, 2026-10-16]:
//
//  1. **The project's pin.** A project that declares `eas-cli` gets `<runner> eas-cli`, which the
//     runner resolves out of `node_modules` and touches no network [observed — live, 2026-08-27],
//     in a monorepo whose install is hoisted to the workspace root too.
//  2. **A global `eas-cli`, when it is recent enough.** The first `eas` on `PATH`, spawned directly,
//     but only when it resolves to a package named `eas-cli` at {@link EAS_CLI_GLOBAL_MIN_VERSION}
//     or newer. Read from that package's `package.json`, never by spawning it. `@latest` was asking
//     the registry on every run, and that was the slow part of every EAS-backed command [Kudo,
//     2026-10-16]; an `eas-cli` the developer already installed answers with no network at all.
//  3. **The package runner**, with the bare `eas-cli` spec. `bunx eas-cli@latest` asked the
//     registry and reinstalled on every run, 14–31 s warm, where `bunx eas-cli` ran its cached copy
//     with no request in 2.6–5.8 s. npx revalidates the packument either way (~110 ms) and reuses
//     its cache when the version has not moved [observed — bun 1.3.14, npm 11.17.0, `--verbose` /
//     `--loglevel=http`, 2026-10-16].
//
// The global rung is what wave 18 removed, for the impostor class: what answered the name `eas` was
// whatever the machine had under it — a wrapper, a stale symlink, a shim from another tool (llp/0001
// §Constraints). The package check is what lets it come back. A file that does not resolve to the
// `eas-cli` package — a shell wrapper, a Volta or pnpm shim, a Windows `.cmd` — is not spawned, and
// the runner answers instead, so the cost of a shim this check cannot see through is the old speed
// and never a stranger's bytes. The guards stay as a safety net (`utils/wrapperCrash.ts`).
//
// The one cost left is the first run on a machine with no `eas-cli` anywhere: the runner downloads
// it. Which caller may pay that is a caller's decision rather than this module's, and
// {@link mayDownloadEasCli} is what lets each of them make it — see llp/0015 §Resolving the EAS CLI.

import fs from 'fs';
import path from 'path';
import semver from 'semver';

import { CommandError } from './errors';
import { type Invoker } from './invoker';
import { resolvePackageRunnerForProject } from './packageRunner';
import { findExecutableOnPath } from './subprocess';

/** The `eas` invocation to spawn. */
export interface EasCli {
  /**
   * The executable to spawn: the global `eas` by its absolute path, or the runner — an absolute path
   * for `bunx`, the bare name for `npx`.
   */
  command: string;
  /**
   * What goes before the `eas` command word: the runner's own flags, then the package spec. Empty
   * for a global `eas`.
   *
   * Always spread through {@link easCliArgs} rather than read directly — a call site that spawns
   * `command` with its own argv alone runs `npx build:list`, which is a different program.
   */
  prefixArgs: string[];
  /**
   * The line a reader could paste to run the same CLI: `eas` for a global install, otherwise the
   * runner and the spec, e.g. `npx --yes eas-cli`.
   *
   * A string rather than a rung enum, because what the reader of an event or a failure needs is
   * the line, not the rung. {@link easCliLabel} is the accessor; this field is what carries it into a payload.
   */
  source: string;
  /** Which runner is going to run it, or would have, when {@link EasCli.global} is set. */
  runner: Invoker;
  /**
   * Whether the project declares `eas-cli`, so the runner resolves it out of `node_modules`.
   *
   * The difference between a spawn that costs about a third of a second and one that may install a
   * package first, which is the only thing any caller has to weigh about this rung. Read from the
   * project's `package.json` rather than probed, because the decision it informs has to be made
   * before anything is spawned.
   */
  pinned: boolean;
  /**
   * Whether this is the machine's own `eas-cli`, found on `PATH` and spawned without a runner.
   *
   * Never set together with `pinned`: the project's pin wins over a global install.
   */
  global: boolean;
}

/**
 * The package spec the runner is given, pinned project or not.
 *
 * The bare name, never `eas-cli@latest`. A version in the spec **defeats the pin**: `npx --yes
 * eas-cli@latest` in a project holding 22.4.0 ran 22.6.0, where `npx --yes eas-cli` ran 22.4.0 out
 * of `node_modules` and touched no network [observed — live, 2026-08-27]. In a project with no pin,
 * `@latest` also made `bunx` ask the registry and reinstall on every run, where the bare name runs
 * its cached copy (§module header). npx revalidates against the registry either way, so on a machine
 * that cannot reach one it can still stall for the length of npm's retry ladder [observed — live,
 * 2026-08-27: ~70 s against a dead registry]; callers keep their deadlines.
 */
export const EAS_CLI_PACKAGE = 'eas-cli';

/**
 * The oldest global `eas-cli` this CLI will spawn instead of the runner.
 *
 * An older global install is passed over for the runner rather than trusted to know every command
 * and flag this CLI drives [Kudo, 2026-10-16].
 */
export const EAS_CLI_GLOBAL_MIN_VERSION = '25.0.0';

/** What a global `eas-cli` is written as and spawned under: the bin name its package declares. */
const EAS_CLI_BIN = 'eas';

/** Recovery for a runner that could not be found or spawned, before any EAS CLI could start. */
export const EAS_RUNNER_RECOVERY =
  'check that the package runner ("npx" or "bunx") is installed, executable and on PATH. Repair the Node.js/npm or Bun installation if needed, then run this command again.';

/**
 * What goes before the package spec, per runner.
 *
 * `--yes` for npm's exec because npx **prompts** before installing a package it has not seen —
 * `Need to install the following packages: … Ok to proceed? (y)` — and a prompt is a hang rather
 * than a question here: `spawnSubprocessAsync` never attaches stdin (llp/0006 §Surface improvements
 * parity), so the answer it waits for can never arrive. `bunx` installs without asking and has no
 * such flag [observed — `bunx --help`, bun 1.3.14].
 *
 * A named constant rather than an inline array so the foreign-flag lint counts `--yes`: it is an
 * option this CLI writes onto another program's command line, which is what that inventory is for
 * (llp/0002).
 */
const NPX_RUNNER_ARGS = ['--yes'];

/** The same for bun's exec, which needs nothing. */
const BUNX_RUNNER_ARGS: string[] = [];

/** The argv one `eas` invocation is actually spawned with. */
export function easCliArgs(easCli: EasCli, args: string[]): string[] {
  return [...easCli.prefixArgs, ...args];
}

/**
 * How an EAS CLI command line is **written** for the reader of this project's output.
 *
 * @ref llp/0015-backend-selection-and-config.rfc.md §Resolving the EAS CLI
 * The same spelling this CLI spawns: `eas` when a recent enough `eas-cli` is installed globally,
 * otherwise `npx --yes eas-cli`, or `bunx eas-cli` for a bun project. `npx eas` — the spelling every printed
 * line used to carry — runs nothing: there is no package called `eas` [Kudo, 2026-09-09]. A line a
 * reader is meant to run has to be one that runs, in the package manager they are already using.
 *
 * @param projectRoot the project whose lockfile and pin decide the spelling; the cwd, which is the
 * project for every command of this CLI, when the caller has none in hand.
 */
export function easCommandPrefix(projectRoot: string = process.cwd()): string {
  return easCliInvocation(projectRoot).source;
}

/**
 * How an invocation is written when it has to be named in output.
 *
 * The runner's **name** and its arguments, never the path the runner was found at: `bunx` is what a
 * reader would type, and `/opt/homebrew/bin/bunx eas-cli` is a line that says nothing more while
 * looking like it says something about this machine. The path is still what gets spawned. A global
 * install is written `eas`, for the same reason.
 */
export function easCliLabel(easCli: EasCli): string {
  return easCli.source;
}

/**
 * Whether this invocation may have to install the CLI before it can answer.
 *
 * The question every caller with a deadline has to ask. False for a project that declares
 * `eas-cli`: the runner resolves it out of `node_modules`, and the spawn is then as cheap as running
 * the bin directly [observed — 0.26–0.45 s against 0.32–0.42 s, live, 2026-08-27]. False for a
 * global install, which is the bin directly. True otherwise, even though a warm runner cache answers
 * without a download: whether the cache is warm is not something to find out before spawning.
 */
export function mayDownloadEasCli(easCli: EasCli | null): boolean {
  return easCli != null && !easCli.pinned && !easCli.global;
}

/**
 * Whether the project declares `eas-cli`, as a dependency or a dev dependency.
 *
 * A **declaration**, not an installed copy. It decides the package spec, and the spec has to be
 * chosen before anything runs; walking `node_modules` to find out whether the declaration was
 * honoured would answer a different question more slowly. A project that declares it and has not
 * installed it gets `npx --yes eas-cli`, and npx installs the declared range — which is the version
 * the project asked for either way.
 *
 * The known gap: a package that does *not* declare it while a sibling workspace does is treated as
 * unpinned, so it may take the global rung, or the runner's cache, rather than the sibling's copy. That is the honest reading of "this
 * project pinned a version", and the cost is one download rather than a wrong version.
 *
 * Sync, and never throws: a `package.json` that is missing, unreadable or not an object reads as
 * "does not declare it", which costs the pin and never the command.
 */
export function projectDeclaresEasCli(projectRoot: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  } catch {
    return false;
  }
  if (parsed == null || typeof parsed !== 'object') {
    return false;
  }
  const manifest = parsed as { dependencies?: unknown; devDependencies?: unknown };
  return declaresEasCli(manifest.dependencies) || declaresEasCli(manifest.devDependencies);
}

function declaresEasCli(field: unknown): boolean {
  return field != null && typeof field === 'object' && EAS_CLI_PACKAGE in field;
}

/**
 * The machine's own `eas-cli`, when the first `eas` on `PATH` is one at
 * {@link EAS_CLI_GLOBAL_MIN_VERSION} or newer; otherwise null.
 *
 * Only the **first** `eas`, because that is the one the reader's shell runs: a recent install
 * further down `PATH` behind an old one is not what `eas` means on this machine, and the line this
 * CLI prints has to mean what it says.
 *
 * The check follows the bin's symlink to the package it belongs to and reads that package's
 * `package.json` — the layout npm, Homebrew's npm, nvm and `bun add -g` all leave behind. A bin that
 * is not a symlink into an `eas-cli` package is null, whatever it would have printed.
 *
 * Sync, never spawns, and never throws: anything unreadable reads as "no global eas-cli", which
 * costs the speed and never the command.
 */
export function findGlobalEasCli({ pathEnv }: { pathEnv?: string } = {}): string | null {
  const bin = findExecutableOnPath(EAS_CLI_BIN, { pathEnv });
  if (!bin) {
    return null;
  }
  try {
    const manifest = nearestPackageJson(fs.realpathSync(bin));
    if (manifest?.name !== EAS_CLI_PACKAGE || typeof manifest.version !== 'string') {
      return null;
    }
    const version = semver.valid(manifest.version);
    return version && semver.gte(version, EAS_CLI_GLOBAL_MIN_VERSION) ? bin : null;
  } catch {
    return null;
  }
}

/** The `package.json` of the package a file is in: the first one found walking up from it. */
function nearestPackageJson(file: string): { name?: unknown; version?: unknown } | null {
  let dir = path.dirname(file);
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      return parsed != null && typeof parsed === 'object' ? parsed : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * The invocation that runs the EAS CLI for a project, whether or not one is installed.
 *
 * The three rungs of the module header: the project's pin through the runner, then a global
 * `eas-cli` new enough to trust, then the runner. Never reaches into `node_modules/.bin`: the runner
 * does that job better.
 *
 * **Ungated**, so it always answers with something to spawn — for a caller whose report of a spawn
 * that failed is honest on its own, like the auth passthrough, which prints what the runner said. A
 * caller that has to tell "nothing here can ask EAS" apart from "EAS said no" uses
 * {@link resolveEasCli}.
 *
 * @param pathEnv `PATH` to search for the runner, for tests that must not depend on the machine's own.
 * @param env the environment to read the invoking runner from, for the same reason.
 */
export function easCliInvocation(
  projectRoot: string,
  { pathEnv, env }: { pathEnv?: string; env?: NodeJS.ProcessEnv } = {}
): EasCli {
  const runner = resolvePackageRunnerForProject(projectRoot, { env, pathEnv });
  const pinned = projectDeclaresEasCli(projectRoot);
  const globalEas = pinned ? null : findGlobalEasCli({ pathEnv });
  if (globalEas) {
    return {
      command: globalEas,
      prefixArgs: [],
      source: EAS_CLI_BIN,
      runner: runner.runner,
      pinned: false,
      global: true,
    };
  }
  const prefixArgs = [
    ...(runner.runner === 'npx' ? NPX_RUNNER_ARGS : BUNX_RUNNER_ARGS),
    EAS_CLI_PACKAGE,
  ];
  return {
    command: runner.command,
    prefixArgs,
    source: [runner.runner, ...prefixArgs].join(' '),
    runner: runner.runner,
    pinned,
    global: false,
  };
}

/**
 * The same invocation, or `null` when the runner itself cannot be reached from here.
 *
 * `null` is a much narrower answer than the old resolver's: not "no EAS CLI is installed" — the
 * runner would have fetched one — but "this machine has no `npx` and no `bunx`", which is a broken
 * or absent Node install. Callers that must never fail for want of EAS still handle it, and their
 * reasons say so in those terms.
 *
 * The gate is what keeps that honest. `resolvePackageRunner` deliberately leaves `npx` a bare name —
 * resolved through `PATH` by the spawn, the way it always was — so the *name* is what is looked up
 * here, and what gets spawned is still whatever that module returned.
 */
export function resolveEasCli(
  projectRoot: string,
  { pathEnv, env }: { pathEnv?: string; env?: NodeJS.ProcessEnv } = {}
): EasCli | null {
  const easCli = easCliInvocation(projectRoot, { pathEnv, env });
  if (easCli.global || path.isAbsolute(easCli.command)) {
    return easCli;
  }
  return findExecutableOnPath(easCli.command, { pathEnv }) ? easCli : null;
}

/**
 * Resolve the EAS CLI for a caller that cannot do its job without one.
 *
 * @param pathEnv `PATH` to search, for tests that must not depend on the machine's own.
 * @throws {CommandError} `EAS_CLI_MISSING` when no package runner can be reached.
 */
export function resolveEasCliOrThrow(
  projectRoot: string,
  { pathEnv, env }: { pathEnv?: string; env?: NodeJS.ProcessEnv } = {}
): EasCli {
  const resolved = resolveEasCli(projectRoot, { pathEnv, env });
  if (resolved) {
    return resolved;
  }

  // Reaching here is not "you have not installed eas-cli" — this CLI would have run the published
  // one — so `npm install -g eas-cli` is not the advice: it is a command the reader cannot run
  // either, for the same reason nothing else here worked.
  const error = new CommandError(
    'EAS_CLI_MISSING',
    [
      `The EAS CLI could not be reached, so this command cannot run.`,
      `Why: this CLI runs the published eas-cli through a package runner, and no package runner ("npx" or "bunx") was found on PATH — so there is nothing here that can start it.`,
      `How: ${EAS_RUNNER_RECOVERY}`,
    ].join('\n')
  );
  throw error;
}
