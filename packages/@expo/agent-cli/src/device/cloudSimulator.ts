// @ref llp/0005-runtime-loop-tools.rfc.md §Cloud simulator
// The third device backend: a simulator that runs on EAS rather than on this machine.
//
// `src/navigate/device.ts` resolves two backends, and both are a platform tool this machine has:
// `simctl` for a booted iOS simulator, `adb` for an attached Android device. A laptop with neither
// has no device at all — which is exactly the machine the dogfood session of 2026-08-24 was run
// from, driving Expo Go on a **cloud** simulator through a tunnel while every `navigate` it typed
// stopped at "no booted device was found". Wave 9 gave that machine the URL (`--print-url`). This
// gives it the act.
//
// **Every invocation in this file is gated here, and none of them has been run against a live
// session.** The `eas simulator:*` surface is experimental and hidden, this machine's account is
// signed out, and the `eas` on its PATH is a shim that exits before it reaches the CLI. So the argv
// is built by pure functions and pinned by unit tests: when somebody signs in, one test file says
// what this CLI believes the API is, and one module is where a correction goes.
//
// Source of the syntax: the **published packages**, read rather than guessed — `eas-cli@22.2.0`
// (`oclif.manifest.json` for every flag, `build/commands/simulator/*.js` for the exact JSON each
// command prints) and `agent-device@0.20.10` (`agent-device help <verb>`, which runs offline)
// [observed — 2026-08-26]. That is one rung short of a live run: a manifest says what the CLI
// accepts, not what the service answers. The table is in llp/0005 §Cloud simulator.
//
// One deviation from llp/0001 constraint 5 worth naming: the device verbs are **not** an `eas`
// subcommand. `eas simulator:exec` loads the session's connection environment and spawns the
// command it is given, and the verbs come from `agent-device`, a controller run on demand through
// `npx`. So the process this CLI starts is still `eas` — the family binary — and what it asks that
// binary to run is a second process the CLI never resolves itself. `AGENT_DEVICE_SPEC` is the whole
// of that decision, in one place.

import fs from 'fs';
import { guardedCloudArgs, guardRefusal } from './cloudCommand';
import path from 'path';

import { classifySubprocessFailure } from '../needsHuman/detect';
import { PROGRAM_PREFIX } from '../programName';
import {
  easCliArgs,
  easCliLabel,
  EAS_RUNNER_RECOVERY,
  resolveEasCli,
  type EasCli,
} from '../utils/easCli';
import { easFailureReason } from '../utils/easFailure';
import { CommandError } from '../utils/errors';
import { spawnCaptureAsync } from '../utils/spawnCapture';
import { looksLikeWrapperCrash } from '../utils/wrapperCrash';
import { easCommandPrefix } from '../utils/easCli';

/** Platforms an EAS Simulator session can run. The same two the local backends drive. */
export type CloudPlatform = 'ios' | 'android';

/**
 * The dotenv file `eas-cli` writes when a session starts, and reads when one is driven.
 *
 * Managed by the EAS CLI and not by this one: it holds the session id and the daemon's URL and
 * token, which is why nothing here ever writes it.
 *
 * It is **not** the gate any more (llp/0005 §Cloud simulator). The file outlives the session it
 * names, and a session started by MCP or by another terminal need never touch it. So its presence
 * proves nothing about what is running — what it is genuinely true about is *which* session this
 * project last started, and that makes it a **preference** when the service reports more than one.
 *
 * A live run made that case stronger and one of its facts wrong [observed — 2026-08-26,
 * `eas-cli` 22.5.0, `eas simulator --platform android --build-id … --type agent-device --json`].
 * The claim used to be that a `--json` start does not write the file at all [read from
 * `eas-cli@22.2.0` `build/simulator/env.js`]. It **does** write it — and writes it **empty**: three
 * comment lines saying not to commit or edit it, and no session id, no daemon URL, no token. So the
 * file can be present, freshly written, and still name nothing, which is a worse failure than an
 * absent file for anything that treats presence as evidence. Reading the service is the only sound
 * way to find a session, which is what this module does.
 *
 * One consequence for advice rather than for code: `eas simulator:stop` with no `--id` defaults to
 * this file, so after a `--json` start it has nothing to read and the session must be stopped with
 * `--id <session-id>` explicitly.
 */
export const CLOUD_SESSION_ENV_FILE = '.env.eas-simulator';

/** The variable inside that file which names the session. */
export const CLOUD_SESSION_ID_VAR = 'EAS_SIMULATOR_SESSION_ID';

/**
 * The controller package `simulator:exec` is asked to run, pinned in one place.
 *
 * `@latest` rather than a version, because `simulator:*` is experimental and the controller moves
 * with it; a pin here would be a version this CLI has never tested either.
 */
export const AGENT_DEVICE_SPEC = 'agent-device@latest';

/** The `eas` argv that runs one controller verb (`['open', url]`) on the session's device. */
export function cloudExecArgs(controllerArgv: string[]): string[] {
  return ['simulator:exec', 'npx', AGENT_DEVICE_SPEC, ...controllerArgv];
}

/**
 * The session status the EAS CLI reports for a session that is up.
 *
 * The raw GraphQL enum rather than the lower-case flag spelling: `simulator:list --json` prints
 * `status` and `platform` verbatim from the API (`NEW | IN_PROGRESS | STOPPED | ERRORED`,
 * `IOS | ANDROID`) while printing `type` in its flag spelling [observed — `eas-cli@22.2.0`
 * `build/commands/simulator/list.js` and `build/graphql/generated.js`].
 */
export const ACTIVE_SESSION_STATUS = 'IN_PROGRESS';

/**
 * The only session type this CLI can drive.
 *
 * The bridge to a device verb is `simulator:exec npx agent-device`, and only an `agent-device`
 * session has that daemon inside it — an `argent`, `appium` or `serve-sim` session answers a
 * different client or none at all. So a session of another type is not a device, and saying "no
 * session" for one would send a reader to start a second one next to it.
 */
export const DRIVABLE_SESSION_TYPE = 'agent-device';

/**
 * How many live sessions one listing asks for.
 *
 * `simulator:list` defaults to 10 and caps at 100 [observed — `build/commands/simulator/list.js`].
 * The listing is already filtered to the running ones, and a project with more than this many at
 * once is a billing problem rather than a selection problem — so one page, no pagination, and a
 * number with room above what anybody runs.
 */
export const CLOUD_SESSION_LIST_LIMIT = 25;

/** Where an account without EAS Simulator asks for it, when the service names one. [observed] */
export const CLOUD_SIMULATOR_WAITLIST_URL = 'https://expo.dev/services/simulators';

/**
 * Start a usable app, including Metro and the project's Expo Go/development-build choice.
 * Keep this in the foreground: detached dev may reuse Metro without opening a session.
 */
export function cloudSessionStartCommand(): string {
  return `${PROGRAM_PREFIX} dev --ios --eas`;
}

// ---- The argv, as pure functions -------------------------------------------------------------
//
// Pure and exported for the same reason `buildOpenUrlCommand` and `buildScreenshotCommand` are: the
// argv is the whole of what this module decides, and a wrong one fails only on a machine that has
// an account, a session, and a bill. Here the stakes are higher than for `simctl`, because nothing
// in this package has ever seen the right answer.

/**
 * `eas simulator:list`, which answers what this project has running right now.
 *
 * The whole of session discovery, and the reason the dotenv is no longer the gate: this asks the
 * service rather than the filesystem, so a session started by MCP, by another terminal, or by a
 * `simulator:start --json` that wrote no dotenv is still found (llp/0005 §Cloud simulator).
 *
 * `--status in-progress` server-side, because a stopped session is never an answer and there is no
 * reason to carry one across a process boundary. The **type** filter is deliberately *not* sent:
 * the flag exists, but a project whose only live session is a `serve-sim` deserves to be told that
 * rather than told there is nothing — so every live session comes back and the filtering that
 * decides drivability happens here, where it can be explained.
 *
 * [observed — `eas-cli@22.2.0` `build/commands/simulator/list.js`; not yet run against the service.]
 */
export function buildSessionListArgs({
  limit = CLOUD_SESSION_LIST_LIMIT,
}: { limit?: number } = {}): string[] {
  return [
    'simulator:list',
    '--status',
    'in-progress',
    '--limit',
    String(limit),
    '--json',
    '--non-interactive',
  ];
}

/**
 * `eas simulator:availability`, the read-only check for whether the account has the feature.
 *
 * Read-only: no session is started, so nothing is billed. Asked only when the listing came back
 * with no usable session, to tell "this account cannot start one" apart from "this project has none
 * running" — two facts with two different next actions.
 *
 * [observed — `build/commands/simulator/availability.js`: `{available, accountName}`, plus
 * `waitlistUrl` only when the account is gated.]
 */
export function buildAvailabilityArgs(): string[] {
  return ['simulator:availability', '--json', '--non-interactive'];
}

/**
 * The deep link, as the cloud backend opens it.
 *
 * `simulator:exec` loads the session environment and runs the controller, and the controller's verb
 * is `open` — the same verb for an app id and for a deep link. `--platform` is passed because the
 * skill's examples pass it on `open`, and a session knows its own platform: this says which of the
 * two the URL is for, and a session probe is where the value comes from rather than a guess.
 * [observed — live, 2026-08-26: the bare `open <url> --platform <p>` form, exit 0.]
 *
 * Three optional pieces, all of them from the controller's own help [observed —
 * `agent-device help open`, 0.20.10] and all of them for the cloud **reload** (llp/0005 §Cloud simulator):
 *
 * - `appId` in front of the URL — the shell-plus-link form, `open "Expo Go" exp://host …`, which
 *   launches the named app *with* the link instead of handing the link to the system. What that
 *   avoids is the "Open in 'Expo Go'?" dialog nothing can answer on a cloud device (S10).
 * - `relaunch` — `--relaunch`, which "terminate[s] the app process before launching it". One verb
 *   for the force-stop and the relaunch, so a reload never has to `close` first; `close` ends the
 *   *controller's* session and is what left a cloud app stranded (S12).
 * - `session` — `--session <name>`, the remedy the controller names in its own `DEVICE_IN_USE`
 *   refusal (S14).
 *
 * The order is the controller's: subcommand, then positionals, then flags.
 */
export function buildCloudOpenUrlArgs({
  url,
  platform,
  appId,
  relaunch = false,
  session,
}: {
  url: string;
  platform: CloudPlatform;
  /** Application id of the shell to launch the URL with, or undefined for a bare URL open. */
  appId?: string;
  /** Terminate the app process before launching it. */
  relaunch?: boolean;
  /** Controller session to bind the verb to, or undefined for the controller's own default. */
  session?: string;
}): string[] {
  return [
    'open',
    ...(appId ? [appId] : []),
    url,
    '--platform',
    platform,
    ...(relaunch ? ['--relaunch'] : []),
    ...(session ? ['--session', session] : []),
  ];
}

/**
 * The screenshot, as the cloud backend takes it.
 *
 * The controller writes the PNG to a **local** path — it downloads the image from the daemon — so
 * unlike `adb exec-out` there is nothing to redirect, and unlike `simctl` the file arrives over a
 * network.
 *
 * Both halves of the argv are the controller's own account of itself [observed — 2026-08-26,
 * `agent-device@latest help screenshot`, which runs offline]: the usage line is
 * `agent-device screenshot [path] …`, so the path is **positional**; and the flag list holds
 * `--out`, `--overlay-refs`, `--pixel-density`, `--fullscreen`, `--scale`, `--no-stabilize` and
 * `--normalize-status-bar` — and **no `--platform`**, which the `open` verb's help does document
 * ("Use --platform to bind URL/deep-link opens to the target platform"). Sending one here is how an
 * experimental CLI answers "unknown option", so none is sent.
 *
 * The controller requires an app to be open first, which is a property of the *verb* and is said
 * out loud in the caller's reason string rather than worked around here.
 */
export function buildCloudScreenshotArgs({ filePath }: { filePath: string }): string[] {
  return ['screenshot', filePath];
}

/**
 * The system alert, as the controller reads and answers one.
 *
 * `agent-device alert [get|accept|dismiss|wait] [timeout]`, and the subcommand is the whole argv
 * [observed — `agent-device@latest help alert`, run offline, 2026-08-27: "Inspect, wait for, accept,
 * or dismiss a platform alert. Use get before acting when the alert content matters; accept and
 * dismiss change the active alert state."].
 *
 * **What `get` answers when there is no alert**, which is the branch that decides whether this is
 * safe to run speculatively: exit **1** with `Error (COMMAND_FAILED): alert not found`
 * [observed — 2026-08-27, `agent-device@latest alert get` against a runner with nothing on screen].
 * So a read costs a refusal rather than an action, and a run that finds no alert accepts nothing.
 *
 * No `--platform`: the flag table carries the platform binding on `open`/`install`/`apps`, and
 * sending one where it is not documented is how an experimental CLI answers "unknown option"
 * (§`buildCloudScreenshotArgs`).
 */
export function buildCloudAlertArgs({
  action,
}: {
  action: 'get' | 'accept' | 'dismiss';
}): string[] {
  return ['alert', action];
}

/**
 * Whether an alert the controller read is iOS asking to open a URL in a named app.
 *
 * The alert this exists for is the one S10 is: "Open in 'Expo Go'?", which SpringBoard raises when a
 * custom-scheme URL is handed to the system, and which nothing on an unattended cloud device answers
 * [observed — live run S10, 2026-08-26; `agent-device alert accept` proved the causality].
 *
 * **Read as text rather than parsed**, deliberately. What `alert get` prints for a *present* alert
 * has not been seen by anything in this package — only the empty answer has — so a parser for it
 * would be a shape invented here and then trusted. Two substrings the dialog cannot lack are what
 * is asked for instead: the word `open`, and the name of the app whose URL this run just sent. An
 * alert that names neither is some other dialog, and answering an unknown system prompt is granting
 * something the caller did not ask for — so it is reported and left alone.
 *
 * @param output everything `alert get` wrote, stdout and stderr together.
 * @param appLabel the app the URL was for, e.g. `Expo Go` or `host.exp.Exponent`.
 */
export function isOpenInAppAlert(output: string, appLabel: string): boolean {
  const text = output.toLowerCase();
  if (!text.includes('open')) {
    return false;
  }
  // Both the display name and the bundle id are accepted: the dialog says "Expo Go" and the caller
  // knows `host.exp.Exponent`, so the id is matched by its last component too.
  const names = [appLabel, appLabel.split('.').pop() ?? appLabel]
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length >= 3);
  return names.some((name) => text.includes(name));
}

/** Read the alert on the session's device. Exit 1 with "alert not found" when there is none. */
export function readCloudAlertAsync(options: CloudVerbOptions): Promise<CloudRunResult> {
  return runCloudVerbAsync(buildCloudAlertArgs({ action: 'get' }), options);
}

/** Answer the alert on the session's device with its default accept action. */
export function acceptCloudAlertAsync(options: CloudVerbOptions): Promise<CloudRunResult> {
  return runCloudVerbAsync(buildCloudAlertArgs({ action: 'accept' }), options);
}

/**
 * Ending the app on the session's device, and not the session.
 *
 * `--shutdown` is never passed, and that is the safety of this function: it would stop the
 * simulator itself, which is a machine billed by the minute and may belong to a session this CLI
 * did not start [observed — `agent-device@0.20.10`, `agent-device help close`].
 *
 * **What `close` does not do is tell you whether it stopped the app you named.** The help says
 * "close the named app, or the active session app when app is omitted", and the live run says
 * something narrower: `close com.nonexistent.zzz.qqq` on a blank simulator exits **0** with
 * `{"success":true,"data":{"session":"default","message":"Closed: default"}}` — the same answer as
 * `close host.exp.Exponent` on a simulator that had never had Expo Go on it [observed — live
 * session `01a03d80`, 2026-08-26]. So the argument does not make the answer specific: a success
 * here is evidence that the **controller closed its session's app**, and no evidence at all about
 * the id. `stopAppOnCloudAsync` is where that is turned into a report that does not overclaim, and
 * llp/0005 §Cloud simulator is why it is not simply approximated.
 *
 * The id is still passed, because it is the documented way to name a target and a later controller
 * may honour it; nothing downstream is allowed to read the exit code as being about that id.
 *
 * No `--platform`: a session has one device, and the documented flag table carries the platform
 * binding on `open`/`install`/`apps` rather than on this verb.
 */
export function buildCloudStopAppArgs({ appId }: { appId: string }): string[] {
  return ['close', appId];
}

/**
 * Whether the controller — rather than the EAS CLI — is what refused.
 *
 * `agent-device` prints its own failures as `Error (CODE): <sentence>` and exits non-zero, and
 * `simulator:exec` propagates that exit code as its own [observed — live, 2026-08-26:
 * `Error (COMMAND_FAILED): Simulator device failed to open myapp://.` for a scheme no app on the
 * simulator had registered, and `Error (SESSION_NOT_FOUND): No active session. Run open first.` for
 * a screenshot with nothing open].
 *
 * It matters because the two failures need opposite headlines. A non-zero exit from `eas` may be a
 * verb this CLI got wrong — but when the controller printed one of these, the argv was right, the
 * bridge worked, and the **device** is what said no. Blaming the syntax there sends a reader to
 * `--help` for a command that is already correct.
 */
export function readControllerError(output: string): { code: string; message: string } | null {
  const match = /^\s*Error \(([A-Z_]+)\):\s*(.+)$/m.exec(output);
  return match ? { code: match[1]!, message: match[2]!.trim() } : null;
}

// ---- Reading a session -----------------------------------------------------------------------

/** One session, as much of it as this CLI reads. */
export interface CloudSessionInfo {
  id: string | null;
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
      // An entry with no id names no session, and there is nothing to drive or to report.
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

/** Whether a status names a session that is up and can be driven. */
export function isActiveSessionStatus(status: string | null): boolean {
  return status != null && status.trim().toUpperCase() === ACTIVE_SESSION_STATUS;
}

/**
 * Whether a session is one this CLI can send a device verb to.
 *
 * Two facts, both from the service: it is running, and its controller is `agent-device`. A session
 * that answers a different client is not a device here however healthy it is.
 */
export function isDrivableSession(session: CloudSessionInfo): boolean {
  return (
    isActiveSessionStatus(session.status) &&
    session.type?.trim().toLowerCase() === DRIVABLE_SESSION_TYPE
  );
}

/** What a listing of live sessions amounts to for one run. */
export interface CloudSessionSelection {
  /** The session to drive, or null when none of them is one this CLI can use. */
  selected: CloudSessionInfo | null;
  /** The live sessions this CLI could drive, in the order the rule ranked them. */
  candidates: CloudSessionInfo[];
  /** Live sessions dropped for having a controller this CLI does not speak to. */
  wrongType: CloudSessionInfo[];
}

/**
 * Pick the session to drive, deterministically.
 *
 * Pure and total, because "which session did it use" must not depend on the order the service
 * returned or on the second the command was run (llp/0005 §Cloud simulator). The rule, in order:
 *
 * 1. only `agent-device` sessions are candidates at all;
 * 2. the one `.env.eas-simulator` names, when it is among them — the file is a bad existence proof
 *    and a good preference, because it is the session this project started;
 * 3. the platform the caller asked for;
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
  }: { preferredId?: string | null; platform?: CloudPlatform | null } = {}
): CloudSessionSelection {
  const live = sessions.filter((session) => isActiveSessionStatus(session.status));
  const candidates = live.filter(isDrivableSession);
  const wrongType = live.filter((session) => !isDrivableSession(session));

  const ranked = [...candidates].sort((a, b) => {
    const preferred = rank(b.id === preferredId) - rank(a.id === preferredId);
    if (preferred !== 0) {
      return preferred;
    }
    const wanted = rank(b.platform === platform) - rank(a.platform === platform);
    if (wanted !== 0) {
      return wanted;
    }
    const newest = (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
    return newest !== 0 ? newest : (a.id ?? '').localeCompare(b.id ?? '');
  });

  return { selected: ranked[0] ?? null, candidates: ranked, wrongType };
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
 * refusal quotes the service; {@link CLOUD_SIMULATOR_WAITLIST_URL} is the fallback for an older CLI
 * that answers without one.
 */
export function parseAvailabilityJson(stdout: string): CloudAvailability {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (isRecord(parsed) && typeof parsed.available === 'boolean') {
      return { available: parsed.available, waitlistUrl: stringOf(parsed.waitlistUrl) };
    }
  } catch {
    // An answer this cannot read establishes nothing, which is what null says.
  }
  return { available: null, waitlistUrl: null };
}

/** What this project has, or has not, on EAS Simulator right now. */
export type CloudSessionState =
  /** A session is up and can be driven. */
  | 'active'
  /** The dotenv names a session, and the service does not list it among the running ones. */
  | 'inactive'
  /** The service lists nothing this CLI can drive. */
  | 'none'
  /** Nothing could be established: no EAS CLI, an unreadable answer, or a binary that is not it. */
  | 'unknown';

export interface CloudSessionProbe {
  state: CloudSessionState;
  sessionId: string | null;
  platform: CloudPlatform | null;
  /** The status the service reported, verbatim. Null when nothing answered. */
  status: string | null;
  /** The `--name` of the session that was picked, when it has one. */
  sessionName: string | null;
  /** How many drivable sessions the listing held, so a report can say a choice was made. */
  candidateCount: number;
  /**
   * How many live sessions were dropped for having a controller this CLI cannot speak to.
   *
   * Carried so a failure that is *not* about the cloud — a `navigate` with no device at all — can
   * still name the session that is up. "No device found" next to a running `serve-sim` is true and
   * unhelpful, and the reader is one `simulator:start` away from a device this CLI can drive.
   */
  otherSessionCount: number;
  /** Why the state is what it is, for a failure that has to explain itself. Null when `active`. */
  reason: string | null;
  /** Whether the account has EAS Simulator at all, when it was worth asking. Null when it was not. */
  available: boolean | null;
  /** Where a gated account asks for access, when the service named it. */
  waitlistUrl: string | null;
  /**
   * The EAS CLI run that failed, when one did.
   *
   * Kept so the failure raised for this probe can run the same layer-3 classification a device verb
   * does: a signed-out account is a step only a person can complete whether it was found while
   * *driving* the session or while *asking about* it, and answering the second with exit `1` would
   * hand an agent a broken-tool story for a login (llp/0010 §Needs-human protocol).
   */
  failure: CloudRunResult | null;
}

/** Where the session dotenv lives for a project. */
export function cloudSessionEnvPath(projectRoot: string): string {
  return path.join(projectRoot, CLOUD_SESSION_ENV_FILE);
}

/**
 * The session id this project last started, read off disk. Never throws.
 *
 * Two callers, and neither of them treats it as proof of anything running (llp/0005 §Cloud simulator):
 *
 * - the **preference** in {@link selectCloudSession}, when the service lists more than one session;
 * - the **suggestion ladders** — `status.next`, the `start`/`dev` banner, `smoke`'s open-app rung
 *   — which run on every call and so may not spawn an `eas`. A suggestion naming a dead session
 *   costs one command that says so; a banner held up by a network call costs every run.
 */
export function readCloudSessionIdSync(projectRoot: string): string | null {
  try {
    return parseSessionIdFromEnvFile(fs.readFileSync(cloudSessionEnvPath(projectRoot), 'utf8'));
  } catch {
    return null;
  }
}

/** How long the EAS CLI gets to answer a question about a session. */
export const CLOUD_SESSION_TIMEOUT_MS = 20_000;

/**
 * How long a device verb gets.
 *
 * Generous, and it has to be: `simulator:exec` runs the controller through `npx`, which downloads
 * the package on a cold machine before the verb starts, and the verb then crosses a network to a
 * remote daemon. A budget sized for `simctl openurl` would kill the healthy case.
 */
export const CLOUD_VERB_TIMEOUT_MS = 180_000;

export interface CloudRunOptions {
  projectRoot: string;
  /** The `eas` to spawn, for a caller that resolved it already. */
  easCli?: EasCli | null;
  timeoutMs?: number;
}

export type CloudVerbOptions = CloudRunOptions & { sessionId: string };

/** What one `eas simulator:*` run amounted to. */
export interface CloudRunResult {
  /** The command as a person would type it, for reproducing the step by hand. */
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Set when the process could not be started at all. */
  spawnError: string | null;
  /** The binary that ran, so a failure names the file rather than the package. */
  binPath: string | null;
}

/**
 * Ask the service what this project has running. Never throws: no session is an answer.
 *
 * One listing, and a second read-only request only when the listing held nothing usable. The
 * dotenv is read too, but not as a gate — it is the preference {@link selectCloudSession} applies
 * when the service reports more than one live session (llp/0005 §Cloud simulator).
 *
 * `platform` says which platform the caller would rather have. It is a **preference, not a
 * filter**: a session on the other platform still comes back, because "there is a session and it is
 * an Android one" is an answer and "there is no session" would not be.
 */
export async function probeCloudSessionAsync({
  projectRoot,
  easCli,
  platform = null,
  timeoutMs = CLOUD_SESSION_TIMEOUT_MS,
}: CloudRunOptions & { platform?: CloudPlatform | null }): Promise<CloudSessionProbe> {
  const cli = easCli ?? resolveEasCli(projectRoot);
  if (!cli) {
    // The resolver's third rung downloads the published CLI, so reaching here means this machine has
    // no `eas` *and* no `npx` or `bunx` to fetch one with (`src/utils/easCli.ts`).
    return unknownSession(
      null,
      'no "eas" binary was found in node_modules/.bin or on PATH, and no package runner ("npx" or "bunx") is on PATH to download one, so nothing could be asked about a cloud simulator session'
    );
  }

  // The file is read before the listing and used after it: it names the session this project
  // started, which is the tiebreaker when the account has several up at once.
  const preferredId = readCloudSessionIdSync(projectRoot);

  const result = await runEasAsync(cli, buildSessionListArgs(), { projectRoot, timeoutMs });
  if (result.spawnError) {
    return unknownSession(
      preferredId,
      `"${result.command}" could not be run (${result.spawnError})`
    );
  }
  // A binary that is not the EAS CLI has said nothing about this project's sessions, and reading its
  // exit code as "there are none" would send a caller to start a second billed one
  // (`wrapperCrash.ts`).
  if (looksLikeWrapperCrash({ tool: 'eas', ...result })) {
    return unknownSession(
      preferredId,
      `the "eas" at ${result.binPath} exited ${result.exitCode} and printed nothing an eas run would print, so it may not be the EAS CLI`
    );
  }
  if (result.exitCode !== 0) {
    // @ref llp/0027-everything-on-eas.rfc.md §What EAS said
    return {
      ...unknownSession(preferredId, easFailureReason(result, result.command)),
      failure: result,
    };
  }

  const sessions = parseSessionListJson(result.stdout);
  if (!sessions) {
    return unknownSession(
      preferredId,
      `"${result.command}" answered with JSON this CLI cannot read`
    );
  }

  const { selected, candidates, wrongType } = selectCloudSession(sessions, {
    preferredId,
    platform,
  });
  if (selected?.id != null) {
    return {
      state: 'active',
      sessionId: selected.id,
      platform: selected.platform,
      status: selected.status,
      sessionName: selected.name,
      candidateCount: candidates.length,
      otherSessionCount: wrongType.length,
      available: true,
      waitlistUrl: null,
      failure: null,
      reason: null,
    };
  }

  return await noUsableSessionAsync({
    cli,
    projectRoot,
    timeoutMs,
    preferredId,
    wrongType,
  });
}

/**
 * The listing came back with nothing this CLI can drive. Work out which kind of nothing it is.
 *
 * This is the one branch that pays for the availability check, and it pays for it because it is the
 * one branch whose instruction changes: "start a session" is wrong for an account that cannot have
 * one, and telling somebody to run a command that will refuse them is a dead end where a waitlist
 * link is a next step.
 */
async function noUsableSessionAsync({
  cli,
  projectRoot,
  timeoutMs,
  preferredId,
  wrongType,
}: {
  cli: EasCli;
  projectRoot: string;
  timeoutMs: number;
  preferredId: string | null;
  wrongType: CloudSessionInfo[];
}): Promise<CloudSessionProbe> {
  const availability = await runEasAsync(cli, buildAvailabilityArgs(), { projectRoot, timeoutMs });
  // A check that stopped because nobody is signed in has established nothing about the account's
  // access — and the next step for it is a person, not a session. Answered as `unknown` with the
  // run attached, so the caller raises the handoff rather than "this project has no session".
  if (needsHumanFor(availability)) {
    return {
      ...unknownSession(preferredId, 'no Expo account is signed in'),
      failure: availability,
    };
  }
  const { available, waitlistUrl } = availability.spawnError
    ? { available: null, waitlistUrl: null }
    : parseAvailabilityJson(availability.stdout);

  const base = {
    platform: null,
    status: null,
    sessionName: null,
    candidateCount: 0,
    otherSessionCount: wrongType.length,
    available,
    waitlistUrl: waitlistUrl ?? (available === false ? CLOUD_SIMULATOR_WAITLIST_URL : null),
    failure: null,
  };

  if (available === false) {
    return {
      ...base,
      state: 'none',
      sessionId: null,
      reason:
        'EAS Simulator is not enabled on this account, so no session can be started for this project',
    };
  }
  // A live session of a type this CLI cannot drive is not "no session". Naming the types is what
  // stops a reader from starting a second billed session next to the one they are already paying
  // for, and it is the only way "there is nothing running" and "the thing running answers a
  // different client" can be told apart.
  if (wrongType.length > 0) {
    const types = [...new Set(wrongType.map((session) => session.type ?? 'an unreported type'))];
    return {
      ...base,
      state: 'none',
      sessionId: null,
      reason: `this project has ${wrongType.length} running EAS Simulator session${
        wrongType.length === 1 ? '' : 's'
      } (${types.join(', ')}) and none of them is a "${DRIVABLE_SESSION_TYPE}" session, which is the only kind this CLI can send a device verb to`,
    };
  }
  // The dotenv names a session the service did not list as running. The file outlives the session,
  // so this is the common shape of a stale one — and saying so is what stops the id in it from
  // reading as an answer.
  if (preferredId != null) {
    return {
      ...base,
      state: 'inactive',
      sessionId: preferredId,
      reason: `${CLOUD_SESSION_ENV_FILE} names session ${preferredId}, and the service does not list it among this project's running sessions, so that session has ended`,
    };
  }
  return {
    ...base,
    state: 'none',
    sessionId: null,
    reason: 'the service lists no running EAS Simulator session for this project',
  };
}

/**
 * Open a URL on the cloud simulator. Never throws for a verb that ran and refused.
 *
 * `appId`, `relaunch` and `session` are {@link buildCloudOpenUrlArgs}'s: a caller that wants the
 * one-verb relaunch passes them, and a caller that wants the plain open passes none.
 */
export function openUrlOnCloudSimulatorAsync({
  url,
  platform,
  appId,
  relaunch,
  session,
  ...options
}: CloudVerbOptions & {
  url: string;
  platform: CloudPlatform;
  appId?: string;
  relaunch?: boolean;
  session?: string;
}): Promise<CloudRunResult> {
  return runCloudVerbAsync(
    buildCloudOpenUrlArgs({ url, platform, appId, relaunch, session }),
    options
  );
}

/**
 * End one app on the cloud simulator, leaving the session up.
 *
 * The cloud form of `simctl terminate` and `am force-stop`. Never throws for a verb that ran and
 * refused — the caller weighs "it was not running" against what it is trying to do, exactly as it
 * does for the local backends.
 */
export function stopAppOnCloudSimulatorAsync({
  appId,
  ...options
}: CloudVerbOptions & { appId: string }): Promise<CloudRunResult> {
  return runCloudVerbAsync(buildCloudStopAppArgs({ appId }), options);
}

/** Take a screenshot of the cloud simulator into a local file. */
export function captureCloudScreenshotAsync({
  filePath,
  ...options
}: CloudVerbOptions & { filePath: string }): Promise<CloudRunResult> {
  return runCloudVerbAsync(buildCloudScreenshotArgs({ filePath }), options);
}

async function runCloudVerbAsync(
  controllerArgv: string[],
  { projectRoot, easCli, sessionId, timeoutMs = CLOUD_VERB_TIMEOUT_MS }: CloudVerbOptions
): Promise<CloudRunResult> {
  const cli = easCli ?? resolveEasCli(projectRoot);
  if (!cli) {
    throw easCliMissingError();
  }
  const args = cloudExecArgs(controllerArgv);
  const result = await runEasAsync(cli, guardedCloudArgs(args, sessionId), {
    projectRoot,
    timeoutMs,
    display: args,
  });
  const refusal = guardRefusal(result);
  if (refusal) throw cloudSessionMismatchError(sessionId, refusal.loadedId);
  return result;
}

async function runEasAsync(
  cli: EasCli,
  args: string[],
  {
    projectRoot,
    timeoutMs,
    display = args,
  }: { projectRoot: string; timeoutMs: number; display?: string[] }
): Promise<CloudRunResult> {
  const { stdout, stderr, exitCode, spawnError } = await spawnCaptureAsync(
    cli.command,
    easCliArgs(cli, args),
    {
      cwd: projectRoot,
      timeoutMs,
    }
  );
  return {
    // How a person would reproduce the step. The runner and the package spec, not a bare `eas`:
    // that used to be the honest short form of a resolved binary, and is now the name of a command
    // the machine may not have (`src/utils/easCli.ts`).
    command: [easCliLabel(cli), ...display].join(' '),
    stdout,
    stderr,
    exitCode,
    spawnError: spawnError?.message ?? null,
    binPath: cli.command,
  };
}

// ---- The failures ----------------------------------------------------------------------------

/**
 * The guard refused: EAS loaded another session than the selected one.
 * Callers that degrade, such as the screenshot, test for this class instead of a code string.
 *
 * @ref llp/0035-one-device-per-worktree.rfc.md §Session guard
 */
export class CloudSessionMismatchError extends CommandError {}

/** @ref llp/0035-one-device-per-worktree.rfc.md §Session guard */
export function cloudSessionMismatchError(
  selected: string,
  loaded: string | null
): CloudSessionMismatchError {
  const error = new CloudSessionMismatchError(
    'CLOUD_SESSION_MISMATCH',
    [
      `EAS session ${selected} cannot be driven from this worktree, so no device command ran.`,
      `Why: "simulator:exec" drives only the session that ${CLOUD_SESSION_ENV_FILE} names, and it names ${loaded ? `session ${loaded}` : 'no session'}. Only a session start writes that file.`,
      `How: ${loaded ? `If session ${loaded} is still running, it is the only session this worktree can drive. ` : ''}"${easCommandPrefix()} simulator:list" lists the sessions of this account. End session ${selected} with "${easCommandPrefix()} simulator:stop --id ${selected}" only if this worktree started it. Do not edit ${CLOUD_SESSION_ENV_FILE}: its session id and credentials belong together.`,
    ].join('\n')
  );
  error.data = { selectedSessionId: selected, loadedSessionId: loaded };
  return error;
}

/** The failure for a cloud run on a machine with no reachable package runner. */
export function easCliMissingError(): CommandError {
  const error = new CommandError(
    'EAS_CLI_MISSING',
    [
      'The EAS CLI could not be reached, so a cloud simulator cannot be driven from here.',
      'Why: no package runner ("npx" or "bunx") is on PATH, so nothing here can start the published EAS CLI — and an EAS Simulator session is created and driven entirely through that CLI.',
      `How: ${EAS_RUNNER_RECOVERY}`,
    ].join('\n')
  );
  return error;
}

function unknownSession(sessionId: string | null, reason: string): CloudSessionProbe {
  return {
    state: 'unknown',
    sessionId: sessionId || null,
    platform: null,
    status: null,
    sessionName: null,
    candidateCount: 0,
    otherSessionCount: 0,
    available: null,
    waitlistUrl: null,
    failure: null,
    reason,
  };
}

/** Whether a failed EAS CLI run is a step only a person can complete. */
function needsHumanFor(result: CloudRunResult): boolean {
  return (
    classifySubprocessFailure({
      tool: 'eas',
      invocation: result.command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    }) != null
  );
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
