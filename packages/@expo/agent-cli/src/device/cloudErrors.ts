// @ref llp/0005-runtime-loop-tools.rfc.md §Cloud simulator
// The failures of the cloud backend, one builder for each way a cloud simulator run can fail.

import { needsHumanErrorFrom } from '../needsHuman/error';
import { PROGRAM_PREFIX } from '../programName';
import { EAS_RUNNER_RECOVERY } from '../utils/easCli';
import { classifyEasFailure } from '../utils/easFailure';
import { CommandError } from '../utils/errors';
import {
  checkBinaryCommand,
  looksLikeWrapperCrash,
  runnerCrashDetail,
} from '../utils/wrapperCrash';
import {
  CLOUD_SESSION_ENV_FILE,
  cloudSessionListCommand,
  cloudSessionStartCommand,
  easNeedsHuman,
  readControllerError,
  type CloudPlatform,
  type CloudRunResult,
  type CloudSessionProbe,
} from './cloudSimulator';

/**
 * The failure for a project asked to use a cloud simulator that has no live session.
 *
 * Names the command that starts one, taken from the documented syntax rather than guessed, and
 * branches on which of the three "no session" states this is: an account without the feature is not
 * told to start a session it cannot have, and a session that has *ended* is named by its id so the
 * reader knows the file on disk is stale rather than wrong.
 */
export function cloudSessionUnavailableError(
  probe: Extract<CloudSessionProbe, { state: 'inactive' | 'none' | 'unavailable' }>
): CommandError {
  const start = cloudSessionStartCommand();

  if (probe.state === 'unavailable') {
    const error = new CommandError(
      'CLOUD_SIMULATOR_UNAVAILABLE',
      [
        'EAS Simulator is not enabled on this account, so there is no cloud simulator to open the link on.',
        `Why: ${probe.reason}. It is a limited-access EAS feature that is still rolling out, so it is not a thing this command can turn on.`,
        // The URL comes from the service when it sends one, so a refusal ends in where access comes
        // from rather than only in "no".
        `How: ask for access at ${probe.waitlistUrl}. Until then, open the link on a local device — boot a simulator or attach a device and run this command again — or hand the URL to whatever can open it with "${PROGRAM_PREFIX} navigate <route> --print-url".`,
      ].join('\n')
    );
    error.suggestedCommand = `${PROGRAM_PREFIX} navigate / --print-url`;
    return error;
  }

  const error = new CommandError(
    'NO_CLOUD_SIMULATOR_SESSION',
    [
      'No EAS Simulator session this CLI can drive is running for this project, so there is no cloud simulator to open the link on.',
      `Why: ${probe.reason}. A cloud simulator is a session that is started, driven and stopped — unlike a local simulator, there is nothing to find that somebody else left booted.`,
      `How: start the app with "${start}". Once it opens, run this command again in another terminal. This starts a tunnelled dev server and selects Expo Go or a development build for the project. End the dev server and session with "${PROGRAM_PREFIX} dev:stop --eas" when done. To see this project's sessions, "${cloudSessionListCommand()}" lists them with their ids. To open the link elsewhere, "${PROGRAM_PREFIX} navigate <route> --print-url" prints the URL.`,
    ].join('\n')
  );
  error.suggestedCommand = start;
  return error;
}

/**
 * The failure for a session nothing could be established about.
 *
 * Deliberately not folded into {@link cloudSessionUnavailableError}: "start a session" is the wrong
 * instruction for a machine whose EAS CLI could not be asked, and following it would start a second
 * billed session next to one that may well be running. This is the `unknown` of the probe, which is
 * the same distinction `DeviceProbe.toolError` draws for `adb` (F49) — a tool that did not answer
 * has said nothing about the world.
 */
export function cloudSessionUnknownError(
  probe: Extract<CloudSessionProbe, { state: 'unknown' }>
): CommandError {
  // @ref llp/0027-everything-on-eas.rfc.md §What EAS said — when the listing failed on a sentence
  // this CLI recognises, the `How:` is the fix rather than "run the listing yourself".
  const cause = probe.failure
    ? classifyEasFailure(`${probe.failure.stdout}\n${probe.failure.stderr}`)
    : null;
  const error = new CommandError(
    'CLOUD_SIMULATOR_SESSION_UNKNOWN',
    [
      'Whether this project has a running EAS Simulator session could not be established, so nothing was opened on one.',
      `Why: ${probe.reason}. ${
        probe.sessionId
          ? `${CLOUD_SESSION_ENV_FILE} names session ${probe.sessionId}, and whether that session is still up is exactly what could not be read — so this is not being reported as "no session", which would be an instruction to start a second billed one.`
          : 'What this project has running could not be listed, so "no session" would be a guess, and acting on it would start a second billed one next to any that is up.'
      }`,
      cause
        ? `How: ${cause.how}`
        : `How: run "${cloudSessionListCommand()}" to see what the CLI says, and check that the "eas" being run is the EAS CLI. Then run this command again, or open the URL elsewhere with "${PROGRAM_PREFIX} navigate <route> --print-url".`,
    ].join('\n')
  );
  error.suggestedCommand = cause?.command ?? cloudSessionListCommand();

  // The same layer-3 hand-off a device verb does. A signed-out account stops the *question* about
  // the session exactly as it stops the answer, and both are a login rather than a broken CLI.
  const needsHuman = probe.failure && easNeedsHuman(probe.failure);
  return needsHuman
    ? needsHumanErrorFrom(needsHuman, { code: error.code, message: error.message })
    : error;
}

/** The failure for a `--ios`/`--android` that names the platform the session is not. */
export function cloudPlatformMismatchError(
  wanted: CloudPlatform,
  session: CloudPlatform,
  sessionId: string | null
): CommandError {
  const error = new CommandError(
    'CLOUD_SIMULATOR_PLATFORM_MISMATCH',
    [
      `--${wanted} names a platform the cloud simulator session is not, so nothing was opened.`,
      `Why: an EAS Simulator session is created for one platform and keeps it for its whole life${sessionId ? ` — session ${sessionId} is ${session}` : ''}. There is no second device in it to switch to.`,
      `How: run this command with --${session} (or with no platform flag, which takes the session's own), or start a ${wanted} session and run it again.`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} navigate / --eas --${session}`;
  return error;
}

/** The failure for a live session whose platform the service did not report. */
export function cloudPlatformUnknownError(sessionId: string | null): CommandError {
  const error = new CommandError(
    'CLOUD_SIMULATOR_PLATFORM_UNKNOWN',
    [
      `The running cloud simulator did not say which platform it is, so nothing was opened on it.`,
      `Why: the URL shape, the connect URL and the check for the app attaching afterwards all differ between iOS and Android, and ${sessionId ? `session ${sessionId}` : 'the session'} reported no platform for this command to read. Guessing one would open a link built for the other.`,
      `How: name it — run this command again with --ios or --android.`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} navigate / --eas --ios`;
  return error;
}

/**
 * The failure for a cloud run against a dev server no cloud simulator can reach.
 *
 * The one precondition that differs from every local backend, and the reason it is refused rather
 * than attempted: `exp://127.0.0.1:<port>` names the loopback of whatever resolves it, and on a
 * machine in EAS's datacenter that is a port nothing listens on — the same shape as the Android
 * emulator finding of llp/0005 §Cloud simulator, with no `adb reverse`
 * available to fix it. A LAN address is no better: the session is not on this network.
 */
export function cloudNeedsTunnelError(
  url: string,
  hostType: string | null,
  platform: 'ios' | 'android'
): CommandError {
  const error = new CommandError(
    'CLOUD_SIMULATOR_UNREACHABLE_DEV_SERVER',
    [
      `The dev server is only reachable from ${hostType === 'localhost' ? 'this machine' : 'this network'}, so a cloud simulator cannot load ${url} and nothing was opened.`,
      `Why: the URL carries a ${hostType ?? 'local'} host, and the simulator runs on EAS infrastructure — ${hostType === 'localhost' ? 'that host is the loopback of whatever resolves it, which there is a machine in a datacenter' : 'that address is on this network and the session is not'}. Opening it would land the app on an error screen with the device tool reporting success, which is the class of false green this command exists to remove.`,
      `How: restart the dev server with a tunnel — "${PROGRAM_PREFIX} dev --${platform} --detach --tunnel" — and run this command again. A tunnel serves the same dev server from any network, which is the one address a cloud simulator can use.`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} dev --${platform} --detach --tunnel`;
  return error;
}

/**
 * The controller session named in a `DEVICE_IN_USE` message, or null when it named none.
 *
 * `Device is already in use by session "default".` [observed — live, 2026-08-26]. Exported because
 * two callers need it: the advice below, and the cloud reload — which binds its verb to that session
 * and retries, rather than telling a reader to do it (`src/runtime/reload/cloudReload.ts`).
 */
export function readHeldSessionName(message: string): string | null {
  return /session\s+["']([^"']+)["']/.exec(message)?.[1] ?? null;
}

/**
 * What to do about a device the controller says is already in use.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §Cloud simulator — live run S14.
 *
 * `DEVICE_IN_USE` is the one controller refusal whose remedy is in its own message: it names the
 * session that holds the device. The general advice for a refused verb — "a session can end between
 * the moment it was listed and the moment a verb reaches it; start a new one if it has" — is the
 * opposite of the truth here, and acting on it bills a second machine and leaves this one held.
 *
 * The session name is read out of the controller's sentence rather than assumed: the observed one is
 * `Device is already in use by session "default".` [observed — live, 2026-08-26], and a message that
 * stops carrying a name falls back to advice that names none.
 */
function heldDeviceHow(message: string): string {
  const session = readHeldSessionName(message);
  return [
    session
      ? `The device is held by the session named ${JSON.stringify(session)}, so bind this verb to that session — the controller takes --session ${session} — or wait for whatever is holding it to let go.`
      : `The device is held by another session, so bind this verb to the session that holds it (the controller takes --session <name>), or wait for it to let go.`,
    `Do not start a second session: that bills another machine and leaves this one held. "${cloudSessionListCommand()}" shows which sessions are up.`,
  ].join(' ');
}

/**
 * The failure for a device verb that ran and did not work.
 *
 * Four things folded into one place, because all of them are about a subprocess this CLI cannot
 * verify: a binary that was never the EAS CLI is named as such rather than quoted (`wrapperCrash`),
 * a signed-out account becomes the needs-human handoff and exit `7` rather than a plain failure,
 * **the controller refusing is separated from the syntax being wrong**, and anything else quotes
 * what the tool printed.
 *
 * That third one was a live finding. The first cut had one "Why" for every non-zero exit — "a verb
 * or a flag this CLI sends may not be the one the installed eas-cli has" — and the first real
 * session printed `Error (COMMAND_FAILED): Simulator device failed to open myapp://.` under it
 * [observed — 2026-08-26]. The argv was right, the bridge worked, and the **device** had refused a
 * scheme no app on it had registered; sending that reader to `--help` would have had them checking
 * a command that was already correct.
 */
export function cloudVerbFailedError(
  result: CloudRunResult,
  { what, how }: { what: string; how: string }
): CommandError {
  if (result.spawnError) {
    return new CommandError(
      'CLOUD_SIMULATOR_TOOL_MISSING',
      [
        `Could not run "${result.command}", so ${what}`,
        `Why: ${result.spawnError}`,
        `How: ${EAS_RUNNER_RECOVERY}`,
      ].join('\n')
    );
  }

  // The controller's own refusal, which is a fact about the **device** rather than about the argv.
  const controller = readControllerError(`${result.stderr}\n${result.stdout}`);
  if (controller) {
    // One controller code carries its own remedy, and the general `how` is the opposite of it.
    const held = controller.code === 'DEVICE_IN_USE' ? heldDeviceHow(controller.message) : null;
    const error = new CommandError(
      'CLOUD_SIMULATOR_DEVICE_REFUSED',
      [
        `The cloud simulator refused the command, so ${what}`,
        `Why: the session's controller ran and answered ${controller.code} — "${controller.message}" — so the command reached the device and the device is what said no. This is not a syntax problem: "${result.command}" was accepted and executed.${
          held ? ` The session did not end: the device is up and something else is holding it.` : ''
        }`,
        `How: ${held ?? how}`,
      ].join('\n')
    );
    // The listing either way: for a session that may have ended it is how to find out, and for a
    // held device it is how to see which session is holding it. Neither starts anything.
    error.suggestedCommand = cloudSessionListCommand();
    return error;
  }

  const wrapperCrash = looksLikeWrapperCrash({ tool: 'eas', ...result });
  const detail = wrapperCrash
    ? runnerCrashDetail({ tool: 'eas', exitCode: result.exitCode }, result.command)
    : `\nWhat the tool printed:\n${(result.stderr.trim() || result.stdout.trim() || 'nothing').trim()}`;

  const error = new CommandError(
    'CLOUD_SIMULATOR_COMMAND_FAILED',
    [
      `"${result.command}" exited ${result.exitCode ?? 'on a signal'}, so ${what}`,
      `Why: the EAS Simulator commands are experimental, so a verb or a flag this CLI sends may not be the one the installed eas-cli has. ${
        wrapperCrash
          ? 'What ran under that name did not behave like the EAS CLI at all, which is the first thing to check.'
          : 'The output below is what it said.'
      }`,
      `How: ${how} Check the syntax the installed CLI has with "${checkBinaryCommand(result.binPath ?? 'eas', ['simulator:exec', '--help'])}".`,
      detail,
    ].join('\n')
  );

  // Layer 3 of the needs-human protocol: a signed-out account is a step only a person can complete,
  // and it moves the run into exit 7 rather than reporting a broken command (llp/0010).
  const needsHuman = easNeedsHuman(result);
  return needsHuman
    ? needsHumanErrorFrom(needsHuman, { code: error.code, message: error.message })
    : error;
}

/**
 * The failure for an act the cloud backend has no verb for.
 *
 * Kept for the acts that genuinely have none, and no longer used for `runtime:stop`: reading the
 * controller found `close <appId>`, which ends the named app and leaves the device up (llp/0005
 * §Cloud simulator). The distinction this text was protecting is real and
 * is now a **flag** — `close --shutdown` would stop the billed machine, and this CLI never passes
 * it — rather than a missing verb.
 */
export function cloudVerbNotSupportedError(action: string): CommandError {
  const error = new CommandError(
    'CLOUD_SIMULATOR_UNSUPPORTED',
    [
      `${action} is not something this CLI can do on a cloud simulator, so nothing ran.`,
      `Why: the controller that drives an EAS Simulator session has no verb for it. "eas simulator:stop" ends the whole session — the remote machine and everything on it — which is a larger act than the one asked for here, and doing it under this name would report a session teardown as the act that was requested.`,
      `How: to put the app back into a known state, open a route on it again with "${PROGRAM_PREFIX} navigate / --eas". To end the session itself, and its billing, run "${PROGRAM_PREFIX} dev:stop --eas".`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} dev:stop --eas`;
  return error;
}
