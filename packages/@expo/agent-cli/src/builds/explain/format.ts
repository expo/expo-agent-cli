// @ref llp/0006-agent-native-cli-surface.rfc.md §Output contract — "one fact per line, label value
// style". The same facts as `--json`, in the shape a terminal and a model reading a terminal both
// get through in one pass.

import chalk from 'chalk';

import type { ErrorLine, ExplainReport, Failure, Phase } from './types';

/** Width of the label column, matching `status` and `deploy`. */
const LABEL_WIDTH = 12;

/**
 * How many lines of context the human report prints. `--json` carries all of them.
 *
 * Widened from 3 and 8 [Kudo, 2026-09-15]: a compiler's detail — the code frame, the candidate
 * paths — runs past eight lines, and a reader who has to open the log for it was not given the
 * meaningful portion.
 */
const PRINTED_CONTEXT_BEFORE = 5;
const PRINTED_CONTEXT_AFTER = 12;

/** How many of the phase's error lines are printed under a located failure. */
const PRINTED_ERROR_LINES_WITH_FAILURE = 12;

/** How many lines of `logTail` are printed when nothing was located and no line reads like an error. */
const PRINTED_TAIL = 20;

/** One line per fact the report holds, then the quoted evidence for the one that matters. */
export function formatExplainReport(report: ExplainReport): string {
  const lines: string[] = [];
  const row = (label: string, value: string) =>
    lines.push(`${chalk.dim(label.padEnd(LABEL_WIDTH))}${value}`);

  row('log', logLine(report));
  row('read', readLine(report));
  if (report.phases.length) {
    row('phases', phasesLine(report.phases));
  }

  if (!report.failure) {
    row('failure', chalk.yellow('none located — no rule matched this log'));
    lines.push('');
    // What the tools themselves marked as errors, which is the meaningful part of a log the rule
    // table does not know. The raw tail is the fallback for a log that marked nothing.
    if (report.errorLines.length) {
      lines.push(
        chalk.dim(
          `  The lines that read like errors in the last phase (${report.errorLines.length}):`
        )
      );
      lines.push('');
      lines.push(indent(errorLinesBlock(report.errorLines, report.errorLines.length)));
    } else {
      lines.push(chalk.dim('  The last lines of the log:'));
      lines.push('');
      lines.push(indent(lastLines(report.logTail, PRINTED_TAIL)));
    }
    return lines.join('\n');
  }

  const { failure } = report;
  row('phase', failure.phase);
  row('signature', chalk.bold(failure.signature));
  row('confidence', confidenceValue(failure.confidence));
  row('line', String(failure.line));
  row('what', failure.message);
  if (failure.suggestedCommand) {
    row('run next', chalk.cyan(failure.suggestedCommand));
  }
  if (failure.docsUrl) {
    row('docs', failure.docsUrl);
  }

  lines.push('');
  lines.push(indent(contextBlock(failure)));

  // The rest of what the phase marked as errors, past the one the rule matched: a build that
  // failed on three things says so here rather than one report at a time.
  const others = report.errorLines.filter((entry) => entry.line !== failure.line);
  if (others.length) {
    lines.push('');
    lines.push(
      chalk.dim(
        `  Other lines that read like errors in this phase (${others.length}${others.length > PRINTED_ERROR_LINES_WITH_FAILURE ? `, first ${PRINTED_ERROR_LINES_WITH_FAILURE}` : ''}):`
      )
    );
    lines.push(indent(errorLinesBlock(others, PRINTED_ERROR_LINES_WITH_FAILURE)));
  }

  if (report.otherFailures.length) {
    lines.push('');
    lines.push(chalk.dim(`  ${report.otherFailures.length} other match(es):`));
    for (const other of report.otherFailures) {
      lines.push(`  ${chalk.dim(String(other.line).padStart(6))}  ${other.signature}`);
    }
  }

  return lines.join('\n');
}

/** Where the log came from, in the words a reader can act on. */
function logLine(report: ExplainReport): string {
  switch (report.source.kind) {
    case 'stdin':
      return 'stdin';
    case 'local':
      return `${report.source.path!} ${chalk.dim(`(the last ${report.source.platform ?? 'native'} build dev ran here)`)}`;
    case 'eas': {
      const files = report.source.logFiles ?? 0;
      return `EAS build ${report.source.buildId ?? '(unknown)'} ${chalk.dim(`(${files} log ${files === 1 ? 'file' : 'files'}, fetched from EAS)`)}`;
    }
    case 'file':
      return report.source.path!;
  }
}

/** What was read, and what was dropped to read it. */
function readLine(report: ExplainReport): string {
  const { lines, bytes, truncated, droppedLines } = report.source;
  const size = `${lines} lines · ${formatBytes(bytes)}`;
  return truncated
    ? `${size} ${chalk.yellow(`(first ${droppedLines} lines dropped; the tail is what is reported)`)}`
    : size;
}

/** The phases in order, with the failing one marked. */
function phasesLine(phases: Phase[]): string {
  return phases
    .map((phase) => {
      if (phase.status === 'failed') {
        return chalk.red(`${phase.name} ✗`);
      }
      return phase.status === 'succeeded' ? chalk.dim(phase.name) : phase.name;
    })
    .join(chalk.dim(' → '));
}

/**
 * The confidence, with the sentence that says what to do about it.
 *
 * `low` is the one that has to say something: it means only a summary anchor matched, so the
 * signature names the tool that stopped and not the reason it did.
 */
function confidenceValue(confidence: Failure['confidence']): string {
  switch (confidence) {
    case 'high':
      return chalk.green('high — a rule matched the failing line inside a phase this log named');
    case 'medium':
      return chalk.yellow('medium — a rule matched, but no phase claimed the lines around it');
    case 'low':
      return chalk.yellow(
        'low — only the tool\'s own "I failed" line matched, so the cause is in the context below'
      );
  }
}

/** The quoted log around the match, with the matched line marked. */
function contextBlock(failure: Failure): string {
  const before = failure.context.before.slice(-PRINTED_CONTEXT_BEFORE);
  const after = failure.context.after.slice(0, PRINTED_CONTEXT_AFTER);
  const firstLine = failure.line - before.length;

  const rendered: string[] = [];
  before.forEach((line, index) => rendered.push(gutter(firstLine + index, line, false)));
  rendered.push(gutter(failure.line, failure.context.match, true));
  after.forEach((line, index) => rendered.push(gutter(failure.line + 1 + index, line, false)));
  return rendered.join('\n');
}

/** The error lines, numbered the way the context block is, so the two read as one log. */
function errorLinesBlock(entries: ErrorLine[], maxLines: number): string {
  return entries
    .slice(0, maxLines)
    .map((entry) => gutter(entry.line, entry.text, false))
    .join('\n');
}

/** One quoted line, with its number and a marker on the match. */
function gutter(lineNumber: number, text: string, isMatch: boolean): string {
  const number = chalk.dim(String(lineNumber).padStart(6));
  return isMatch ? `${chalk.red('>')} ${number}  ${chalk.red(text)}` : `  ${number}  ${text}`;
}

/** The last lines of a tail, for a report with nothing located. */
function lastLines(tail: string, maxLines: number): string {
  const all = tail.split('\n');
  return all.slice(-maxLines).join('\n');
}

function indent(block: string): string {
  return block
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/** A byte count as a person reads one. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} kB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
