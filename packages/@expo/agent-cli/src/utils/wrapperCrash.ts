// @ref llp/0001-agentic-cli-on-expo-cli.rfc.md §Constraints — every CLI of the family is reached
// across a process boundary, which means the thing on the other side is whatever the machine has
// under that name. Usually it is the CLI. Sometimes it is a wrapper, a shim, a stale symlink or a
// binary from another project entirely, and then the bytes it printed are not Expo output at all.
//
// Quoting those bytes under "What the tool printed" is worse than printing nothing: it tells the
// reader that the EAS CLI reported a missing file, and an agent then goes looking for that file.
// This module is the one guard against that — a conservative test for "the process did not run as
// the CLI at all", and the sentence to print instead.
//
// Conservative on purpose. A false positive hides real output from a real failure, so both halves
// have to agree: the output must hold *nothing* that looks like the CLI's, **and** the process
// must have died the way a wrapper dies (a panic, or one of the shell's own "could not run it"
// codes).

import path from 'path';

/** Which CLI was supposed to be on the other side of the spawn. */
export type WrapperCrashTool = 'eas' | 'expo';

/**
 * Fragments that only appear in output the Expo family produced.
 *
 * The bar is "would a wrapper print this by accident", not "does every failure contain one": a
 * miss here costs a slightly vaguer error, while a hit on foreign output costs the whole guard.
 */
const CLI_MARKERS: Record<WrapperCrashTool, RegExp[]> = {
  eas: [/\beas[\s-]/i, /\bexpo\b/i, /expo\.dev/i, /EXPO_TOKEN/],
  expo: [/\bexpo\b/i, /\bmetro\b/i, /CommandError/, /EXPO_TOKEN/],
};

/**
 * How a process that is not the CLI dies.
 *
 * A Rust wrapper panics and prints a backtrace; a native binary aborts or segfaults; a shell that
 * cannot find or execute the target says so with a code and no output at all.
 */
const CRASH_SIGNATURES = [
  /Stack backtrace:/i,
  /panicked at/i,
  /RUST_BACKTRACE/,
  /Segmentation fault/i,
  /Abort trap/i,
  /core dumped/i,
];

/**
 * Exit codes that mean the process never ran as the program it was named for.
 *
 * `101` is the Rust panic code, `126`/`127` are the shell's "cannot execute" and "not found", and
 * `134`/`139` are `SIGABRT` and `SIGSEGV` as a shell reports them.
 */
const CRASH_EXIT_CODES = new Set([101, 126, 127, 134, 139]);

export interface WrapperCrashInput {
  tool: WrapperCrashTool;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Whether a failed spawn looks like the binary was never the CLI.
 *
 * Both halves are required, which is what keeps a real failure's output on screen: a real CLI
 * failure names its own tool somewhere in the hundreds of bytes it printed, and a real CLI does
 * not exit `101`.
 */
export function looksLikeWrapperCrash({
  tool,
  exitCode,
  stdout,
  stderr,
}: WrapperCrashInput): boolean {
  if (exitCode === 0 || exitCode == null) {
    // A clean exit is not a crash, and a process that never started is reported as a spawn error
    // by the caller, with the errno that explains it.
    return false;
  }

  const output = `${stderr}\n${stdout}`;
  if (CLI_MARKERS[tool].some((marker) => marker.test(output))) {
    return false;
  }

  return CRASH_EXIT_CODES.has(exitCode) || CRASH_SIGNATURES.some((sig) => sig.test(output));
}

/**
 * What to print instead of the tool's output, when the tool was not the tool.
 *
 * Names the path, because that is the one fact that resolves this: the reader has to look at the
 * file that ran, not at the package they believe they installed.
 */
export function wrapperCrashDetail(
  { tool, exitCode }: Pick<WrapperCrashInput, 'tool' | 'exitCode'>,
  binPath: string
): string {
  return [
    ``,
    `What ran instead:`,
    `The ${tool} at ${binPath} failed to run at all (this may not be the real CLI): it exited with code ${exitCode} and printed nothing an ${tool} run would print.`,
    `Check that file — a wrapper script, a shim, or a stale link under that name will fail this way however the command is spelled.`,
  ].join('\n');
}

/**
 * The same fact as {@link wrapperCrashDetail}, as one sentence.
 *
 * For a report field that holds a *reason* rather than a message — `status`'s per-platform build
 * lookup is the case: it never fails the command, so what a reader gets is one line, and that line
 * is printed as what EAS answered about their account. A panic quoted there is a sentence about
 * their builds that no Expo service ever said.
 */
export function wrapperCrashReason(
  { tool, exitCode }: Pick<WrapperCrashInput, 'tool' | 'exitCode'>,
  binPath: string
): string {
  return (
    `the ${tool} at ${binPath} exited ${exitCode} and printed nothing an ${tool} run would print, ` +
    `so it may not be the real CLI — check that file`
  );
}

/**
 * The same two facts, for a tool this CLI reaches through a **package runner** rather than a file.
 *
 * `npx --yes eas-cli@latest` is not a file, so "check that file" is advice a reader cannot take, and
 * "a wrapper script, a shim, or a stale link under that name" describes a hazard that a runner does
 * not have — it resolves a package (`src/utils/easCli.ts`). What is worth saying instead is what the
 * package resolved to here, because a project holding a broken or shadowed `eas-cli` is the only way
 * this sentence can be reached at all.
 *
 * **Both of these should be unreachable**, and are kept for the reason the guard they belong to is
 * kept: "unreachable" is a claim about today's resolver, not about the process boundary
 * (llp/0001 §Constraints).
 */
export function runnerCrashDetail(
  { tool, exitCode }: Pick<WrapperCrashInput, 'tool' | 'exitCode'>,
  invocation: string
): string {
  return [
    ``,
    `What ran instead:`,
    `"${invocation}" failed to run at all (this may not be the real CLI): it exited with code ${exitCode} and printed nothing an ${tool} run would print.`,
    `Check what that package resolves to in this project — a broken or shadowed install of it will fail this way however the command is spelled.`,
  ].join('\n');
}

/** The one-sentence form of {@link runnerCrashDetail}, for a report field that holds a reason. */
export function runnerCrashReason(
  { tool, exitCode }: Pick<WrapperCrashInput, 'tool' | 'exitCode'>,
  invocation: string
): string {
  return (
    `"${invocation}" exited ${exitCode} and printed nothing an ${tool} run would print, ` +
    `so it may not be the real CLI — check what that package resolves to in this project`
  );
}

/**
 * Lines only a package **runner** prints: its own resolution, download and install progress.
 *
 * The vocabulary of two other tools, anchored where it can be. `bunx` writes the first three on every
 * run it has to install for [observed — bun 1.3.14], and npm's exec writes the rest. `npx --yes`
 * on an empty cache writes `npm warn deprecated …` before the CLI runs and `npm notice …` after it
 * [observed — npm 10.9.4, 2026-10-07]. `npm error` is left out: that is the runner failing, and it is
 * the reason.
 *
 * Deliberately not a list of every line either tool can print. It is the list of lines that mean
 * "I was still fetching the package", which is the only state that produces the failure this guards.
 */
const RUNNER_NOISE = [
  /^Resolving dependencies\b/i,
  /^Resolved,? downloaded and extracted\b/i,
  /^Saved lockfile\b/i,
  /^\s*[+-]?\s*installed \d+ packages?\b/i,
  /^npm (warn|notice)\b/i,
  /^Need to install the following packages\b/i,
  /^Ok to proceed\? \(y\)/i,
  /^bun install v/i,
];

/**
 * The output with the runner's own lines removed.
 *
 * @ref src/utils/runnerLock.ts — F93. Quoted into a report field that holds a *reason*, a runner's
 * line reads as what EAS said about the caller's builds: `reason: "Resolving dependencies"`
 * [observed — live, 2026-08-27]. On a cold scratch directory the runner prints first and the CLI
 * prints after it on the same stream, so the CLI's sentence is the first line left
 * [observed — 2026-10-05]. `readEasFailure` in `./easFailure.ts` is the one reader.
 *
 * Not the marker veto that guards a wrapper crash: the runner's noise *names the package*, so
 * `npm warn exec … will be installed: eas-cli@latest` matches an EAS marker.
 */
export function withoutRunnerNoise(output: string): string {
  return output
    .split('\n')
    .filter((line) => !RUNNER_NOISE.some((pattern) => pattern.test(line.trim())))
    .join('\n');
}

/**
 * What to say when the runner never delivered the CLI, for a field that holds a reason.
 *
 * The claim is about the **runner**, and it is the whole point: this is not the service refusing and
 * not a broken install of the package either — it is `bunx` or `npx` exiting before the CLI ran. So
 * the line it printed is quoted *as the runner's*. A retry may finish the download; repeated failures
 * need the runner's registry/network error, not a new dependency in the user's project.
 */
export function runnerNoiseReason(
  { tool, exitCode }: Pick<WrapperCrashInput, 'tool' | 'exitCode'>,
  invocation: string,
  noiseLine: string | null
): string {
  const service = tool === 'eas' ? 'EAS' : 'the Expo CLI';
  return (
    `"${invocation}" failed to deliver the ${tool} CLI: it exited ${exitCode ?? 'on a signal'} having printed only its own ` +
    `install progress${noiseLine ? ` ("${noiseLine}")` : ''} and nothing an ${tool} run would print, ` +
    `so nothing here is ${service}'s answer — run it again to retry the download; ` +
    `if it keeps failing, check the runner's output and access to the package registry`
  );
}

/**
 * The command that reproduces a failure against the binary that actually ran.
 *
 * `npx eas-cli whoami` checks a *different* program than the one that just failed, so a reader who
 * runs it may see a healthy answer from a package that was never involved. The path is quoted when
 * it holds a space, so the line can be pasted.
 */
export function checkBinaryCommand(binPath: string, args: string[]): string {
  const quoted = /\s/.test(binPath) ? `"${binPath}"` : binPath;
  return [quoted, ...args].join(' ');
}

/** The bare file name of a resolved binary, for a sentence that names it without the path. */
export function binaryName(binPath: string): string {
  return path.basename(binPath);
}
