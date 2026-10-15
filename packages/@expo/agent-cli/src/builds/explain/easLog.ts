// @ref llp/0012-build-explain.rfc.md §What ships, and what is reserved
// @ref llp/0010-agent-conventions.rfc.md §Upstream asks
// The log of an EAS build, fetched by this CLI because eas-cli has no `build:logs`.
//
// `eas build:view <id> --json` hands back `logFiles`: signed URLs to the build's log files, which
// EAS serves brotli-compressed [observed — eas-cli 22.4, 2026-08-26]. That is a fetch away, and
// this module is the fetch: pick the build (the id given, or the last errored build of the
// platform), read its `logFiles`, download each, decode what arrived compressed, and hand the
// text to the same reader every other source goes through. Every step that can fail names the
// `eas` command a reader would run to see the same thing.

import zlib from 'node:zlib';

import { PROGRAM_PREFIX } from '../../programName';
import { buildViewArgs, describeLookupFailure } from '../../impact/buildCache';
import type { NativePlatform } from '../../plan/types';
import { easCliArgs, easCliLabel, resolveEasCliOrThrow, type EasCli } from '../../utils/easCli';
import { CommandError } from '../../utils/errors';
import { spawnSubprocessAsync } from '../../utils/subprocess';
import { looksLikeWrapperCrash, runnerCrashReason } from '../../utils/wrapperCrash';

/** How long one `eas` question may take. The two asked here answer in about a second, warm. */
export const EAS_LOG_COMMAND_TIMEOUT_MS = 45_000;

/** How long one log file may take to arrive. A build log is megabytes at most. */
export const EAS_LOG_FETCH_TIMEOUT_MS = 60_000;

/** The argv that names the last errored build of one platform. */
export function erroredBuildListArgs(platform: NativePlatform): string[] {
  return [
    'build:list',
    '--platform',
    platform,
    '--status',
    'errored',
    '--limit',
    '1',
    '--json',
    '--non-interactive',
  ];
}

export interface EasBuildLog {
  buildId: string;
  /** The platform the build was made for, as `build:view` reported it. */
  platform: NativePlatform;
  /** How many log files the build had, all of them concatenated into {@link text}. */
  logFiles: number;
  text: string;
}

export interface FetchEasBuildLogOptions {
  platform: NativePlatform;
  /** The build to read, or null for the last errored build of the platform. */
  buildId: string | null;
  /** Overrides {@link EAS_LOG_COMMAND_TIMEOUT_MS}, for tests. */
  commandTimeoutMs?: number;
  /** Overrides {@link EAS_LOG_FETCH_TIMEOUT_MS}, for tests. */
  fetchTimeoutMs?: number;
  /** The fetch to download with. Injected for tests; the global one otherwise. */
  fetchImpl?: typeof fetch;
}

/**
 * The log of one EAS build, as text.
 *
 * @throws {CommandError} `EAS_BUILD_NOT_FOUND` when no build could be named — no errored build of
 *   the platform, an id EAS does not know, or an `eas` that refused; `EAS_BUILD_PLATFORM_MISMATCH`
 *   when the named build is for the other platform; `EAS_BUILD_LOG_UNAVAILABLE` when the build
 *   has no log files or one could not be downloaded.
 */
export async function fetchEasBuildLogAsync(
  projectRoot: string,
  options: FetchEasBuildLogOptions
): Promise<EasBuildLog> {
  const easCli = resolveEasCliOrThrow(projectRoot);
  const timeoutMs = options.commandTimeoutMs ?? EAS_LOG_COMMAND_TIMEOUT_MS;

  const buildId =
    options.buildId ??
    (await findErroredBuildIdAsync(easCli, projectRoot, options.platform, timeoutMs));
  const view = await viewBuildAsync(easCli, projectRoot, buildId, timeoutMs);

  if (view.platform && view.platform !== options.platform) {
    throw new CommandError(
      'EAS_BUILD_PLATFORM_MISMATCH',
      [
        `EAS build ${buildId} is an ${view.platform} build, and this run asked about ${options.platform}.`,
        `Why: the platform flag narrows the rule table to the phases that platform has, and reading an ${view.platform} log under ${options.platform}'s rules would miss the failure.`,
        `How: run "${PROGRAM_PREFIX} inspect:build-log --eas --${view.platform} ${buildId}".`,
      ].join('\n')
    );
  }
  if (view.logFiles.length === 0) {
    const error = new CommandError(
      'EAS_BUILD_LOG_UNAVAILABLE',
      [
        `EAS build ${buildId} has no log files to read.`,
        `Why: "eas build:view ${buildId} --json" named none under "logFiles". A build that never started — cancelled in the queue, or refused before its first step — writes no log.`,
        `How: run "${easCliLabel(easCli)} build:view ${buildId}" to see what EAS has for it, and check the build page on expo.dev.`,
      ].join('\n')
    );
    error.suggestedCommand = `${easCliLabel(easCli)} build:view ${buildId}`;
    throw error;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const parts: string[] = [];
  for (const url of view.logFiles) {
    parts.push(
      await downloadLogAsync(
        fetchImpl,
        url,
        buildId,
        view.platform ?? options.platform,
        options.fetchTimeoutMs
      )
    );
  }
  return {
    buildId,
    platform: view.platform ?? options.platform,
    logFiles: view.logFiles.length,
    // One file after another, each ending in a newline, so the line numbers of the report run
    // through the build in the order EAS wrote it.
    text: parts.map((part) => (part.endsWith('\n') ? part : `${part}\n`)).join(''),
  };
}

/** The id of the last errored build of the platform, or a `EAS_BUILD_NOT_FOUND` error. */
async function findErroredBuildIdAsync(
  easCli: EasCli,
  projectRoot: string,
  platform: NativePlatform,
  timeoutMs: number
): Promise<string> {
  const args = erroredBuildListArgs(platform);
  const result = await runEasAsync(easCli, projectRoot, args, timeoutMs);
  if (result.error) {
    throw notFound(
      easCli,
      `the last errored ${platform} build could not be listed: ${result.error}`,
      args
    );
  }
  const builds = parseJsonPayload(result.stdout);
  const first = Array.isArray(builds) ? builds[0] : null;
  const id = first && typeof first === 'object' ? (first as { id?: unknown }).id : null;
  if (typeof id !== 'string' || !id) {
    throw notFound(
      easCli,
      `EAS has no errored ${platform} build for this project, so there is no failed build to explain`,
      args
    );
  }
  return id;
}

/** What `build:view` says about one build: its platform and its log files. */
async function viewBuildAsync(
  easCli: EasCli,
  projectRoot: string,
  buildId: string,
  timeoutMs: number
): Promise<{ platform: NativePlatform | null; logFiles: string[] }> {
  const args = buildViewArgs(buildId);
  const result = await runEasAsync(easCli, projectRoot, args, timeoutMs);
  if (result.error) {
    throw notFound(easCli, `EAS build ${buildId} could not be read: ${result.error}`, args);
  }
  const payload = parseJsonPayload(result.stdout);
  const build = (Array.isArray(payload) ? payload[0] : payload) as Record<string, unknown> | null;
  if (!build || typeof build !== 'object') {
    throw notFound(
      easCli,
      `"eas build:view ${buildId} --json" printed nothing this CLI could read as a build`,
      args
    );
  }
  const platformValue = typeof build.platform === 'string' ? build.platform.toLowerCase() : null;
  const platform: NativePlatform | null =
    platformValue === 'ios' || platformValue === 'android' ? platformValue : null;
  const logFiles = Array.isArray(build.logFiles)
    ? build.logFiles.filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      )
    : [];
  return { platform, logFiles };
}

/** Run one `eas` question, answering its stdout or the sentence that says why there is none. */
async function runEasAsync(
  easCli: EasCli,
  projectRoot: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; error: string | null }> {
  const result = await spawnSubprocessAsync(easCli.command, easCliArgs(easCli, args), {
    cwd: projectRoot,
    output: 'capture',
    timeoutMs,
  });
  if (result.spawnError) {
    return {
      stdout: '',
      error: `the EAS CLI could not be run ("${easCliLabel(easCli)}": ${result.spawnError.message})`,
    };
  }
  if (result.timedOut) {
    return {
      stdout: '',
      error: `"${easCliLabel(easCli)} ${args[0]}" did not answer within ${timeoutMs}ms`,
    };
  }
  if (result.exitCode !== 0) {
    if (looksLikeWrapperCrash({ tool: 'eas', ...result })) {
      return {
        stdout: '',
        error: runnerCrashReason({ tool: 'eas', exitCode: result.exitCode }, easCliLabel(easCli)),
      };
    }
    return { stdout: '', error: describeLookupFailure(result, easCliLabel(easCli)) };
  }
  return { stdout: result.stdout, error: null };
}

/** The JSON object or array on stdout, past anything the CLI printed ahead of it. */
function parseJsonPayload(stdout: string): unknown {
  const start = stdout.search(/[[{]/);
  if (start < 0) {
    return null;
  }
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

/**
 * One log file, as text.
 *
 * EAS serves the files brotli-compressed. `fetch` decodes a body whose response says so; a file
 * stored compressed with no `content-encoding` arrives as brotli bytes, which is what the
 * `LOG_NOT_TEXT` refusal of `--file` was written for (llp/0012 §Is this a log at all). Here the
 * bytes are in hand, so they are decoded rather than refused: a body that does not read as text
 * is tried as brotli, and only a body that is neither is an error.
 */
async function downloadLogAsync(
  fetchImpl: typeof fetch,
  url: string,
  buildId: string,
  platform: NativePlatform,
  timeoutMs: number = EAS_LOG_FETCH_TIMEOUT_MS
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let bytes: Buffer;
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (cause) {
    throw logUnavailable(
      buildId,
      platform,
      url,
      cause instanceof Error ? cause.message : String(cause)
    );
  } finally {
    clearTimeout(timer);
  }
  return decodeLogBytes(bytes, buildId, platform, url);
}

/** Text out of the bytes of one log file, decoding brotli when that is what arrived. */
export function decodeLogBytes(
  bytes: Buffer,
  buildId: string,
  platform: NativePlatform,
  url: string
): string {
  const asText = bytes.toString('utf8');
  if (looksLikeText(asText)) {
    return asText;
  }
  try {
    return zlib.brotliDecompressSync(bytes).toString('utf8');
  } catch {
    throw logUnavailable(
      buildId,
      platform,
      url,
      'the file is neither text nor brotli-compressed text, so there is nothing here to read'
    );
  }
}

/** The same shape test the file reader applies (llp/0012 §Is this a log at all). */
function looksLikeText(text: string): boolean {
  const sample = text.slice(0, 8_192);
  if (sample.length === 0) {
    return true;
  }
  let control = 0;
  for (const character of sample) {
    const code = character.charCodeAt(0);
    if (
      (code < 0x20 && character !== '\t' && character !== '\n' && character !== '\r') ||
      code === 0x7f ||
      code === 0xfffd
    ) {
      control += 1;
    }
  }
  return control / sample.length <= 0.02;
}

function notFound(easCli: EasCli, why: string, args: string[]): CommandError {
  const error = new CommandError(
    'EAS_BUILD_NOT_FOUND',
    [
      `No EAS build log to explain: ${why}.`,
      `Why: the log is read off the build EAS names, and nothing here could name one.`,
      `How: run "${easCliLabel(easCli)} ${args.filter((arg) => arg !== '--json').join(' ')}" to see what EAS answers, or pass a build id: "${PROGRAM_PREFIX} inspect:build-log --eas --ios <build-id>".`,
    ].join('\n')
  );
  error.suggestedCommand = `${easCliLabel(easCli)} ${args.filter((arg) => arg !== '--json').join(' ')}`;
  return error;
}

function logUnavailable(
  buildId: string,
  platform: NativePlatform,
  url: string,
  why: string
): CommandError {
  const error = new CommandError(
    'EAS_BUILD_LOG_UNAVAILABLE',
    [
      `A log file of EAS build ${buildId} could not be read: ${why}.`,
      `Why: "eas build:view" names the build's log files as signed URLs that expire, and this one did not come back as a log.`,
      `How: run "${PROGRAM_PREFIX} inspect:build-log --eas --${platform} ${buildId}" again for fresh URLs, or open the build on expo.dev and save the log, then pass it with --file. (${url})`,
    ].join('\n')
  );
  return error;
}
