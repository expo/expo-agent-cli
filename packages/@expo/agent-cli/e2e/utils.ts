import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { LAST_BUILD_FILE_NAME } from '../src/plan/lastBuild';
import { pathFromEnv } from '../src/utils/pathLookup';

import type { StubDevServer } from './stubDevServer';

/** The `@expo/agent-cli` bin, spawned as a subprocess in every e2e test. Requires `bun run build` first. */
export const bin = path.resolve(__dirname, '../bin/cli.js');

/** Directory holding the committed fixture projects. */
export const fixturesDir = path.resolve(__dirname, 'fixtures');

/** The shared stub `expo` script. Its environment knobs are documented at the top of the file. */
export const STUB_EXPO_SCRIPT = path.resolve(__dirname, 'stubs', 'expo.js');

/**
 * The temporary directory to use when testing projects.
 * This resolves the `EXPO_E2E_TEMP_DIR` environment variable, or uses `os.tmpdir()`.
 */
export const TEMP_DIR = process.env.EXPO_E2E_TEMP_DIR
  ? path.resolve(process.env.EXPO_E2E_TEMP_DIR)
  : os.tmpdir();

/** Generate a random temporary directory path. */
export function getTemporaryPath(): string {
  return path.join(TEMP_DIR, `agent-cli-e2e-${Math.random().toString(36).substring(2)}`);
}

/** Log the full output of child processes, enabled through `EXPO_E2E_VERBOSE`. */
const verboseDefault = !!process.env.EXPO_E2E_VERBOSE;

/** Name of the file the stub `expo` bin appends one JSON line to per invocation. */
export const STUB_EXPO_LOG_NAME = 'stub-expo-invocations.jsonl';

/** Name of the file the stub `fingerprint` bin appends one JSON line to per invocation. */
export const STUB_FINGERPRINT_LOG_NAME = 'stub-fingerprint-invocations.jsonl';

/**
 * Copy a committed fixture project to a fresh temporary directory, and install the stub `expo`
 * bin into it. Every test gets its own copy, so tests never share mutable project state.
 *
 * @param fixtureName Directory name inside `e2e/fixtures`
 * @returns The absolute path of the copied project
 */
export async function setupFixtureAsync(fixtureName: string): Promise<string> {
  const projectRoot = path.join(getTemporaryPath(), fixtureName);
  await fs.promises.mkdir(projectRoot, { recursive: true });
  // `verbatimSymlinks` keeps the copy from dereferencing fixture symlinks into real directories.
  await fs.promises.cp(path.join(fixturesDir, fixtureName), projectRoot, {
    recursive: true,
    verbatimSymlinks: true,
  });
  await installStubExpoAsync(projectRoot);
  return projectRoot;
}

/**
 * Install one stub bin the way npm and pnpm install a real one: a `sh` shim for posix and a `.cmd`
 * shim for Windows, both starting the stub script with the Node that runs the test.
 *
 * Both shims always exist, whatever the platform, because that is the layout the resolvers under
 * test look for — `resolveExpoCli` and friends pick the `.cmd` name on Windows and the bare name
 * everywhere else. A stub that ships only one of them is not testing the resolver, it is testing
 * the fallback.
 *
 * Executable bits are set here instead of committed to git, so the fixtures stay plain files.
 *
 * The name and the script are the caller's: `expo` for the fixtures, `eas` and `create-launch` for
 * the deploy tests, and anything else a command reaches for — including a script that never exits,
 * for a command that has to be tested against a tool that stalls.
 *
 * @param binDir Directory the shims go into, e.g. `node_modules/.bin` or `.stub-bin`
 * @param name Bin name without an extension, e.g. `expo`
 * @param stubScript Absolute path of the Node script the shims run
 */
export async function installStubBinAsync(
  binDir: string,
  name: string,
  stubScript: string
): Promise<void> {
  installStubBinSync(binDir, name, stubScript);
}

function installStubBinSync(binDir: string, name: string, stubScript: string): void {
  fs.mkdirSync(binDir, { recursive: true });

  const shPath = path.join(binDir, name);
  fs.writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${stubScript}" "$@"\n`);
  fs.chmodSync(shPath, 0o755);

  // Windows cannot execute either the shebang script or an extensionless file, so the `.cmd` shim
  // is the only thing a spawn there can reach.
  fs.writeFileSync(
    path.join(binDir, `${name}.cmd`),
    `@echo off\r\n"${process.execPath}" "${stubScript}" %*\r\n`
  );
}

/**
 * Put a decoy `eas` in `binDir`, so a global `eas-cli` later on `PATH` cannot answer in place of
 * the stubs (`src/utils/easCli.ts` §findGlobalEasCli). It is not a package, so the resolver passes
 * over it, and it fails loudly if anything spawns it anyway.
 */
function installEasDecoySync(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  const decoy = path.join(binDir, 'eas-decoy.js');
  fs.writeFileSync(
    decoy,
    "process.stderr.write('decoy eas: the stub runner should have answered\\n');\nprocess.exit(127);\n"
  );
  installStubBinSync(binDir, 'eas', decoy);
}

let easDecoyDir: string | null = null;

/**
 * A `PATH` that reaches only `dirs`, then Node's own directory and the system bins.
 *
 * A decoy `eas` sits between the two. Node's directory is also npm's global bin under nvm,
 * asdf/mise and the nodejs.org installer, so a developer's global `eas-cli` there would otherwise
 * answer, with their own session. `systemDirs` replaces what comes after the decoy.
 */
export function isolatedPath(
  dirs: string[],
  {
    systemDirs = [path.dirname(process.execPath), '/usr/bin', '/bin'],
  }: { systemDirs?: string[] } = {}
): string {
  easDecoyDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-eas-decoy-'));
  installEasDecoySync(easDecoyDir);
  return [...dirs, easDecoyDir, ...systemDirs].join(path.delimiter);
}

/**
 * Install a stub **package runner** that answers for the `eas-cli` package.
 *
 * @ref llp/0015-backend-selection-and-config.rfc.md §Resolving the EAS CLI
 * Every EAS-backed command spawns `npx --yes eas-cli…` or `bunx eas-cli…` unless a recent global
 * `eas-cli` package is first on `PATH`, so a suite that used to plant a bin called `eas` plants a
 * runner instead, plus a decoy `eas` that keeps the machine's own install from answering. An e2e
 * that forgot this would reach the **real** npx and download the real CLI, so these stubs are also
 * what keeps the suite off the network.
 *
 * The runner it stands in for verifies its own argv rather than ignoring it: `--yes` is stripped
 * because that flag is npm's own, and a spec that is not the bare `eas-cli` is an error — npx would
 * treat a package it cannot find the same way, and `eas-cli@latest` is the spec this CLI stopped
 * spawning. What is left is handed to the stub `eas` script, so every existing
 * assertion about the EAS argv keeps its meaning.
 *
 * @param binDir Directory the shims go into, which must be on the `PATH` of the command under test
 * @param easScript Absolute path of the stub `eas` Node script to run for the package
 * @param names Which runners to install. Both, when a test is about which one is chosen.
 */
export async function installStubEasRunnerAsync(
  binDir: string,
  easScript: string,
  {
    names = ['npx'],
    logFile,
    agentDeviceController = false,
  }: { names?: ('npx' | 'bunx')[]; logFile?: string; agentDeviceController?: boolean } = {}
): Promise<void> {
  const runnerScript = path.join(binDir, 'stub-eas-runner.js');
  await fs.promises.mkdir(binDir, { recursive: true });
  await fs.promises.writeFile(
    runnerScript,
    `#!/usr/bin/env node
'use strict';
const args = process.argv.slice(2);
${
  logFile
    ? `require('node:fs').appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, runner: process.env.STUB_RUNNER_NAME || null }) + '\\n');`
    : ''
}
// \`--yes\` is npm's own flag, and never part of what the package is asked to do.
const rest = args[0] === '--yes' ? args.slice(1) : args;
const spec = rest[0] || '';
const isAgentDevice = ${agentDeviceController} && spec === 'agent-device@latest';
if (!isAgentDevice && spec !== 'eas-cli') {
  process.stderr.write('stub runner: no such package ' + JSON.stringify(spec) + '\\n');
  process.exit(1);
}
const result = require('node:child_process').spawnSync(
  process.execPath,
  [${JSON.stringify(easScript)}, ...(isAgentDevice ? ['__controller'] : []), ...rest.slice(1)],
  { stdio: 'inherit' }
);
process.exit(result.status === null ? 1 : result.status);
`
  );
  for (const name of names) {
    await installStubBinAsync(binDir, name, runnerScript);
  }
  // Ahead of the machine's own `eas`, which a suite that inherits `PATH` would otherwise reach.
  installEasDecoySync(binDir);
}

/**
 * Copy the shared stub `expo` script to the bin path the fixture's `expo` package declares, so the
 * copied project runs it the way a real project runs the Expo CLI.
 */
export function installStubExpoScriptSync(projectRoot: string): void {
  const stubScript = path.join(projectRoot, 'node_modules', 'expo', 'bin', 'cli');
  fs.mkdirSync(path.dirname(stubScript), { recursive: true });
  fs.copyFileSync(STUB_EXPO_SCRIPT, stubScript);
}

/**
 * Install the stub `expo` script into a fixture copy, and write the executable shims that make
 * `expo` resolve to it, both through `PATH` (see {@link stubExpoEnv}) and through the project's
 * `node_modules/.bin`.
 */
export async function installStubExpoAsync(projectRoot: string): Promise<void> {
  installStubExpoScriptSync(projectRoot);
  const stubScript = path.join(projectRoot, 'node_modules', 'expo', 'bin', 'cli');
  const dirs = [
    path.join(projectRoot, '.stub-bin'),
    path.join(projectRoot, 'node_modules', '.bin'),
  ];

  for (const dir of dirs) {
    await installStubBinAsync(dir, 'expo', stubScript);
  }
}

/**
 * Write the `node_modules/.bin/fingerprint` shims for a fixture that ships the stub
 * `@expo/fingerprint` package, so the project-state probe finds a fingerprint CLI to spawn.
 *
 * A no-op for fixtures without that package: the probe reports a null hash for those, which is
 * the case most fixtures are there to cover.
 *
 * @returns whether the shims were written
 */
export async function installStubFingerprintAsync(projectRoot: string): Promise<boolean> {
  const stubScript = path.join(projectRoot, 'node_modules', '@expo', 'fingerprint', 'bin', 'cli');
  if (!fs.existsSync(stubScript)) {
    return false;
  }

  await installStubBinAsync(
    path.join(projectRoot, 'node_modules', '.bin'),
    'fingerprint',
    stubScript
  );
  return true;
}

/** Environment that makes any bare `expo` spawn resolve to the fixture's stub bin, which reports through `2g`. */
export function stubExpoEnv(projectRoot: string): Record<string, string> {
  const inherited = pathFromEnv();
  const withStub = `${path.join(projectRoot, '.stub-bin')}${path.delimiter}${inherited}`;
  return { ...pathEnvVars(withStub), STUB_EXPO_2G: TWO_G_PATH };
}

/** The `2g` this package runs, for a stub `expo` that reports its port through it like the real one. */
const TWO_G_PATH = createRequire(import.meta.url).resolve('2g');

/**
 * `PATH`, and on Windows `Path` too, set to the same value.
 *
 * A child that inherits both spellings resolves a bin through whichever one the platform happens
 * to pick. Setting only `PATH` leaves `Path` as the parent's, and a spawn that reads the other
 * spelling misses the stubs.
 */
export function pathEnvVars(value: string): Record<string, string> {
  return process.platform === 'win32' ? { PATH: value, Path: value } : { PATH: value };
}

/** One recorded invocation of the stub `expo` bin. */
export type StubExpoInvocation = {
  /** Arguments the wrapper forwarded, without the bin itself */
  args: string[];
  /** Working directory the subprocess ran in */
  cwd: string;
  /**
   * `CI` as the subprocess saw it, or null when nothing set it.
   *
   * Layer 2 of the needs-human protocol is exactly this variable, and the dev-server step is
   * exactly its exception (llp/0010 §Needs-human protocol), so it is worth recording rather than
   * inferring from behaviour.
   */
  ci: string | null;
  /** Whether the subprocess had a TTY on stdout, which is the other half of that decision. */
  isTTY: boolean;
};

/** Every line of a JSONL file, parsed; `[]` when the file does not exist, as for a stub nothing called. */
export function readJsonLines<T = any>(file: string): T[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/** Read every invocation of the stub `expo` bin recorded for a project. */
export function readStubExpoInvocations(projectRoot: string): StubExpoInvocation[] {
  return readJsonLines<StubExpoInvocation>(path.join(projectRoot, STUB_EXPO_LOG_NAME));
}

/** One recorded invocation of the stub `fingerprint` bin. */
export type StubFingerprintInvocation = {
  /** Arguments the wrapper sent, without the bin itself — so a `--platform` is visible here. */
  args: string[];
  cwd: string;
};

/**
 * Read every invocation of the stub `fingerprint` bin recorded for a project.
 *
 * @ref llp/0023-fingerprint-caching.rfc.md §Proof
 * The only way to observe the caching from outside: a memo hit, a cache hit and a recomputation all
 * print the same hash, and differ only in how many subprocesses were spawned.
 */
export function readStubFingerprintInvocations(projectRoot: string): StubFingerprintInvocation[] {
  return readJsonLines<StubFingerprintInvocation>(
    path.join(projectRoot, STUB_FINGERPRINT_LOG_NAME)
  );
}

/** Forget every invocation recorded so far, so the next command's count starts at zero. */
export function clearStubFingerprintInvocations(projectRoot: string): void {
  fs.rmSync(path.join(projectRoot, STUB_FINGERPRINT_LOG_NAME), { force: true });
}

export type ExecuteResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Interleaved `stdout` and `stderr` */
  all: string;
};

export type ExecuteOptions = {
  /** Extra environment variables for the child process */
  env?: Record<string, string | undefined>;
  /** Throw when the process exits with a non-zero code, defaults to `true` */
  reject?: boolean;
  /** Log the full child process output */
  verbose?: boolean;
};

/**
 * Execute `node bin/cli.js <args>` inside a project, and wait for the process to exit.
 * Output is stripped of ANSI escape codes, so assertions never depend on color support.
 */
export async function executeAgentCliAsync(
  cwd: string,
  args: string[] = [],
  { env, reject = true, verbose = verboseDefault }: ExecuteOptions = {}
): Promise<ExecuteResult> {
  const child = spawnAgentCli(cwd, args, { env });
  const output = collectOutput(
    child,
    verbose ? (chunk) => console.log(`[@expo/agent-cli] ${chunk}`) : undefined
  );
  const result = await waitForExitAsync(child, output);

  if (reject && result.exitCode !== 0) {
    throw new Error(
      `\`@expo/agent-cli ${args.join(' ')}\` exited with ${result.exitCode ?? result.signal}:\n${result.all}`
    );
  }
  return result;
}

/** The Expo home every `@expo/agent-cli` run in `projectRoot` gets from `spawnAgentCli`. */
export function expoHomeOf(projectRoot: string): string {
  return path.join(projectRoot, '.expo-home');
}

/**
 * Spawn `node bin/cli.js <args>` without waiting for it to exit, for long-running commands
 * like `@expo/agent-cli start`. Callers are responsible for killing the process.
 */
export function spawnAgentCli(
  cwd: string,
  args: string[] = [],
  { env }: Pick<ExecuteOptions, 'env'> = {}
): ChildProcess {
  // Strip `npm_config_minimum_release_age` inherited from the repo's bunfig.toml,
  // as it blocks recently published packages without the matching exclusion list.
  const { npm_config_minimum_release_age, ...processEnv } = process.env;

  // Windows environment keys are case-insensitive, but the object handed to `spawn` is not.
  // Remove inherited aliases before applying a test's overrides: otherwise an inherited
  // `NPM_CONFIG_USER_AGENT` can win over the test's `npm_config_user_agent`, and a simulated bunx
  // invocation is observed as npx in the child. This surfaced when the standalone repo began
  // launching Vitest through Bun on Windows.
  if (process.platform === 'win32' && env) {
    const overridden = new Set(Object.keys(env).map((key) => key.toLowerCase()));
    for (const key of Object.keys(processEnv)) {
      if (overridden.has(key.toLowerCase())) {
        delete processEnv[key];
      }
    }
  }

  return spawn(process.execPath, [bin, ...args], {
    cwd,
    // Own process group, so `killAsync` can stop the `expo` subprocess the wrapper spawned too.
    detached: process.platform !== 'win32',
    env: {
      ...processEnv,
      // Deterministic, non-interactive output.
      CI: '1',
      EXPO_NO_TELEMETRY: '1',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      // This tier doubles the dev server, never a device (llp/0002 §Tier 0): without this, a
      // `dev` run on a developer's Mac would boot a real simulator against a stub dev server.
      AGENT_CLI_NO_DEVICE: '1',
      // Per project, so one test's Expo home state never reaches another test or the real home.
      __UNSAFE_EXPO_HOME_DIRECTORY: expoHomeOf(cwd),
      // Setup, `new`, install and a stale search would otherwise download docs from the network.
      AGENT_CLI_NO_DOCS_SYNC: '1',
      ...stubExpoEnv(cwd),
      // `dev` picks the port before the plan and passes it as `--port`, which the stub listens on
      // over its own env var. Expo's default variable makes the two the same port.
      ...(env?.STUB_EXPO_DEV_SERVER_PORT ? { RCT_METRO_PORT: env.STUB_EXPO_DEV_SERVER_PORT } : {}),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Collect the output of a child process, with ANSI escape codes removed. */
export function collectOutput(
  child: ChildProcess,
  onOutput?: (output: string) => void
): { stdout: string; stderr: string; all: string } {
  const collected = { stdout: '', stderr: '', all: '' };

  const collect = (type: 'stdout' | 'stderr', chunk: any) => {
    const output = stripVTControlCharacters(chunk.toString());
    collected[type] += output;
    collected.all += output;
    onOutput?.(output);
  };

  child.stdout?.on('data', (chunk) => collect('stdout', chunk));
  child.stderr?.on('data', (chunk) => collect('stderr', chunk));

  return collected;
}

/** Wait for a child process to exit, and return its exit information with the collected output. */
export async function waitForExitAsync(
  child: ChildProcess,
  output: { stdout: string; stderr: string; all: string }
): Promise<ExecuteResult> {
  const { exitCode, signal } = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once('error', reject);
    // `close` instead of `exit`, so the output streams are fully flushed.
    child.once('close', (code, signal) => resolve({ exitCode: code, signal }));
  });

  return { exitCode, signal, ...output };
}

/**
 * Kill a child process and every subprocess it started, then wait for it to close.
 * The whole group must go, or the `expo` subprocess keeps the output pipes open.
 */
export async function killAsync(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM'
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  try {
    if (process.platform !== 'win32' && child.pid) {
      // A negative PID signals the process group created by `detached: true`.
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The process tree already exited.
  }
  await closed;
}

/** Poll a condition until it becomes true, or the timeout expires. Returns the last result. */
export async function waitForAsync(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100
): Promise<boolean> {
  const endTime = Date.now() + timeoutMs;
  while (!(await check()) && Date.now() < endTime) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return await check();
}

/** The run record a lock holder keeps beside the lock (`src/devLock/runRecord.ts`). */
export function readRunRecord(
  projectRoot: string
): { pid: number; port: number; serverPid: number } | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.expo/agent-cli-dev-run.json'), 'utf8')
    );
  } catch {
    return null;
  }
}

/** Relative path of the file that caches the selected agents between runs. */
export const AGENT_SELECTION_FILE = path.join('.expo', 'agent-skill-links.json');

/**
 * Pre-seed the agent selection a previous `@expo/agent-cli skills` run would have cached. The automatic
 * sync of `install` and `start` only runs when this selection exists.
 */
export async function writeAgentSelectionAsync(
  projectRoot: string,
  agentIds: string[]
): Promise<void> {
  const filePath = path.join(projectRoot, AGENT_SELECTION_FILE);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify({ agents: agentIds }, null, 2));
}

/** Read a project file, or return `null` when it does not exist. */
export function readProjectFile(projectRoot: string, ...segments: string[]): string | null {
  const filePath = path.join(projectRoot, ...segments);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

/** What the dev-server lock of a project answers with, per `src/devLock/types.ts`. */
export type DevLockInfo = {
  url: string;
  port: number;
  pid: number;
  startedAt: string;
  projectRoot: string;
  /** The platform of the EAS Simulator session a `dev --eas` server runs. */
  easPlatform?: 'ios' | 'android';
  /** What the run does now; a lock with no phase reads as `serving`. */
  phase?: 'building' | 'serving' | 'finishing';
};

/**
 * Address of a project's dev-server lock.
 *
 * Deliberately a second implementation of `src/devLock/address.ts`: the lock is a wire contract
 * between two processes that share no code, and a test deriving the address from the code under
 * test could not notice the address changing. If the two disagree, these tests fail.
 */
export function devLockAddress(projectRoot: string): string {
  // Must match `canonicalizeExistingPath` in `src/utils/dir.ts`: Node's JS `realpathSync` does
  // not expand Windows 8.3 names, and the CLI's native realpath does. A test that hashed the
  // short form never found the lock the CLI published.
  const canonical = canonicalLockRoot(projectRoot);
  const digest = crypto
    .createHash('sha1')
    .update(canonical.toLowerCase())
    .digest('hex')
    .slice(0, 16);

  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agent-cli-dev-server-${digest}`;
  }
  const inProject = path.join(canonical, '.expo', 'agent-cli-dev-server.sock');
  // Over the kernel's ~104-byte cap on a socket path, the lock moves to the temporary directory.
  return inProject.length <= 100
    ? inProject
    : path.join(os.tmpdir(), `agent-cli-dev-server-${digest}.sock`);
}

function canonicalLockRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  try {
    const native = fs.realpathSync.native;
    const real = typeof native === 'function' ? native(resolved) : fs.realpathSync(resolved);
    return normalizeLockPath(path.resolve(real));
  } catch {
    return resolved;
  }
}

function normalizeLockPath(value: string): string {
  let result = value;
  if (result.startsWith('\\\\?\\UNC\\')) {
    result = `\\\\${result.slice('\\\\?\\UNC\\'.length)}`;
  } else if (result.startsWith('\\\\?\\')) {
    result = result.slice('\\\\?\\'.length);
  }
  const { root } = path.parse(result);
  while (result.length > root.length && (result.endsWith('\\') || result.endsWith('/'))) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Ask a project's dev-server lock where its dev server listens, or get null when nothing answers.
 *
 * The read is a connection: nothing answers unless a process is holding the address open right
 * now, which is the property these tests are here to check.
 */
export function readDevLockAsync(
  projectRoot: string,
  timeoutMs = 1000
): Promise<DevLockInfo | null> {
  return new Promise((resolve) => {
    let answer = '';
    let settled = false;
    const socket = net.connect(devLockAddress(projectRoot));
    const finish = (info: DevLockInfo | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(info);
    };
    const parse = (): DevLockInfo | null => {
      try {
        return JSON.parse(answer.split('\n')[0]!);
      } catch {
        return null;
      }
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(parse()));
    socket.on('data', (chunk: string) => {
      answer += chunk;
      if (answer.includes('\n')) finish(parse());
    });
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(parse()));
  });
}

/**
 * The top-level `--json` keys a rendered help block names, read back out of the block itself.
 *
 * @ref llp/0006-agent-native-cli-surface.rfc.md §Output contract — **F144.** The `keys` line is a
 * promise about the object the command prints, and a promise nothing compares against the object is
 * one that drifts silently: `status --json` and `runtime:errors --json` both emitted a `followups`
 * array that neither help block named [observed — friction run 9]. Parsing the *rendered* block
 * rather than reading the help spec is the point — it is what a caller reads.
 *
 * The layout is `src/help/format.ts`'s: a `keys` label, then any wrapped rows under it in the same
 * column.
 */
export function documentedJsonKeys(helpOutput: string): string[] {
  const lines = stripVTControlCharacters(helpOutput).split('\n');
  const start = lines.findIndex((line) => /^\s+keys\s{2,}\S/.test(line));
  if (start < 0) {
    return [];
  }
  const rows = [lines[start]!.replace(/^\s+keys\s+/, '')];
  for (const line of lines.slice(start + 1)) {
    // A wrapped row carries no label, so it is indented past the label column. Anything else — the
    // blank line, the next section head — ends the list.
    if (!/^\s{10,}\S/.test(line)) {
      break;
    }
    rows.push(line.trim());
  }
  return rows
    .join(' ')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

/** Poll a project's dev-server lock until it answers, or the timeout expires. */
export async function waitForDevLockAsync(
  projectRoot: string,
  timeoutMs = 30_000,
  intervalMs = 250
): Promise<DevLockInfo | null> {
  const endTime = Date.now() + timeoutMs;
  for (;;) {
    const info = await readDevLockAsync(projectRoot, intervalMs * 2);
    if (info != null || Date.now() >= endTime) {
      return info;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Hold a dev-server lock for a project the way `@expo/agent-cli start` does, so a command under test can
 * read one without a dev server existing.
 *
 * @returns a callback that releases the lock
 */
export async function holdDevLockAsync(
  projectRoot: string,
  info: DevLockInfo
): Promise<() => void> {
  const address = devLockAddress(projectRoot);
  await fs.promises.mkdir(path.dirname(address), { recursive: true });
  await fs.promises.rm(address, { force: true }).catch(() => {});

  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.end(`${JSON.stringify(info)}\n`);
  });
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => resolve());
  });

  return () => {
    server.close();
    if (process.platform !== 'win32') {
      fs.rmSync(address, { force: true });
    }
  };
}

/**
 * Every JSONL event a run wrote to its `LOG_EVENTS` file. `2g` names each one in `_e`.
 *
 * Throws when the file is absent: a run that wrote no log is a different failure than a log
 * without the event a case looks for.
 */
export function readEvents(eventsFile: string): any[] {
  return fs
    .readFileSync(eventsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Point the project's dev-server lock at the stub, the way an `@expo/agent-cli`-started server does. */
export async function holdLockForAsync(
  projectRoot: string,
  stub: StubDevServer
): Promise<() => void> {
  return await holdDevLockAsync(projectRoot, {
    url: stub.url,
    port: stub.port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    projectRoot,
  });
}

/** Where `dev` records the last build, relative to the project root. */
export function lastBuildFilePath(projectRoot: string): string {
  return path.join(projectRoot, '.expo', LAST_BUILD_FILE_NAME);
}

/** The raw last-build file `dev` writes after a build, or null when the run wrote none. */
export function readLastBuildFile(projectRoot: string): unknown {
  const filePath = lastBuildFilePath(projectRoot);
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

/**
 * Make `xcode-select -p` fail in a fixture copy, the way a Mac without Xcode answers.
 *
 * The toolchain probe reads that answer, so a plan made in this project takes the machine for one
 * that cannot build for iOS (llp/0015 §The selection). On a host that is not macOS the probe says
 * so on its own, and this changes nothing.
 */
export async function breakXcodeSelectAsync(projectRoot: string): Promise<void> {
  const binDir = path.join(projectRoot, '.stub-bin');
  const stubScript = path.join(binDir, 'xcode-select-stub.js');
  await fs.promises.mkdir(binDir, { recursive: true });
  await fs.promises.writeFile(
    stubScript,
    "process.stderr.write('xcode-select: error: unable to get active developer directory\\n');\nprocess.exit(2);\n"
  );
  await installStubBinAsync(binDir, 'xcode-select', stubScript);
}

/** Set `extra.eas.projectId` in the fixture's `app.json`, the way `eas init` does. */
export async function linkFixtureToEasAsync(
  projectRoot: string,
  projectId = 'f52a76f7-9fc7-4b59-becd-6d84e9f129d7'
): Promise<void> {
  const configPath = path.join(projectRoot, 'app.json');
  const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
  const expo = config.expo ?? config;
  expo.extra = {
    ...expo.extra,
    eas: { ...expo.extra?.eas, projectId: expo.extra?.eas?.projectId ?? projectId },
  };
  await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
}

/** A port nothing listens on now, read back from a server bound to port 0. */
export async function freePortAsync(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
