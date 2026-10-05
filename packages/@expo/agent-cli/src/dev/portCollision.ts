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

import net from 'net';

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
 * Four spellings, because they come from two versions and two branches of one function
 * [observed — `packages/@expo/cli/src/utils/port.ts`, and live against expo 57.0.15 on 2026-08-23]:
 *
 * - `Use port 8181 instead?` — the question itself, quoted back by the prompt helper's
 *   non-interactive failure under `Required input:`. This is the one that reached the friction run.
 * - `Port 8180 is running node in another window` / `is being used by another process` — the line
 *   printed just above the question, which survives even when the question does not.
 * - `Port 8180 is unavailable and 'npx expo' is running in non-interactive mode` — the newer
 *   branch, which throws instead of asking when the port was explicit.
 * - `› Skipping dev server` — what `expo run:*` prints when the question went unanswered. It then
 *   builds, installs, deep-links the app to whatever holds the port, and exits 0
 *   [observed — live suite, 2026-10-05].
 */
const COLLISION_PATTERNS: RegExp[] = [
  /Use port (?<offered>\d+) instead\?/i,
  /Port\s+(?<requested>\d+)\s+is\s+(?:running\b|being used\b)/i,
  /Port\s+(?<requested>\d+)\s+is unavailable and/i,
  /Skipping dev server/,
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

function toPort(value: string | undefined): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * A dev server that was started somewhere other than where it was asked for.
 *
 * `from` is null when the Expo CLI's own message did not name the port it wanted — it does not
 * always — and inventing one would be this CLI claiming a fact nobody told it.
 */
export interface PortMove {
  /** The busy port, when the Expo CLI named it. */
  from: number | null;
  /** The port this CLI picked and the dev server took. */
  to: number;
}

/**
 * The sentence `@expo/agent-cli dev` prints when it moved the dev server off a busy port.
 *
 * Built here rather than written inline because it is read back by another *process* of this CLI:
 * a `--detach` run does the retry in the child, whose output goes to a log file, and the parent
 * has no other way to learn that the port it reports is not the port that was asked for
 * [friction run 5, F48-4]. {@link parsePortMove} is the other end, and a round-trip test pins the
 * pair — the parent's report goes silently wrong the moment the two drift.
 *
 * Why not compare the port the run asked for against the port the lock reports: a dev server can
 * land elsewhere for reasons that are not a collision, and reporting those as a move would be this
 * command inventing a busy port it never observed.
 */
export function formatPortMove(move: PortMove): string {
  return move.from == null
    ? `The port the dev server wanted was busy; started on ${move.to} instead.`
    : `Port ${move.from} was busy; started on ${move.to} instead.`;
}

/** `to` in the sentence above, which is the half that is always there. */
const PORT_MOVE_TO = /started on (\d+) instead/g;

/** `from`, when the sentence had one. */
const PORT_MOVE_FROM = /Port (\d+) was busy/;

/**
 * Read {@link formatPortMove}'s sentence back out of a detached dev server's log.
 *
 * A run can move twice: once before the plan, and once more when the port it picked was taken
 * before the dev server bound it. `from` is the first sentence's, the port the caller expected, and
 * `to` the last one's, the port the dev server is on.
 *
 * @param output everything the detached run printed, escape codes already stripped.
 * @returns the move, or null when the log holds none.
 */
export function parsePortMove(output: string): PortMove | null {
  const to = toPort([...output.matchAll(PORT_MOVE_TO)].at(-1)?.[1]);
  if (to == null) {
    return null;
  }
  return { from: toPort(PORT_MOVE_FROM.exec(output)?.[1]), to };
}

/** Where `expo start` and `expo run:*` listen when nothing names a port: Expo's own default. */
export function defaultMetroPort(): number {
  return toPort(process.env.RCT_METRO_PORT) ?? 8081;
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

/** How far past the busy port to look before giving up on finding a free one. */
const FREE_PORT_SCAN_RANGE = 200;

/**
 * A port on this machine that nothing is listening on, at or after `from`.
 *
 * Bound and released rather than probed with a connection: a port that refuses a connection can
 * still be unbindable (a listener on another interface, a socket in `TIME_WAIT`), and the question
 * this answers is whether the dev server will be able to *take* it.
 *
 * @returns the port, or null when the whole range was busy.
 */
export async function findFreePortAsync(
  from: number,
  { range = FREE_PORT_SCAN_RANGE }: { range?: number } = {}
): Promise<number | null> {
  for (let port = from; port < from + range && port <= 65535; port++) {
    if (await isPortBindableAsync(port)) {
      return port;
    }
  }
  return null;
}

/**
 * Whether a server can bind this port right now, on the unspecified address and on the loopback.
 *
 * Both, as Expo's own `freePortAsync` checks. A dual-stack listener on `*:8081` left
 * `127.0.0.1:8081` bindable, and `dev` then passed `--port 8081` to a port another project's Metro
 * answered [observed — macOS, 2026-10-05]. The unspecified address is `::` with `ipv6Only: false`,
 * or `0.0.0.0` on a machine with no IPv6.
 */
export async function isPortBindableAsync(port: number): Promise<boolean> {
  let unspecified = await tryBindAsync({ port, host: '::', ipv6Only: false });
  if (unspecified === 'no-ipv6') {
    unspecified = await tryBindAsync({ port, host: '0.0.0.0' });
  }
  return unspecified === true && (await tryBindAsync({ port, host: '127.0.0.1' })) === true;
}

/** Bind and release once. `no-ipv6` when the host is an IPv6 address this machine cannot use. */
function tryBindAsync(options: net.ListenOptions): Promise<boolean | 'no-ipv6'> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) =>
      resolve(error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL' ? 'no-ipv6' : false)
    );
    server.listen(options, () => {
      server.close(() => resolve(true));
    });
  });
}
