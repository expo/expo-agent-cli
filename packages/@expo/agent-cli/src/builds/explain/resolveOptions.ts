// @ref llp/0012-build-explain.rfc.md §What ships, and what is reserved
// Argument resolution for `@expo/agent-cli inspect:build-log`. Pure: argv in, options out, `CommandError` for
// anything a caller can get wrong, so every combination is unit-testable without a log.

import path from 'node:path';

import { buildLogPath } from '../../dev/buildLog';
import type { NativePlatform } from '../../plan/types';
import { PROGRAM_NAME, PROGRAM_PREFIX } from '../../programName';
import { parseArgsOrThrow } from '../../utils/args';
import { CommandError } from '../../utils/errors';
import { DEFAULT_CONTEXT_AFTER, DEFAULT_CONTEXT_BEFORE } from './extract';

/** Where the log comes from. */
export type ExplainSourceOption =
  | { kind: 'file'; path: string }
  | { kind: 'stdin' }
  /** The last native build `@expo/agent-cli dev` ran for this platform (`src/dev/buildLog.ts`). */
  | { kind: 'local'; platform: NativePlatform; path: string }
  /** An EAS build's log, fetched by id or as the platform's last errored build (`./easLog.ts`). */
  | { kind: 'eas'; platform: NativePlatform; buildId: string | null };

export interface ExplainOptions {
  source: ExplainSourceOption;
  /** The `--ios` / `--android` hint, which narrows the rule table. Null when the caller passed none. */
  platform: 'ios' | 'android' | null;
  contextBefore: number;
  contextAfter: number;
  /** Report every match, not only the one the failing phase produced. */
  all: boolean;
  json: boolean;
  followups: boolean;
}

const EXPLAIN_ARGS = {
  '--file': String,
  '--stdin': Boolean,
  '--local': Boolean,
  '--eas': Boolean,
  '--ios': Boolean,
  '--android': Boolean,
  '--context': String,
  '--all': Boolean,
  '--json': Boolean,
  '--no-followups': Boolean,
  '-f': '--file',
  // Accepted only to explain what replaced it, see `resolvePlatform`.
  '--platform': String,
};

export interface ResolveExplainContext {
  /** Whether stdin is a terminal. Injected so the resolver stays pure and testable. */
  stdinIsTTY: boolean;
  /** Where a relative `--file` is resolved from. */
  cwd: string;
  /**
   * The project whose last local build `--local` reads. Asked only then, because `--file` and
   * `--stdin` explain a log from anywhere and must not require a project around the caller.
   */
  projectRoot?: () => string;
}

/**
 * Resolve the arguments of `@expo/agent-cli inspect:build-log`.
 *
 * @throws {CommandError} `BAD_ARGS` for two input sources, `--local` or `--eas` with no platform,
 *   a build id beside a source that is not EAS, both platform flags, the retired `--platform`, an
 *   unusable `--context`, or no input source at all on a terminal.
 */
export function resolveExplainOptions(
  argv: string[],
  { stdinIsTTY, cwd, projectRoot }: ResolveExplainContext
): ExplainOptions {
  const args = parseArgsOrThrow(EXPLAIN_ARGS, argv, 'inspect:build-log');
  const positional = args._.map(String);
  // A build id is the EAS form: `inspect:build-log <build-id>` is the command an agent reaches for.
  const buildId = resolveBuildId(positional);
  const eas = !!args['--eas'] || buildId != null;

  const file = args['--file'];
  const stdin = !!args['--stdin'];
  const local = !!args['--local'];
  const named = [
    file ? `--file ${file}` : null,
    stdin ? '--stdin' : null,
    local ? '--local' : null,
    eas ? (buildId ? `the build id ${buildId}` : '--eas') : null,
  ].filter((flag): flag is string => flag != null);
  if (named.length > 1) {
    throw new CommandError(
      'BAD_ARGS',
      [
        `${named.join(' and ')} were passed, and a report is about one log.`,
        `Why: reading two sources would mean either concatenating logs from different builds or silently ignoring one of them, and both produce a report that is about no single run.`,
        `How: pass one of "--file <path>" for a saved log, "--stdin" for what is piped in, "--local --ios|--android" for the last build ${PROGRAM_NAME} dev ran here, or "--eas --ios|--android [<build-id>]" for an EAS build's.`,
      ].join('\n')
    );
  }

  const platform = resolvePlatform({
    ios: !!args['--ios'],
    android: !!args['--android'],
    retired: args['--platform'],
  });
  const source = local
    ? resolveLocalSource(platform, projectRoot)
    : eas
      ? resolveEasSource(platform, buildId)
      : resolveSource({ file, stdin, stdinIsTTY, cwd });
  const context = resolveContext(args['--context']);

  return {
    source,
    platform,
    contextBefore: context?.before ?? DEFAULT_CONTEXT_BEFORE,
    contextAfter: context?.after ?? DEFAULT_CONTEXT_AFTER,
    all: !!args['--all'],
    json: !!args['--json'],
    followups: !args['--no-followups'],
  };
}

/**
 * The one positional this command takes: an EAS build id.
 *
 * @throws {CommandError} `BAD_ARGS` for more than one.
 */
function resolveBuildId(positional: string[]): string | null {
  if (positional.length === 0) {
    return null;
  }
  if (positional.length > 1) {
    throw new CommandError(
      'BAD_ARGS',
      [
        `${positional.length} arguments were passed, and this command reads one EAS build id.`,
        `Why: "${PROGRAM_PREFIX} inspect:build-log <build-id>" explains the log of that one EAS build; a second argument names nothing.`,
        `How: run "${PROGRAM_PREFIX} inspect:build-log --eas --ios|--android ${positional[0]}".`,
      ].join('\n')
    );
  }
  return positional[0]!.trim() || null;
}

/**
 * An EAS build's log: the id given, or the last errored build of the platform.
 *
 * The platform is required for the same reason `--local` requires it — and with an id it is
 * checked against the build's own, because a log read under the other platform's rules would
 * miss the failure (`./easLog.ts`).
 *
 * @throws {CommandError} `BAD_ARGS` with no platform.
 */
function resolveEasSource(
  platform: NativePlatform | null,
  buildId: string | null
): ExplainOptions['source'] {
  if (!platform) {
    const error = new CommandError(
      'BAD_ARGS',
      [
        `--eas needs the platform whose build to read: --ios or --android.`,
        `Why: EAS builds are per platform, and the last errored build of one is not the last errored build of the other; with a build id, the flag also picks the rules the log is read under.`,
        `How: run "${PROGRAM_PREFIX} inspect:build-log --eas --ios${buildId ? ` ${buildId}` : ''}" or "${PROGRAM_PREFIX} inspect:build-log --eas --android${buildId ? ` ${buildId}` : ''}".`,
      ].join('\n')
    );
    error.suggestedCommand = `${PROGRAM_PREFIX} inspect:build-log --eas --ios${buildId ? ` ${buildId}` : ''}`;
    throw error;
  }
  return { kind: 'eas', platform, buildId };
}

/**
 * The last native build `@expo/agent-cli dev` ran here, for one platform.
 *
 * The platform is required rather than defaulted: a project builds for two, the two logs are two
 * files, and a default picked by this CLI would explain a build the caller may not have meant.
 *
 * @throws {CommandError} `BAD_ARGS` with no platform, or with no project around the caller.
 */
function resolveLocalSource(
  platform: NativePlatform | null,
  projectRoot: (() => string) | undefined
): ExplainOptions['source'] {
  if (!platform) {
    const error = new CommandError(
      'BAD_ARGS',
      [
        `--local needs the platform whose last build to read: --ios or --android.`,
        `Why: ${PROGRAM_NAME} dev keeps one build log per platform, and a default picked here would explain a build you may not have meant.`,
        `How: run "${PROGRAM_PREFIX} inspect:build-log --local --ios" or "${PROGRAM_PREFIX} inspect:build-log --local --android".`,
      ].join('\n')
    );
    error.suggestedCommand = `${PROGRAM_PREFIX} inspect:build-log --local --ios`;
    throw error;
  }
  if (!projectRoot) {
    throw new CommandError('BAD_ARGS', `--local needs a project to read the last build of.`);
  }
  return { kind: 'local', platform, path: buildLogPath(projectRoot(), platform) };
}

/**
 * Which of the two sources this run reads.
 *
 * With neither flag, a run whose stdin is *not* a terminal is being piped to, so `--stdin` is
 * implied — `eas build:view … | @expo/agent-cli inspect:build-log` is the shape the command is for. A run on
 * a terminal with neither flag has nothing to read and is told so, rather than blocking forever
 * on a stdin nobody is going to write to.
 */
function resolveSource({
  file,
  stdin,
  stdinIsTTY,
  cwd,
}: {
  file?: string;
  stdin: boolean;
  stdinIsTTY: boolean;
  cwd: string;
}): ExplainOptions['source'] {
  if (file) {
    return { kind: 'file', path: path.resolve(cwd, file) };
  }
  if (stdin || !stdinIsTTY) {
    return { kind: 'stdin' };
  }
  const error = new CommandError(
    'BAD_ARGS',
    [
      `No log to explain: none of --file, --stdin, --local or --eas was passed, and stdin is a terminal.`,
      `Why: this command reads a build log and reports what failed in it. On a terminal there is nothing being piped in, so waiting on stdin would hang instead of answering.`,
      `How: run "${PROGRAM_PREFIX} inspect:build-log --local --ios" for the last build ${PROGRAM_NAME} dev ran here, "${PROGRAM_PREFIX} inspect:build-log --file <path>" for a saved log, or pipe one in: "cat build.log | ${PROGRAM_PREFIX} inspect:build-log".`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} inspect:build-log --help`;
  throw error;
}

/**
 * The platform hint, or null.
 *
 * `--ios` / `--android`, the spelling `dev` and `smoke` take [decided — Kudo, 2026-09-15], so one
 * platform is written one way across the CLI. `--platform ios|android` was this command's own
 * spelling until then; it is accepted only to say what replaced it, the way `deploy` answers the
 * flags of its retired rail.
 *
 * @throws {CommandError} `BAD_ARGS` for both flags at once, or for the retired one.
 */
function resolvePlatform({
  ios,
  android,
  retired,
}: {
  ios: boolean;
  android: boolean;
  retired?: string;
}): 'ios' | 'android' | null {
  if (retired != null) {
    const value = retired.toLowerCase();
    const replacement =
      value === 'ios' || value === 'android' ? `--${value}` : '--ios or --android';
    const error = new CommandError(
      'BAD_ARGS',
      [
        `--platform is not an option of this command any more; the platform is ${replacement}.`,
        `Why: the dev and smoke commands name a platform as --ios or --android, and one platform written two ways across one CLI is a flag to look up every time. The hint still does what it did: it narrows the rule table to the phases that platform has — pod install and xcodebuild for ios, gradle for android.`,
        `How: pass ${replacement} instead, or leave it off and let the log decide.`,
      ].join('\n')
    );
    error.suggestedCommand = `${PROGRAM_PREFIX} inspect:build-log --help`;
    throw error;
  }
  if (ios && android) {
    throw new CommandError(
      'BAD_ARGS',
      [
        `Both --ios and --android were passed, and a build log is about one platform.`,
        `Why: the flag narrows the rule table to the phases one platform has, so naming both narrows it to nothing it would not have had anyway.`,
        `How: pass the one the log is from, or leave both off and let the log decide.`,
      ].join('\n')
    );
  }
  return ios ? 'ios' : android ? 'android' : null;
}

/**
 * How many lines of context to report, from `--context <n>` or `--context <before>:<after>`.
 *
 * One number sets both. The default is asymmetric (8 before, 20 after) because a compiler puts
 * its detail under its diagnostic, and the two-part form is how a caller keeps that asymmetry
 * while changing the size.
 */
function resolveContext(value?: string): { before: number; after: number } | null {
  if (value == null) {
    return null;
  }
  const parts = value.split(':');
  if (parts.length > 2) {
    throw badContext(value);
  }
  const numbers = parts.map((part) => {
    if (!/^\d+$/.test(part.trim())) {
      throw badContext(value);
    }
    return Number(part.trim());
  });
  const before = numbers[0]!;
  return { before, after: numbers[1] ?? before };
}

function badContext(value: string): CommandError {
  return new CommandError(
    'BAD_ARGS',
    [
      `--context ${value} is not a line count.`,
      `Why: the value says how many lines around the match to report, so it has to be a whole number of lines, or two of them separated by a colon.`,
      `How: pass "--context 12" for twelve lines each side, or "--context 8:20" for eight before and twenty after.`,
    ].join('\n')
  );
}
