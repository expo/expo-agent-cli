// @ref llp/0035-one-device-per-worktree.rfc.md §Session discovery
import type { CloudPlatform } from './cloudSimulator';

/** The variable inside that file which names the session. */
export const CLOUD_SESSION_ID_VAR = 'EAS_SIMULATOR_SESSION_ID';

/**
 * The only session type this CLI can drive.
 *
 * The bridge to a device verb is `simulator:exec npx agent-device`, and only an `agent-device`
 * session has that daemon inside it — an `argent`, `appium` or `serve-sim` session answers a
 * different client or none at all. So a session of another type is not a device, and saying "no
 * session" for one would send a reader to start a second one next to it.
 */
export const DRIVABLE_SESSION_TYPE = 'agent-device';

/** One session, as much of it as this CLI reads. */
export interface CloudSessionInfo {
  id: string;
  /** The status verbatim, so a report can print what the service said rather than a translation. */
  status: string | null;
  platform: CloudPlatform | null;
  /**
   * The controller behind the session — `agent-device`, `argent`, `appium` or `serve-sim`.
   *
   * Read because it decides whether the session is a device at all: only `agent-device` answers the
   * verbs `simulator:exec` bridges to. Kept verbatim so a refusal can name the type that is up.
   */
  type: string | null;
  /** The `--name` the session was started with, for a report that says which one was picked. */
  name: string | null;
  /** When the service says it was created, used as the last tiebreaker between live sessions. */
  createdAt: string | null;
}

/**
 * The session id out of the dotenv `eas-cli` manages.
 *
 * A hand-rolled reader rather than a dotenv dependency: one `KEY=value` line is the whole of what
 * is wanted, and the file also carries a **token**, which is a thing to read as little of as
 * possible. Quotes are stripped because a value with a `#` in it may be written quoted.
 */
export function parseSessionIdFromEnvFile(text: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match || match[1] !== CLOUD_SESSION_ID_VAR) {
      continue;
    }
    const value = match[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * What `eas simulator:list --json` said this project has running.
 *
 * `{"sessions":[…],"pageInfo":{…}}` is the documented shape [observed —
 * `build/commands/simulator/list.js`], and this reads the array from there or from the top level,
 * because a shape that moved is worth surviving. Null — rather than an empty list — for anything
 * unreadable: "no sessions" and "the answer could not be read" are the two states this whole module
 * is careful to keep apart, since the first is an instruction to start a billed session.
 */
export function parseSessionListJson(stdout: string): CloudSessionInfo[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.sessions)
      ? parsed.sessions
      : null;
  if (!list) {
    return null;
  }

  const sessions: CloudSessionInfo[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = stringOf(entry.id) ?? stringOf(entry.sessionId);
    if (id == null) {
      continue;
    }
    sessions.push({
      id,
      status: stringOf(entry.status),
      platform: normalizePlatform(stringOf(entry.platform)),
      type: stringOf(entry.type),
      name: stringOf(entry.name),
      createdAt: stringOf(entry.createdAt),
    });
  }
  return sessions;
}

/** Whether the session's controller is `agent-device`, the one client this CLI drives. */
export function isDrivableSession(session: CloudSessionInfo): boolean {
  return session.type?.trim().toLowerCase() === DRIVABLE_SESSION_TYPE;
}

/** What a listing of live sessions amounts to for one run. */
export interface CloudSessionSelection {
  /** The session to drive, or null when none of them is one this CLI can use. */
  selected: CloudSessionInfo | null;
  /** The live sessions this CLI could drive, in the order the rule ranked them. */
  candidates: CloudSessionInfo[];
  /** Live sessions dropped for having a controller this CLI does not speak to. */
  wrongType: CloudSessionInfo[];
  /** Live or pending drivable sessions that neither a bound id nor the dotenv id names. */
  unbound: CloudSessionInfo[];
}

/**
 * Pick the session to drive, deterministically.
 *
 * Pure and total, because "which session did it use" must not depend on the order the service
 * returned or on the second the command was run (llp/0005 §Cloud simulator). The rule, in order:
 *
 * 1. only live `agent-device` sessions named by an own binding or the dotenv are candidates;
 * 2. the platform the caller asked for;
 * 3. a bound id before the dotenv id;
 * 4. the most recently created, `id` ascending as the final tiebreaker so two sessions created in
 *    the same millisecond still order the same way on every run.
 *
 * A session on the *other* platform is still returned when it is all there is: the caller compares
 * and raises `cloudPlatformMismatchError`, which says a session exists and is not the one asked
 * for — an answer that "no session" would have hidden.
 */
export function selectCloudSession(
  sessions: CloudSessionInfo[],
  {
    preferredId = null,
    platform = null,
    boundIds = [],
  }: {
    preferredId?: string | null;
    platform?: CloudPlatform | null;
    boundIds?: readonly string[];
  } = {}
): CloudSessionSelection {
  const live = sessions.filter((session) => sessionPhase(session.status) != null);
  const drivable = live.filter(isDrivableSession);
  const eligible = (session: CloudSessionInfo) =>
    boundIds.includes(session.id) || session.id === preferredId;
  const candidates = drivable.filter(eligible).sort((a, b) => {
    const wanted =
      platform == null ? 0 : rank(b.platform === platform) - rank(a.platform === platform);
    if (wanted) return wanted;
    const bound = rank(boundIds.includes(b.id)) - rank(boundIds.includes(a.id));
    if (bound) return bound;
    const preferred = rank(b.id === preferredId) - rank(a.id === preferredId);
    if (preferred) return preferred;
    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id);
  });
  const selected = candidates[0] ?? null;
  return {
    selected,
    candidates,
    unbound: drivable.filter((session) => !eligible(session)),
    wrongType: live.filter(
      (session) => !isDrivableSession(session) && sessionPhase(session.status) === 'up'
    ),
  };
}

function rank(value: boolean): number {
  return value ? 1 : 0;
}

/** What `simulator:availability --json` said about the account. */
export interface CloudAvailability {
  /** Whether the feature is on. Null when the answer could not be read. */
  available: boolean | null;
  /** Where access comes from, which the service returns only for a gated account. */
  waitlistUrl: string | null;
}

/**
 * Read `simulator:availability --json`.
 *
 * `{available, accountName}` [observed — 2026-08-26, eas-cli 22.4.0, recorded in
 * `src/__fixtures__/eas/simulator-availability.json`], plus `waitlistUrl` when and only when the account is gated [observed
 * — `build/commands/simulator/availability.js`]. The URL is read rather than hard-coded here so a
 * refusal quotes the service; `CLOUD_SIMULATOR_WAITLIST_URL` is the fallback for an older CLI
 * that answers without one.
 */
export function parseAvailabilityJson(stdout: string): CloudAvailability {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (isRecord(parsed) && typeof parsed.available === 'boolean') {
      return { available: parsed.available, waitlistUrl: stringOf(parsed.waitlistUrl) };
    }
  } catch {}
  return { available: null, waitlistUrl: null };
}

function normalizePlatform(value: string | null): CloudPlatform | null {
  const lower = value?.trim().toLowerCase();
  return lower === 'ios' || lower === 'android' ? lower : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
