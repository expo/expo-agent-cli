// @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port
// Which project a dev server serves, as its `GET /status` says. Imports nothing from the lock, so
// the lock can ask it too (`src/devLock/port.ts`).

import fs from 'fs';
import path from 'path';

import { canonicalizeExistingPath } from '../utils/dir';

/** Header the dev server names the project root it serves in, URI-encoded. */
export const PROJECT_ROOT_HEADER = 'x-react-native-project-root';

/** The header value, URI-decoded, or null when the dev server sent none. */
export function decodeProjectRoot(value: string | null): string | null {
  if (value == null) {
    return null;
  }
  try {
    return decodeURI(value);
  } catch {
    // A value that is not a valid encoding is still the answer the dev server gave.
    return value;
  }
}

/**
 * Whether the dev server serves this project: its project root is this project's directory, or a
 * directory that contains it in the same checkout.
 *
 * The header is Metro's `projectRoot` from `metro.config.js`, which a monorepo sets to the
 * workspace root, so a parent directory is this project's server too. A sibling is not. A parent
 * matches only when no directory from the project up to the parent (the project included, the
 * parent not) holds a `.git` entry. A worktree inside the parent (`<repo>/.claude/worktrees/<name>`,
 * which has a `.git` file) is another checkout, and the parent's Metro serves that checkout's code.
 *
 * Both sides are resolved through the filesystem when they exist, because a temporary directory is
 * commonly reached through a symlink (`/var` -> `/private/var` on macOS) and two spellings of one
 * directory must not read as two projects. Windows path comparison is case-insensitive.
 */
export function matchProjectRoot(
  reported: string | null,
  projectRoot?: string | null
): boolean | null {
  if (reported == null || projectRoot == null) {
    return null;
  }
  const relative = path.relative(canonicalPath(reported), canonicalPath(projectRoot));
  if (relative === '') {
    return true;
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  let dir = canonicalizeExistingPath(projectRoot);
  for (let depth = relative.split(path.sep).length; depth > 0; depth--) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return false;
    }
    dir = path.dirname(dir);
  }
  return true;
}

function canonicalPath(value: string): string {
  const resolved = canonicalizeExistingPath(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export type ReportedRoot =
  | { kind: 'header'; root: string }
  | { kind: 'no-header' }
  | { kind: 'unreachable' };

/**
 * The project root a dev server names in the headers of `GET /status`, decoded. `no-header` is a
 * server that answered without one (an older dev server); `unreachable` is one that timed out or
 * failed, which proves nothing. `/status` only finishes once the bundler does, but the headers are
 * flushed first, so the request is abandoned as soon as they arrive.
 */
export async function readReportedProjectRootAsync(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ReportedRoot> {
  const budget = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(`${url}/status`, {
      signal: signal == null ? budget : AbortSignal.any([signal, budget]),
      headers: { connection: 'close' },
    });
    const root = decodeProjectRoot(response.headers.get(PROJECT_ROOT_HEADER));
    await response.body?.cancel();
    return root == null ? { kind: 'no-header' } : { kind: 'header', root };
  } catch {
    return { kind: 'unreachable' };
  }
}
