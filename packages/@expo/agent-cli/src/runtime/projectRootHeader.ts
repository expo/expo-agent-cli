// @ref llp/0030-one-device-per-agent.rfc.md §Discovery
// Which project a dev server serves, as its `GET /status` says. Imports nothing from the lock, so
// the lock can ask it too (`src/devLock/port.ts`).

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
 * Whether the dev server's project root and this project's are the same directory.
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
  return canonicalPath(reported) === canonicalPath(projectRoot);
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
