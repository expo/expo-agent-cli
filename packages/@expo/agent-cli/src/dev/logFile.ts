// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
import { AsyncLocalStorage } from 'async_hooks';
import fs from 'fs';
import path from 'path';
import { stripVTControlCharacters } from 'util';

/** Directory of the per-run logs, as `.expo`'s own README describes it. */
const DEV_LOGS_DIR = path.join('.expo', 'dev', 'logs');

/** Legacy log used only when no candidate has published a current pointer. */
const DETACHED_LOG_NAME = 'dev-detached.log';
const attribution = new AsyncLocalStorage<{ root: string; logFile?: string }>();

export function withDetachedLogAttribution<T>(root: string, run: () => T): T {
  return attribution.run({ root }, run);
}

export function captureDetachedLog(logFile: string): void {
  const scope = attribution.getStore();
  if (scope) scope.logFile = logFile;
}

export function publishDetachedLogSync(root: string, logFile: string): void {
  fs.writeFileSync(path.join(root, DEV_LOGS_DIR, 'current'), path.basename(logFile));
}

/** Where this project's detached dev server writes its output. */
export function detachedLogPath(projectRoot: string): string {
  const scope = attribution.getStore();
  if (scope?.root === projectRoot && scope.logFile) return scope.logFile;
  try {
    const name = fs.readFileSync(path.join(projectRoot, DEV_LOGS_DIR, 'current'), 'utf8');
    if (/^dev-detached-[\da-f-]+\.log$/.test(name))
      return path.join(projectRoot, DEV_LOGS_DIR, name);
  } catch {}
  return path.join(projectRoot, DEV_LOGS_DIR, DETACHED_LOG_NAME);
}

/**
 * Exclusively create a private log for a new detached candidate.
 *
 * @returns the path and an open file descriptor for the child's stdout and stderr. The caller
 * closes the descriptor once the child owns it.
 */
export function openDetachedLogSync(
  projectRoot: string,
  id: string
): { logFile: string; fd: number } {
  const logFile = path.join(projectRoot, DEV_LOGS_DIR, `dev-detached-${id}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  return { logFile, fd: fs.openSync(logFile, 'wx') };
}

/** What a read of the log amounts to. */
export interface DetachedLogRead {
  /** Absolute path of the file, so a caller can open it itself. */
  logFile: string;
  /** The last lines asked for, ANSI stripped, oldest first. */
  lines: string[];
  /** How many lines the file has in total. */
  totalLines: number;
  /** Whether older lines were left out because {@link lines} was capped. */
  truncated: boolean;
}

/**
 * Read the tail of a detached dev server's log, or null when the project has none.
 *
 * The escape codes are stripped rather than passed through: Metro colours its output and draws
 * progress bars with cursor moves, and neither survives being read out of a file by anything but a
 * terminal. What is left is the text an agent reads.
 *
 * @param tail how many lines from the end to return.
 */
export function readDetachedLogSync(
  projectRoot: string,
  tail: number,
  logFile = detachedLogPath(projectRoot)
): DetachedLogRead | null {
  let raw: string;
  try {
    raw = fs.readFileSync(logFile, 'utf8');
  } catch {
    return null;
  }

  const all = stripVTControlCharacters(raw)
    .split('\n')
    // A file ending in a newline has an empty last line that is not a line of output.
    .filter((line, index, lines) => index < lines.length - 1 || line.length > 0);

  return {
    logFile,
    lines: tail >= all.length ? all : all.slice(all.length - tail),
    totalLines: all.length,
    truncated: tail < all.length,
  };
}
