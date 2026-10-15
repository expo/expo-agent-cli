// @ref llp/0012-build-explain.rfc.md §Which match wins
//
// Turn a segmented log into one located failure. Pure: lines and phases in, data out — no file
// system, no network, no subprocess. That is what makes "deterministic extraction, not model
// summarization" a checkable claim rather than a slogan: the same log always produces the same
// answer, and a fixture pins it.

import { type Anchor, anchorFor } from './anchors';
import { markPhaseStatuses, phaseAllowedOnPlatform, phaseIndexForLine } from './phases';
import type { Confidence, ErrorLine, Failure, Phase } from './types';

/** How many lines of context a report carries when the caller names none. */
export const DEFAULT_CONTEXT_BEFORE = 8;

/**
 * Context *after* the match is larger than before it, and deliberately.
 *
 * A compiler prints the cause first and the detail under it — the code frame, the candidate paths
 * Metro tried, the modules a duplicate class came from. The lines before a match are the ones a
 * reader already has from the phase name.
 */
export const DEFAULT_CONTEXT_AFTER = 20;

/** How many lines of the log's end travel in `logTail`, matching `deploy`'s `outputTail`. */
export const LOG_TAIL_LINES = 40;

/** How many entries `--all` may report, so a log full of one error does not become the payload. */
export const MAX_OTHER_FAILURES = 10;

/** How many error-looking lines travel in `errorLines`, so a compiler with a hundred does not become the payload. */
export const MAX_ERROR_LINES = 20;

/**
 * What a tool prints when something went wrong, across the tools a native build runs.
 *
 * `error:` is clang, swiftc, Kotlin (`e:`), Metro and npm; `FAILED` / `FAILURE` is Gradle and
 * xcodebuild's summary; `fatal` is git and the linker; `✖`/`✗` is what a bundler draws. Read as
 * words, so `errorCode` in a JSON blob or `Errors.swift` in a path does not count.
 */
const ERROR_LINE =
  /(^|[\s:[(])(error|errors|fatal|failed|failure|exception|✖|✗)(?=$|[\s:\]),]|\.(?![A-Za-z]))|^e: /i;

/** Lines that name errors to say there were none, which is the opposite of an error line. */
const NOT_AN_ERROR = /\b(0|no|zero) (errors?|failures?)\b|error-free|without errors?|errors?: 0\b/i;

export interface ExtractOptions {
  /** The caller's `--ios` / `--android` hint, which rules out the other platform's rules. */
  platform?: 'ios' | 'android' | null;
  contextBefore?: number;
  contextAfter?: number;
  /** Report every match, not only the one the failing phase produced. */
  all?: boolean;
}

export interface ExtractResult {
  /** The phases, now with `status` filled in from where the failure landed. */
  phases: Phase[];
  failure: Failure | null;
  /** Every other match, when `all` was asked for. `[]` otherwise. */
  otherFailures: Failure[];
}

/** One anchor match, before it is decided which of them is the answer. */
interface Match {
  anchor: Anchor;
  match: RegExpMatchArray;
  /** 1-based. */
  line: number;
  phaseIndex: number;
}

/**
 * Locate the failure a build log is about.
 *
 * The rule, in one sentence: **the failing phase is the one the last failure marker is in, and
 * inside it the earliest `cause` wins.**
 *
 * Both halves earn their place.
 *
 * *Last* marker decides the phase, because a build stops where it fails: markers earlier in the
 * log belong to steps the build went on past. This is what makes the "an error word in a
 * successful phase" case answer correctly — a pod install that printed `[!] ExpoFont has added 2
 * script phases` and then succeeded is followed by an xcodebuild that failed, and the xcodebuild
 * is what gets reported.
 *
 * *Earliest cause* decides the line, because a tool reports its own failure after the fact.
 * Gradle's `* What went wrong:` is the last thing in the log and says nothing; the Kotlin
 * `e: … error:` line hundreds of lines above it is the answer. Taking the last match would report
 * the summary every time.
 *
 * @param lines the log, ANSI already stripped, one entry per line.
 * @param phases the segments `detectPhases` produced over the same lines.
 * @returns the phases with statuses, the failure, and the other matches when `all` was asked for.
 */
export function extractFailure(
  lines: string[],
  phases: Phase[],
  options: ExtractOptions = {}
): ExtractResult {
  const {
    platform = null,
    contextBefore = DEFAULT_CONTEXT_BEFORE,
    contextAfter = DEFAULT_CONTEXT_AFTER,
    all = false,
  } = options;

  const isPhaseAllowed = (phase: Phase['name']) => phaseAllowedOnPlatform(phase, platform);
  const matches: Match[] = [];

  for (let index = 0; index < lines.length; index++) {
    const found = anchorFor(lines[index]!, isPhaseAllowed);
    if (found) {
      const line = index + 1;
      matches.push({ ...found, line, phaseIndex: phaseIndexForLine(phases, line) });
    }
  }

  if (matches.length === 0) {
    return { phases: markPhaseStatuses(phases, -1), failure: null, otherFailures: [] };
  }

  const chosen = chooseMatch(matches);
  const failure = toFailure(chosen, lines, phases, { contextBefore, contextAfter });
  const otherFailures = all
    ? matches
        .filter((candidate) => candidate.line !== chosen.line)
        .slice(0, MAX_OTHER_FAILURES)
        .map((candidate) => toFailure(candidate, lines, phases, { contextBefore, contextAfter }))
    : [];

  return {
    phases: markPhaseStatuses(phases, chosen.phaseIndex),
    failure,
    otherFailures,
  };
}

/**
 * Pick the one match the report is about.
 *
 * A `summary` is what identifies the failing phase when there is one, because it is the tool
 * saying "I stopped here". With no summary anywhere, the last `cause` is the best evidence of
 * where the log ends, and the same "earliest inside that phase" rule then applies.
 */
function chooseMatch(matches: Match[]): Match {
  const summaries = matches.filter((candidate) => candidate.anchor.kind === 'summary');
  const markers = summaries.length ? summaries : matches;
  const marker = markers[markers.length - 1]!;

  // The earliest cause in that phase, wherever it sits relative to the summary. npm prints its
  // `npm error code E404` classification *before* the 404 it classifies, and Gradle prints
  // `* What went wrong:` long after the compiler error — one rule reads both, because the rule is
  // about the phase and not about the order the tool chose.
  const firstCauseInPhase = matches.find(
    (candidate) => candidate.anchor.kind === 'cause' && candidate.phaseIndex === marker.phaseIndex
  );

  return firstCauseInPhase ?? marker;
}

/** Turn the chosen match into the reported failure, with its context and its next command. */
function toFailure(
  { anchor, match, line, phaseIndex }: Match,
  lines: string[],
  phases: Phase[],
  { contextBefore, contextAfter }: { contextBefore: number; contextAfter: number }
): Failure {
  const index = line - 1;
  const matchedLine = lines[index]!.trimEnd();

  return {
    phase: phases[phaseIndex]?.name ?? 'unknown',
    signature: anchor.signature,
    line,
    message: anchor.message,
    matchedLine,
    context: {
      before: lines.slice(Math.max(0, index - contextBefore), index).map(trimEnd),
      match: matchedLine,
      after: lines.slice(index + 1, index + 1 + contextAfter).map(trimEnd),
    },
    confidence: confidenceFor(anchor, phases[phaseIndex]?.name ?? 'unknown'),
    suggestedCommand: anchor.suggestedCommand?.(match) ?? null,
    docsUrl: anchor.docsUrl ?? null,
  };
}

/**
 * How much of the answer this match is worth.
 *
 * A `summary` is always `low`: it names the tool that stopped and nothing about why, and the
 * caller should read `logTail`. A `cause` in a named phase is `high`. A `cause` in `unknown` is
 * `medium` — the *what* is as certain as ever, and only the *where* is a guess.
 */
function confidenceFor(anchor: Anchor, phase: Phase['name']): Confidence {
  if (anchor.kind === 'summary') {
    return 'low';
  }
  return phase === 'unknown' ? 'medium' : 'high';
}

/** The last lines of the log, for the payload of a report that located nothing. */
/**
 * The lines that read like errors in the phase the report is about.
 *
 * The failing phase when a failure was located, else the last phase — a build stops where it
 * fails, so the last segment is where a log the table did not recognise says why. Consecutive
 * repeats are kept once: Gradle prints the same `e:` line for every module that compiled the
 * file. The order is the log's.
 *
 * @param maxLines the cap, {@link MAX_ERROR_LINES} by default.
 */
export function collectErrorLines(
  lines: string[],
  phases: Phase[],
  failure: Failure | null,
  maxLines: number = MAX_ERROR_LINES
): ErrorLine[] {
  const phase = failure
    ? (phases.find((candidate) => candidate.status === 'failed') ?? phases[phases.length - 1])
    : phases[phases.length - 1];
  const start = phase ? phase.startLine : 1;
  const end = phase ? phase.endLine : lines.length;

  const found: ErrorLine[] = [];
  let previous: string | null = null;
  for (let line = start; line <= end && line <= lines.length; line++) {
    const text = lines[line - 1]!.trimEnd();
    if (!text || !ERROR_LINE.test(text) || NOT_AN_ERROR.test(text)) {
      continue;
    }
    if (text === previous) {
      continue;
    }
    previous = text;
    found.push({ line, text });
    if (found.length >= maxLines) {
      break;
    }
  }
  return found;
}

export function logTail(lines: string[], maxLines: number = LOG_TAIL_LINES): string {
  return lines.map(trimEnd).filter(Boolean).slice(-maxLines).join('\n');
}

function trimEnd(line: string): string {
  return line.trimEnd();
}
