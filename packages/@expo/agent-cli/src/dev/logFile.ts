// @ref llp/0036-detached-run-ownership.rfc.md
// Each candidate writes a private log. Only the owner publishes the current log;
// observers keep their selected file explicitly so a later start cannot change what they read.

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { stripVTControlCharacters } from 'util';

/** Directory of the per-run logs, as `.expo`'s own README describes it. */
const DEV_LOGS_DIR = path.join('.expo', 'dev', 'logs');

/** Name of the file a detached dev server's stdout and stderr are written to. */
const DETACHED_LOG_NAME = 'dev-detached.log';

/** Only the owning child publishes a new log. Candidates never truncate the current run. */
export function publishDetachedLog(projectRoot: string, file: string): void {
  const pointer = path.join(projectRoot, DEV_LOGS_DIR, 'dev-detached-current.json');
  const temp = `${pointer}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(path.basename(file)));
  fs.renameSync(temp, pointer);
}

/** Where this project's detached dev server writes its output. */
export function detachedLogPath(projectRoot: string): string {
  try {
    const name: unknown = JSON.parse(
      fs.readFileSync(path.join(projectRoot, DEV_LOGS_DIR, 'dev-detached-current.json'), 'utf8')
    );
    if (typeof name === 'string' && /^dev-detached-[\da-f-]{36}\.log$/.test(name)) {
      return path.join(projectRoot, DEV_LOGS_DIR, name);
    }
  } catch {
    /* Older runs used the fixed filename. */
  }
  return path.join(projectRoot, DEV_LOGS_DIR, DETACHED_LOG_NAME);
}

/**
 * Create an empty private log for a new detached candidate.
 *
 * @returns the path and an open file descriptor for the child's stdout and stderr. The caller
 * closes the descriptor once the child owns it.
 */
export function openDetachedLogSync(
  projectRoot: string,
  id: string = randomUUID()
): { logFile: string; fd: number } {
  const logFile = path.join(projectRoot, DEV_LOGS_DIR, `dev-detached-${id}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'wx');
  return { logFile, fd };
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
export function readDetachedLogSync(projectRoot: string, tail: number): DetachedLogRead | null {
  return readDetachedLogFileSync(detachedLogPath(projectRoot), tail);
}

/** Read one selected run without consulting or changing the project's current log. */
export function readDetachedLogFileSync(logFile: string, tail: number): DetachedLogRead | null {
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
