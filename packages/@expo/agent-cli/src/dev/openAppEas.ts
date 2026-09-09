// @ref llp/0027-everything-on-eas.rfc.md §The open is a session
// What `dev --eas` does once its dev server is up: get the app onto an EAS Simulator session and
// open it there. The counterpart of `./openApp.ts`, for a device that is in a datacenter. `smoke
// --eas` uses the same session half (`ensureEasSessionAsync`) as its bootstrap.
//
// Three facts shape it:
//
//  1. **The session has to reach the dev server.** `exp://127.0.0.1:8081` names the loopback of
//     whatever resolves it, and for a session that is a machine on EAS. So the run is tunnelled
//     (`resolveDevOptions` implies `--tunnel`), and the first thing this waits for is the dev
//     server advertising a tunnel host — asked of the dev server itself, the way
//     `resolveDevServerReachAsync` does, because a foreground run captures no log.
//  2. **A bare session has no app on it.** `eas simulator` takes the app on the command line:
//     `--expo-go` installs the Expo Go this SDK ships, `--build-id` installs an EAS build, and
//     `--open-url` opens a URL in it once it is up [observed — eas-cli 23.2 `simulator/index.ts`].
//     Without `--open-url` the first deep link raises "Open in Expo Go?" on a device nobody is at
//     (llp/0005 §Cloud simulator; `e2e-live/__tests__/live-cloud-test.ts` fact 4).
//  3. **A session bills until it is stopped.** So one this project already has is reused before one
//     is started, and every sentence that says a session was started says how to stop it.
//
// Never throws: `dev`'s server outlives a failed open, the same as for a local device.

import path from 'path';

import {
  probeCloudSessionAsync,
  CLOUD_SESSION_TIMEOUT_MS,
  type CloudPlatform,
} from '../device/cloudSimulator';
import * as Log from '../log';
import { openRouteAsync, resolveRouteUrlAsync } from '../navigate/openRoute';
import type { NativePlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import { EAS_SIMULATOR_PROFILE } from '../toolchain/runsOn';
import { easCliArgs, easCliLabel, resolveEasCli, type EasCli } from '../utils/easCli';
import { spawnCaptureAsync } from '../utils/spawnCapture';
import { parseCachedBuild } from '../impact/buildCache';
import { fetchAdvertisedUrlAsync } from './advertisedUrl';
import { event } from './events';
import { easCommandPrefix } from '../utils/easCli';

/** How long the dev server may take to advertise a tunnel host before the open gives up. */
export const EAS_TUNNEL_WAIT_MS = 120_000;

/** How often the dev server is asked for its advertised host while the tunnel comes up. */
const TUNNEL_POLL_MS = 2_000;

/**
 * How long `eas simulator` may take to start a session and report it ready.
 *
 * A session boots a virtual machine, installs an app, and launches it; two to four minutes was the
 * observed range, and a start that never becomes ready is given up on by the EAS CLI's own wait
 * (ten minutes) before this bound is reached [observed — expo-ci, 2026-09-06].
 */
export const EAS_SESSION_START_TIMEOUT_MS = 15 * 60_000;

/** How long `eas simulator:stop` may take. */
export const EAS_SESSION_STOP_TIMEOUT_MS = 60_000;

/** How long the `build:list` that names the build this run just made may take. */
const BUILD_LOOKUP_TIMEOUT_MS = 60_000;

export interface EnsureEasSessionOptions {
  platform: NativePlatform;
  /** Whether the plan aims at Expo Go, which the session installs itself with `--expo-go`. */
  expoGo: boolean;
  /** Where the dev server this run started listens, on this machine. */
  devServerUrl: string;
  /**
   * The EAS build the session installs, for a development build. Null for Expo Go, and null when
   * the run built one and could not name it — which is reported rather than guessed around.
   */
  buildId: string | null;
  /** Whether the work is still worth performing, checked between the slow stages. */
  stillWanted?: () => boolean;
  /** What the session is called on expo.dev, for a person scanning the list later. */
  sessionName?: string;
  /** Injected for tests. */
  waits?: { tunnelMs?: number; sessionStartMs?: number };
}

/** What making sure there is a session with the app on it amounted to. */
export interface EnsureEasSessionReport {
  /** A session on this platform is up, with the app on it (started) or at least drivable (reused). */
  ok: boolean;
  /** The session, or null when none was reached. */
  sessionId: string | null;
  /** Whether this run started the session, rather than finding one up. */
  started: boolean;
  /** The tunnel host the session was pointed at, when one was found. */
  tunnelHost: string | null;
  /** The URL that loads the app against this dev server, once the tunnel was known. */
  openUrl: string | null;
  /** Where a person watches the session, when the EAS CLI printed it. */
  sessionUrl: string | null;
  /** Why there is no session. Null exactly when {@link ok} is true. */
  reason: string | null;
}

export type OpenAppOnEasOptions = EnsureEasSessionOptions;

/** What one open on EAS amounted to. */
export interface OpenAppOnEasReport {
  opened: boolean;
  /** The session the app was opened on, or null when none was reached. */
  sessionId: string | null;
  /** Whether this run started the session, rather than finding one up. */
  started: boolean;
  /** The tunnel host the session was pointed at, when one was found. */
  tunnelHost: string | null;
  /** Where a person watches the session, when the EAS CLI printed it. */
  sessionUrl: string | null;
  /** Why the app was not opened. Null exactly when {@link opened} is true. */
  reason: string | null;
}

/** The argv of the session start, pure and exported so the test table pins it. */
export function buildSessionStartArgs({
  platform,
  app,
  openUrl,
  name,
}: {
  platform: NativePlatform;
  app: { expoGo: true } | { expoGo: false; buildId: string };
  openUrl: string;
  name: string;
}): string[] {
  return [
    // `eas simulator` rather than `eas simulator:start`: that is the command name in the CLI's own
    // manifest, and the one carrying `--expo-go` [observed — eas-cli 22.6 `oclif.manifest.json`].
    'simulator',
    '--platform',
    platform,
    '--type',
    'agent-device',
    ...(app.expoGo ? ['--expo-go'] : ['--build-id', app.buildId]),
    '--open-url',
    openUrl,
    '--non-interactive',
    '--name',
    name,
  ];
}

/** The argv that ends one session, by id — never the bare form, which stops whatever the dotenv names. */
export function buildSessionStopArgs(sessionId: string): string[] {
  return ['simulator:stop', '--id', sessionId, '--non-interactive'];
}

/** The `build:list` that names the newest finished simulator build of a platform. */
export function buildLatestSimulatorBuildArgs(platform: NativePlatform): string[] {
  return [
    'build:list',
    '--platform',
    platform,
    '--build-profile',
    EAS_SIMULATOR_PROFILE,
    '--status',
    'finished',
    '--limit',
    '1',
    '--json',
    '--non-interactive',
  ];
}

/**
 * The session id out of what `eas simulator` printed.
 *
 * `Simulator session created (id: <id>)` is printed as soon as the session exists — before the
 * wait for readiness, so a start that then fails still names the session it billed
 * [observed — eas-cli 23.2 `simulator/index.ts`; expo-ci, 2026-09-06]. The `--json` form is read
 * too, for a caller that passed it.
 */
export function readSessionId(output: string): string | null {
  // `(id: <id>)` with `--json`, and `(id: <id>, saved to .env.eas-simulator)` without it — the
  // form this CLI runs, which the first regex here did not read [observed — live, expo-ci,
  // 2026-09-08: "Opened the app on EAS Simulator session (id unknown)" beside the session's URL].
  const created = /\(id:\s*([^\s,)]+)/.exec(output);
  if (created) {
    return created[1]!;
  }
  // The session page names it too, and is printed on the same line.
  const fromUrl = /simulator-sessions\/([^\s/)]+)/.exec(output);
  if (fromUrl) {
    return fromUrl[1]!;
  }
  const start = output.indexOf('{');
  if (start >= 0) {
    try {
      const parsed = JSON.parse(output.slice(start)) as { id?: unknown };
      if (typeof parsed.id === 'string' && parsed.id) {
        return parsed.id;
      }
    } catch {
      // Not JSON, or not the JSON of a session — the line above is the answer then.
    }
  }
  return null;
}

/** The session's page on expo.dev out of what `eas simulator` printed, or null. */
export function readSessionUrl(output: string): string | null {
  return /https:\/\/expo\.dev\/\S*simulator-sessions\/[^\s)]+/.exec(output)?.[0] ?? null;
}

/**
 * The id of the newest finished simulator build of `platform`, or null.
 *
 * Asked right after this run's own `eas build` finished, so the newest finished build of the
 * profile is the one that just finished. Asked rather than parsed out of the build step: the step
 * runs in `inherit` mode so its progress reaches the terminal, and a captured `--json` run would
 * take that away from the one step that takes fifteen minutes.
 */
export async function findLatestSimulatorBuildIdAsync(
  projectRoot: string,
  platform: NativePlatform,
  easCli: EasCli | null = resolveEasCli(projectRoot)
): Promise<string | null> {
  if (!easCli) {
    return null;
  }
  const result = await spawnCaptureAsync(
    easCli.command,
    easCliArgs(easCli, buildLatestSimulatorBuildArgs(platform)),
    { cwd: projectRoot, timeoutMs: BUILD_LOOKUP_TIMEOUT_MS }
  );
  if (result.spawnError || result.exitCode !== 0) {
    return null;
  }
  return parseCachedBuild(result.stdout)?.id ?? null;
}

/**
 * Make sure this project has an EAS Simulator session on `platform` with the app on it.
 *
 * Reuses the session in progress on that platform when there is one, and otherwise starts one with
 * the app and the tunnelled launch URL on its command line. Never throws.
 */
export async function ensureEasSessionAsync(
  projectRoot: string,
  options: EnsureEasSessionOptions
): Promise<EnsureEasSessionReport> {
  const { platform } = options;
  const stillWanted = options.stillWanted ?? (() => true);
  const failed = (
    reason: string,
    partial: Partial<EnsureEasSessionReport> = {}
  ): EnsureEasSessionReport => ({
    ok: false,
    sessionId: null,
    started: false,
    tunnelHost: null,
    openUrl: null,
    sessionUrl: null,
    reason,
    ...partial,
  });

  // 1. A session this project already has, on this platform, is the device: reuse it. Asked before
  //    the tunnel, because a session that is up needs no URL from here — `openRouteAsync` builds
  //    the deep link it is sent — and a gate whose dev server carries no tunnel yet must not wait
  //    two minutes to learn that the session it is about to drive was there all along.
  const easCli = resolveEasCli(projectRoot);
  if (!easCli) {
    return failed(
      'no "eas" is in node_modules/.bin or on PATH, and no package runner ("npx" or "bunx") is on PATH to download one, so no EAS Simulator session could be reached'
    );
  }
  const probe = await probeCloudSessionAsync({
    projectRoot,
    easCli,
    platform: platform as CloudPlatform,
    timeoutMs: CLOUD_SESSION_TIMEOUT_MS,
  });
  if (probe.state === 'active' && probe.platform === platform && probe.sessionId) {
    event('open_app_eas_session_reused', { platform, sessionId: probe.sessionId });
    return {
      ok: true,
      sessionId: probe.sessionId,
      started: false,
      tunnelHost: null,
      openUrl: null,
      sessionUrl: null,
      reason: null,
    };
  }
  if (!stillWanted()) {
    return failed('the dev server stopped before a session was started');
  }

  // 2. The tunnel, which a session about to be started is pointed at. Asked of the dev server
  //    itself: its manifest names the origin a device uses.
  const tunnelHost = await waitForTunnelHostAsync(options, stillWanted);
  event('open_app_eas_tunnel', { platform, host: tunnelHost });
  if (!tunnelHost) {
    if (!stillWanted()) {
      return failed('the dev server stopped before its tunnel came up');
    }
    return failed(
      `the dev server advertised no tunnel host within ${Math.round((options.waits?.tunnelMs ?? EAS_TUNNEL_WAIT_MS) / 1000)}s, and a session on EAS cannot reach this machine's loopback — the dev server has to run with --tunnel`
    );
  }

  // 3. The URL the app opens on the session, in the form the app it is takes: `exp://<host>` for
  //    Expo Go, `<scheme>://expo-development-client/?url=…` for a development build. Resolved the
  //    way `navigate` resolves it, so the two commands never disagree about the link.
  let openUrl: string;
  try {
    const resolved = await resolveRouteUrlAsync(projectRoot, {
      route: '/',
      platform,
      devServerUrl: options.devServerUrl,
      devServerUrlSource: 'discovered',
      routeCheck: false,
      command: 'navigate',
    });
    const target = options.expoGo ? 'expo-go' : 'dev-build';
    const connect = resolved.connect.find((entry) => entry.target === target);
    if (!connect) {
      return failed(
        `no URL to point ${options.expoGo ? 'Expo Go' : 'the development build'} at this dev server could be built — ${resolved.resolution}`,
        { tunnelHost }
      );
    }
    openUrl = connect.url;
  } catch (error: unknown) {
    return failed(error instanceof Error ? firstLine(error.message) : String(error), {
      tunnelHost,
    });
  }

  if (!stillWanted()) {
    return failed('the dev server stopped before a session was started', { tunnelHost, openUrl });
  }

  // 4. No usable session: start one, with the app and the URL on the command line.
  if (!options.expoGo && !options.buildId) {
    return failed(
      `no EAS build to install on a new session: nothing named a finished "${EAS_SIMULATOR_PROFILE}" build of this project for ${platform}. Build one with "${easCommandPrefix()} build --platform ${platform} --profile ${EAS_SIMULATOR_PROFILE}" and run this again.`,
      { tunnelHost, openUrl }
    );
  }
  const app = options.expoGo
    ? ({ expoGo: true } as const)
    : ({ expoGo: false, buildId: options.buildId! } as const);
  const args = buildSessionStartArgs({
    platform,
    app,
    openUrl,
    name: options.sessionName ?? `${path.basename(projectRoot)} — agent-cli dev`,
  });
  event('open_app_eas_session_start', {
    platform,
    app: options.expoGo ? 'expo-go' : 'dev-build',
    buildId: options.expoGo ? null : options.buildId,
  });
  Log.progress(
    `Starting an EAS Simulator session (${platform}) with ${
      options.expoGo ? 'the Expo Go this SDK ships' : `build ${options.buildId}`
    } — a few minutes, nothing is stuck. The session bills until "${easCommandPrefix()} simulator:stop".`
  );
  const result = await spawnCaptureAsync(easCli.command, easCliArgs(easCli, args), {
    cwd: projectRoot,
    timeoutMs: options.waits?.sessionStartMs ?? EAS_SESSION_START_TIMEOUT_MS,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const sessionId = readSessionId(output);
  const sessionUrl = readSessionUrl(output);
  if (result.spawnError) {
    return failed(`"${easCliLabel(easCli)} ${args[0]}" could not be run (${result.spawnError})`, {
      tunnelHost,
      openUrl,
    });
  }
  if (result.exitCode !== 0) {
    const said = firstLine(result.stderr) || firstLine(result.stdout) || 'it printed nothing';
    return failed(
      `"${easCliLabel(easCli)} ${args.join(' ')}" exited ${result.exitCode}: ${said}${
        sessionId
          ? ` — the session ${sessionId} was created before it failed and may be billing; "${easCommandPrefix()} simulator:stop --id ${sessionId}" ends it`
          : ''
      }`,
      { tunnelHost, openUrl, sessionId, sessionUrl }
    );
  }
  return { ok: true, sessionId, started: true, tunnelHost, openUrl, sessionUrl, reason: null };
}

/**
 * End one session by id. Never throws.
 *
 * By id and never the bare `simulator:stop`, which stops whatever `.env.eas-simulator` names —
 * possibly a session somebody else is driving.
 */
export async function stopEasSessionAsync(
  projectRoot: string,
  sessionId: string,
  easCli: EasCli | null = resolveEasCli(projectRoot)
): Promise<{ ok: boolean; reason: string | null }> {
  if (!easCli) {
    return { ok: false, reason: 'no "eas" or package runner is on PATH to stop the session with' };
  }
  const args = buildSessionStopArgs(sessionId);
  const result = await spawnCaptureAsync(easCli.command, easCliArgs(easCli, args), {
    cwd: projectRoot,
    timeoutMs: EAS_SESSION_STOP_TIMEOUT_MS,
  });
  if (result.spawnError) {
    return { ok: false, reason: `"${easCliLabel(easCli)} ${args[0]}" could not be run (${result.spawnError})` };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `"${easCliLabel(easCli)} ${args.join(' ')}" exited ${result.exitCode}: ${
        firstLine(result.stderr) || firstLine(result.stdout) || 'it printed nothing'
      }`,
    };
  }
  return { ok: true, reason: null };
}

export async function openAppOnEasAsync(
  projectRoot: string,
  options: OpenAppOnEasOptions
): Promise<OpenAppOnEasReport> {
  const { platform } = options;
  const stillWanted = options.stillWanted ?? (() => true);
  const session = await ensureEasSessionAsync(projectRoot, options);
  const base = {
    sessionId: session.sessionId,
    started: session.started,
    tunnelHost: session.tunnelHost,
    sessionUrl: session.sessionUrl,
  };
  if (!session.ok) {
    return { ...base, opened: false, reason: session.reason ?? 'no session was reached' };
  }
  if (session.started) {
    // `--open-url` opened the app as the session came up; there is nothing further to send.
    event('open_app_eas_opened', { platform, sessionId: session.sessionId, started: true });
    return { ...base, opened: true, reason: null };
  }

  // A session that was already up gets the deep link the way `navigate --eas` sends it.
  Log.progress(`Opening the app on EAS Simulator session ${session.sessionId}, which is already up.`);
  if (!stillWanted()) {
    return { ...base, opened: false, reason: 'the dev server stopped before the app was opened' };
  }
  try {
    const result = await openRouteAsync(projectRoot, {
      route: '/',
      platform,
      devServerUrl: options.devServerUrl,
      devServerUrlSource: 'discovered',
      routeCheck: false,
      command: 'navigate',
      cloud: 'required',
    });
    if (result.exitCode !== 0) {
      return {
        ...base,
        opened: false,
        reason: `the session refused the deep link ("${result.command}" exited ${result.exitCode})`,
      };
    }
  } catch (error: unknown) {
    return {
      ...base,
      opened: false,
      reason: error instanceof Error ? firstLine(error.message) : String(error),
    };
  }
  event('open_app_eas_opened', { platform, sessionId: session.sessionId, started: false });
  return { ...base, opened: true, reason: null };
}

/** The dev server's advertised tunnel host, polled for until it appears or the wait runs out. */
async function waitForTunnelHostAsync(
  options: EnsureEasSessionOptions,
  stillWanted: () => boolean
): Promise<string | null> {
  const deadline = Date.now() + (options.waits?.tunnelMs ?? EAS_TUNNEL_WAIT_MS);
  let announced = false;
  while (stillWanted()) {
    const advertised = await fetchAdvertisedUrlAsync(options.devServerUrl, {
      platform: options.platform,
    });
    if (advertised?.hostType === 'tunnel') {
      return advertised.host;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    if (!announced) {
      announced = true;
      Log.progress(
        'Waiting for the dev server’s tunnel, which the EAS Simulator session opens the app through.'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, TUNNEL_POLL_MS));
  }
  return null;
}

/** The one line `dev` says about an open on EAS that did not happen, with the door that still works. */
export function openAppOnEasFailureLine(platform: NativePlatform, reason: string): string {
  return `The app was not opened on an EAS Simulator session: ${reason}. The dev server is up; once a session is, "${PROGRAM_PREFIX} navigate / --eas --${platform}" opens the app on it.`;
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? '';
}
