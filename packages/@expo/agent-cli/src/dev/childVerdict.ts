// @ref llp/0021-honest-reports.rfc.md §The rules
// What the detached child concluded, read back out of its log.
//
// A detached run has two processes and one caller, and only one of them prints to the caller's
// terminal. When the child fails it does the whole job properly — it classifies the failure, names
// the scenario, and writes the what/why/how — into a file nobody is watching, while the parent that
// *is* being read says `Bundler ready` and exits 0 [observed — friction run 7, F61; live run,
// S4]. The verdict is not missing. It is in the wrong place.
//
// So this reads it back. The two lines it looks for are written by `logCmdError` and
// `formatNeedsHumanBlock` (`src/utils/errors.ts`), which is a *format of this CLI's own* — the
// round-trip test in `__tests__/childVerdict-test.ts` builds the log out of those functions and
// parses it back, the same way the plan table of `src/plan/format.ts` is pinned to its readers
// below. The parent's report goes silently wrong the moment the two drift.

import { buildsBeforeServing } from './forwardedArgs';

/** How many lines of the child's log are searched for its verdict. */
export const VERDICT_LOG_LINES = 400;

/** The child's own conclusion about the run it was asked to perform. */
export interface DetachedChildVerdict {
  /**
   * Needs-human scenario id the child named, or null when its failure was not one.
   *
   * Non-null is the strong signal: this line is written by nothing but the needs-human block, and
   * that block is printed only by a process on its way out.
   */
  scenario: string | null;
  /** The child's own message, as it printed it, without the handoff block under it. */
  message: string;
  /**
   * The `CommandError` code and exit of the child's failure, from the row `logCmdError` writes
   * for a detached child alone, so a device refusal reaches the parent's caller unchanged
   * (llp/0035 §Output and errors). Null for a log written by nothing of this CLI's.
   */
  code: string | null;
  exitCode: number | null;
  /** The failure's `data`, carried on the same row, so a `--json` envelope keeps its `reason`. */
  data: Record<string, unknown> | null;
  /** The child's `Try:` line, which is its How line as a command. */
  suggestedCommand: string | null;
}

/** `NeedsHumanError: <message>` — `Error.toString()` as `Log.exception` prints it. */
const ERROR_LINE = /^([A-Za-z]*Error): (.*)$/;

/** `Needs a human   <scenario>` — the first row of {@link formatNeedsHumanBlock}'s block. */
const NEEDS_HUMAN_ROW = /^Needs a human\s{2,}(\S+)\s*$/;

/** `Error code      <code> exit <n>` — {@link formatErrorCodeRow}'s row. */
const ERROR_CODE_ROW = /^Error code\s{2,}(\S+) exit (\d+)(?: data (\{.*\}))?\s*$/;

/** `Try: <command>` — the last line of every failure that names a next command. */
const TRY_LINE = /^Try: (.+)$/;

/** The rest of that block, which the parent re-renders from the registry rather than quoting. */
const HANDOFF_ROW = /^(?:Ask the user|Or set|Error code|Try:)\s{2,}?\S/;

/**
 * Read the child's verdict out of its log, or null when the log holds none.
 *
 * Pure over the lines, so every shape is testable without a second process.
 *
 * The **last** error wins. A log is written in order and a dev server prints plenty before it
 * fails; what the caller needs is the one the child stopped on.
 *
 * @param lines the child's log, ANSI stripped, oldest first.
 */
export function parseDetachedChildVerdict(
  rawLines: readonly string[]
): DetachedChildVerdict | null {
  // One element per line, whoever the caller is: a log file read is already split, and an error a
  // test hands over as one multi-line string is the same text.
  const lines = rawLines.flatMap((line) => line.replace(/\r$/, '').split(/\r?\n/));
  let scenario: string | null = null;
  let code: string | null = null;
  let exitCode: number | null = null;
  let data: Record<string, unknown> | null = null;
  let suggestedCommand: string | null = null;
  let errorAt = -1;
  let tryAt = -1;
  let lastTry: string | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const handoff = NEEDS_HUMAN_ROW.exec(line);
    if (handoff) {
      scenario = handoff[1]!;
      continue;
    }
    const coded = ERROR_CODE_ROW.exec(line);
    if (coded) {
      code = coded[1]!;
      exitCode = Number(coded[2]);
      data = parseData(coded[3]);
      // `logCmdError` writes the `Try:` line right above the code row; one elsewhere is output of
      // another program, or of an earlier failure.
      suggestedCommand = tryAt === index - 1 ? lastTry : null;
      continue;
    }
    const tried = TRY_LINE.exec(line);
    if (tried) {
      tryAt = index;
      lastTry = tried[1]!.trim();
      continue;
    }
    if (ERROR_LINE.test(line)) {
      errorAt = index;
    }
  }

  if (scenario == null && errorAt < 0) {
    return null;
  }

  const message = lines
    .slice(errorAt < 0 ? lines.length : errorAt)
    .filter(
      (line) => !NEEDS_HUMAN_ROW.test(line) && !HANDOFF_ROW.test(line) && !TRY_LINE.test(line)
    )
    .join('\n')
    .trim();

  return { scenario, message, code, exitCode, data, suggestedCommand };
}

function parseData(json: string | undefined): Record<string, unknown> | null {
  if (json == null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed != null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The codes the parent of a detached run rethrows unchanged (llp/0035 §Output and errors). */
export function isRelayedStartCode(code: string | null): code is string {
  return (
    code != null &&
    (code === 'NO_BOUND_DEVICE' ||
      code === 'CLOUD_SIMULATOR_PLATFORM_MISMATCH' ||
      code === 'EAS_PROJECT_NOT_LINKED' ||
      code === 'EAS_PROJECT_CONFIG_UNREADABLE' ||
      code.startsWith('DEVICE_'))
  );
}

/**
 * One numbered row of the plan table `formatStartPlan` prints: `  2. expo run:android  ~minutes`.
 *
 * The command runs to the end of the run of two-or-more spaces that separates it from the time
 * class, which is how that table is laid out — the columns are padded, so a single space is inside
 * an argument and two are between columns.
 */
const PLAN_STEP_ROW = /^\s*\d+\.\s+((?:expo|eas)(?:\s\S+)*?)(?:\s{2,}|\s*$)/;

/**
 * Whether the detached child's dev-server step also opens the app, read from the plan table in
 * its log (`src/plan/format.ts`).
 *
 * @ref llp/0021-honest-reports.rfc.md §The rules — **F140.** The dev server and the app-opening
 * are one subprocess, and the opening is the half that can end it: a macOS Automation refusal
 * reaches the Expo CLI as an unhandled rejection and kills the process, measured 215ms to 263ms
 * after `/status` first answered [observed — 2026-08-28, `friction/run9/livecheck`]. So a run
 * whose step opens the app has risky work outstanding when the bundler answers.
 *
 * `run:ios` and `run:android` open it: launching the app is the last thing they do. An
 * `expo start` step never does: `dev` keeps the platform flags away from it and opens the app
 * itself, from its own process (llp/0026). The last step that serves is the dev-server step; a
 * `run:* --no-bundler` install serves nothing, so it counts only when no step serves.
 *
 * @param rawLines the child's log, ANSI stripped, oldest first.
 */
export function childOpensPlatform(rawLines: readonly string[]): boolean {
  let servingCommand: string | undefined;
  let sawBuild = false;
  for (const line of rawLines.flatMap((entry) => entry.split('\n'))) {
    const row = PLAN_STEP_ROW.exec(line)?.[1]?.trim();
    if (!row) {
      continue;
    }
    const command = row.split(/\s+/)[1];
    sawBuild ||= buildsBeforeServing(command);
    if ((command === 'start' || buildsBeforeServing(command)) && !row.includes('--no-bundler')) {
      servingCommand = command;
    }
  }
  return servingCommand != null ? buildsBeforeServing(servingCommand) : sawBuild;
}

/**
 * Line 1 of a detached child's log, printed by `devAsync` before anything else.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — it names the run that wrote
 * the log. Only line 1 is read, so output written after it cannot fake it.
 */
export function detachedPidLine(pid: number): string {
  return `Detached dev run, pid ${pid}.`;
}

const PID_LINE = /^Detached dev run, pid (\d+)\.$/;

/** The pid line 1 of the child's log names, or null. */
export function parseDetachedChildPid(lines: readonly string[]): number | null {
  const match = PID_LINE.exec(lines[0]?.trim() ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * The `Dev server:` row of the plan table `formatStartPlan` prints: `port 8082, because 8081 is
 * taken.` Every other state of the row names no move.
 */
const PLAN_PORT_ROW = /^\s*Dev server:\s+port (\d+)(?:, because (\d+) is taken)?/;

/**
 * The port the child's plan gave its dev server, and the busy port the plan moved it from.
 *
 * Pure over the lines, like {@link childOpensPlatform}, and read from the same table. The
 * first row is the plan's: the table is printed once, before any step runs.
 *
 * @param rawLines the child's log, ANSI stripped, oldest first.
 * @returns null when the log holds no plan, or a plan with no step that serves.
 */
export function parseDetachedChildPort(
  rawLines: readonly string[]
): { port: number; movedFrom: number | null } | null {
  for (const line of rawLines.flatMap((raw) => raw.split('\n'))) {
    const match = PLAN_PORT_ROW.exec(line);
    if (match) {
      return { port: Number(match[1]), movedFrom: match[2] == null ? null : Number(match[2]) };
    }
  }
  return null;
}
