// @ref llp/0035-one-device-per-worktree.rfc.md §Session discovery
/**
 * `simulator:list --status` flag value → the status `--json` prints.
 * `--json` prints `status` and `platform` verbatim from the API (`NEW | QUEUED | STARTING | IN_PROGRESS | STOPPED | ERRORED`)
 * [observed — `eas-cli@22.2.0` `build/commands/simulator/list.js`; the enum from `eas-cli@24.13.0` `build/graphql/generated.js`].
 */
export const LIVE_SESSION_STATUSES = {
  'in-progress': 'IN_PROGRESS',
  new: 'NEW',
  queued: 'QUEUED',
  starting: 'STARTING',
} as const;

const LIVE = new Set<string>(Object.values(LIVE_SESSION_STATUSES));

/** `up` can be driven now; `pending` is listed and not up yet; null is not live. */
export function sessionPhase(status: string | null): 'up' | 'pending' | null {
  const s = status?.trim().toUpperCase() ?? '';
  if (!LIVE.has(s)) return null;
  return s === LIVE_SESSION_STATUSES['in-progress'] ? 'up' : 'pending';
}

/** The next page's cursor, null on the last page, undefined when the page cannot be read. */
export function sessionPageCursor(stdout: string): string | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  const pageInfo = (parsed as { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } } | null)
    ?.pageInfo;
  if (pageInfo?.hasNextPage !== true) return null;
  return typeof pageInfo.endCursor === 'string' && pageInfo.endCursor
    ? pageInfo.endCursor
    : undefined;
}
