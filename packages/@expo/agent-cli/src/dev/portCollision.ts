// @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol
// @ref llp/0004-smart-start-and-project-state.rfc.md §Plan contract
// A busy port is not a step only a person can complete.
//
// The Expo CLI asks `Use port 8181 instead?` when the port it wanted is taken, and a run with no
// terminal cannot answer, so the whole start stops there. That reached this CLI as the generic
// `expo-prompt` scenario: exit 7, "a person must answer this", and a `How:` line naming the very
// flag the caller had just passed [observed — friction run 4, 2026-08-23].
//
// Every part of that is wrong for *this* prompt, and only for this one. Picking a free port is
// mechanical: no account, no permission, no click. So this file recognises the port question
// specifically, before the needs-human classifier sees the failure, and the caller either retries
// on a port it picked itself or — when the caller *named* the port — reports the outcome that a
// demanded port was taken. `expo-prompt` still covers every other question the Expo CLI asks.

import { freePortAsync, testPortAsync } from '../utils/freeport';

/** What the Expo CLI said when a port was taken. */
export interface PortCollision {
  /** The port that was asked for and could not be had. */
  requestedPort: number | null;
  /** The port the CLI offered instead, when its question named one. */
  offeredPort: number | null;
}

/**
 * The lines the Expo CLI prints when the port it wanted is busy.
 *
 * The spellings come from two versions and two branches of one function
 * [observed — `packages/@expo/cli/src/utils/port.ts`, and live against expo 57.0.15 on 2026-08-23]:
 *
 * - `Use port 8181 instead?` — the question itself, quoted back by the prompt helper's
 *   non-interactive failure under `Required input:`. This is the one that reached the friction run.
 * - `Port 8180 is running node in another window` / `is being used by another process` — the line
 *   printed just above the question, which survives even when the question does not.
 * - `Port 8180 is unavailable and 'npx expo' is running in non-interactive mode` — the newer
 *   branch, which throws instead of asking when the port was explicit.
 * - `› Skipping dev server` is not read on its own. When another process holds the port, `expo run:*`
 *   prints a `Port 8081 is …` line above it, which the pattern above reads, then builds, installs,
 *   deep-links the app to that process, and exits 0 [observed — live suite, 2026-10-05]. That exit
 *   0 is why the check runs on any exit code. A skip with no `Port N is` line before it is the
 *   Expo CLI reusing this project's own dev server (`choosePortAsync` with `reuseExistingPort`),
 *   not a collision.
 * - `Port "8081" became busy running another process while the app was compiling` — what
 *   `expo run:*` throws, exit 1, when its explicit port was taken during the build
 *   (`utils/port.ts` `ensurePortAvailabilityAsync`).
 *
 * And one from Metro: `Error: listen EADDRINUSE: address already in use :::8082`, when the port
 * this CLI picked was free at the bind test and taken before Metro bound it. `expo start` then
 * exits 1 [observed — two worktrees resolving the port at once, 2026-10-05].
 */
const COLLISION_PATTERNS: RegExp[] = [
  /Use port (?<offered>\d+) instead\?/i,
  /Port\s+(?<requested>\d+)\s+is\s+(?:running\b|being used\b)/i,
  /Port\s+(?<requested>\d+)\s+is unavailable and/i,
  /Port "?(?<requested>\d+)"? became busy/,
  /listen EADDRINUSE: address already in use \S*?:(?<requested>\d+)\b/,
];

/**
 * Whether a failed `expo` step stopped because its port was taken, and which ports it named.
 *
 * Pure over the captured text, so every spelling above is testable without a busy port.
 *
 * @param output everything the step printed, stderr and stdout together.
 */
export function detectPortCollision(output: string): PortCollision | null {
  let requestedPort: number | null = null;
  let offeredPort: number | null = null;
  let matched = false;

  for (const pattern of COLLISION_PATTERNS) {
    const match = pattern.exec(output);
    if (!match) {
      continue;
    }
    matched = true;
    requestedPort ??= toPort(match.groups?.requested);
    offeredPort ??= toPort(match.groups?.offered);
  }

  return matched ? { requestedPort, offeredPort } : null;
}

/** Where `expo start` and `expo run:*` listen when nothing names a port: Expo's own default. */
export function defaultMetroPort(): number {
  return toPort(process.env.RCT_METRO_PORT) ?? 8081;
}

function toPort(value: string | undefined): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * The sentence `@expo/agent-cli dev` prints when the dev server is not on the port it wanted.
 *
 * Two moments: the plan found the port busy before any step ran, or the port the plan picked was
 * taken before the dev server bound it and the retry moved it again. `busy` is null when the Expo
 * CLI did not name the port it wanted, which it does not always.
 */
export function formatPortMove({
  busy,
  to,
  when,
}: {
  busy: number | null;
  to: number;
  when: 'plan' | 'retry';
}): string {
  if (busy == null) {
    return `The port the dev server wanted is busy; it uses ${to}.`;
  }
  return when === 'plan'
    ? `Port ${busy} is busy; the dev server uses ${to}.`
    : `Port ${busy} was taken before the dev server bound it; the dev server uses ${to}.`;
}

/**
 * The port a plan's dev server is given, decided before any step runs.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port is not a step only a person can
 * complete. `expo run:*` answers an unanswerable port question by skipping its dev server and
 * exiting 0, after it baked the busy port into the app [observed — live suite, 2026-10-05]. With a
 * free port picked here and passed as `--port`, the question is never asked.
 */
export interface PlannedPort {
  port: number;
  /** The port that was wanted and was busy, or null when `port` is that port. */
  movedFrom: number | null;
  /** Whether `port` could be bound when it was picked: false for a taken `--port`, or a full scan. */
  bindable: boolean;
}

/**
 * Pick the dev server's port: the one the caller named, or the first bindable one from Expo's
 * default.
 *
 * @param requested the `--port` the caller passed, which is used as is whether or not it is free.
 */
export async function resolvePlannedPortAsync(
  requested: number | null,
  { preferred = defaultMetroPort() }: { preferred?: number } = {}
): Promise<PlannedPort> {
  if (requested != null) {
    return { port: requested, movedFrom: null, bindable: await isPortBindableAsync(requested) };
  }
  const free = await findFreePortAsync(preferred);
  if (free == null) {
    return { port: preferred, movedFrom: null, bindable: false };
  }
  return { port: free, movedFrom: free === preferred ? null : preferred, bindable: true };
}

/**
 * Only `null`, the unspecified address, sees a dual-stack listener on `::`, which is how Metro
 * binds. Only `127.0.0.1` sees a listener bound to `127.0.0.1` alone.
 */
const PROBE_HOSTS = [null, '127.0.0.1'];

/**
 * A port on this machine that nothing is listening on, at or after `from`.
 *
 * Bound and released rather than probed with a connection: a port that refuses a connection can
 * still be unbindable (a listener on another interface, a socket in `TIME_WAIT`), and the question
 * this answers is whether the dev server will be able to *take* it.
 *
 * @returns the port, or null when every port up to 65535 was busy.
 */
export async function findFreePortAsync(from: number): Promise<number | null> {
  return await freePortAsync(from, PROBE_HOSTS);
}

/** Whether a server can bind this port right now, on every address in {@link PROBE_HOSTS}. */
export async function isPortBindableAsync(port: number): Promise<boolean> {
  return await testPortAsync(port, PROBE_HOSTS);
}
