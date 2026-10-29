// @ref llp/0005-runtime-loop-tools.rfc.md §Cloud simulator
// Make sure this project has an EAS Simulator session with the app on it: reuse the one in
// progress, or start one pointed at the dev server's tunnel, and record it. `./openAppEas.ts` opens
// the app on the session this returns.

import path from 'path';
import {
  acquireCloudBindingAsync,
  claimCloudBindingsAsync,
  restoreRenewedLeaseAsync,
  type CloudBinding,
} from '../deviceBinding/cloud';
import { releaseStartedSessionAsync } from '../deviceBinding/cloudRelease';
import { cloudStopCommand } from '../deviceBinding/cleanup';

import {
  isLive,
  probeCloudSessionAsync,
  readCloudSessionIdSync,
  CLOUD_SESSION_ENV_FILE,
  CLOUD_SESSION_TIMEOUT_MS,
  type CloudPlatform,
  type CloudSessionProbe,
} from '../device/cloudSimulator';
import { otherPlatformSessionError } from '../device/cloudErrors';
import * as Log from '../log';
import { resolveRouteUrlAsync } from '../navigate/openRoute';
import { lookUpEasSimulatorBuildAsync } from '../plan/easBuildLookup';
import type { NativePlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import { EAS_SIMULATOR_PROFILE } from '../toolchain/runsOn';
import { easCliArgs, easCliLabel, resolveEasCli } from '../utils/easCli';
import { spawnCaptureAsync } from '../utils/spawnCapture';
import { ensureGitExcludedAsync } from '../utils/gitExclude';
import { easFailureReason } from '../utils/easFailure';
import type { CommandError } from '../utils/errors';
import { firstLine } from '../utils/text';
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

export interface EnsureEasSessionOptions {
  platform: NativePlatform;
  /** Whether the plan aims at Expo Go, which the session installs itself with `--expo-go`. */
  expoGo: boolean;
  /** Where the dev server this run started listens, on this machine. */
  devServerUrl: string;
  /**
   * The EAS build the session installs, for a development build. Null for Expo Go. For a
   * development build, null makes a new session look up the finished simulator build of this
   * fingerprint.
   */
  buildId: string | null;
  /** Whether that lookup may read the per-platform fingerprint out of the project's record. */
  fingerprintCache?: boolean;
  /** Whether the work is still worth performing, checked between the slow stages. */
  stillWanted?: () => boolean;
  /** What the session is called on expo.dev, for a person scanning the list later. */
  sessionName?: string;
  /**
   * Whether a session this run starts outlives it: true for a detached `dev` and a reopen, false
   * for smoke and a foreground `dev`, which stop it through `releaseStartedSessionAsync`
   * (llp/0035 §Preserved sessions). Only the progress line reads it here.
   */
  keepSession: boolean;
  /** The reason a development build with no build to install fails with, before any tunnel wait. */
  noBuildReason?: string;
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
  /** The one-session-per-worktree refusal, when {@link reason} is that refusal. */
  refusal?: CommandError;
  /** What the bind reported about keeping {@link CLOUD_SESSION_ENV_FILE} out of git. */
  gitExclude?: 'added' | 'tracked' | 'overridden';
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
    '--max-idle-time-minutes',
    '30',
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
  const created = /Simulator session created\s*\(id:\s*([^\s,)]+)/.exec(output);
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
 * Make sure this project has an EAS Simulator session on `platform` with the app on it.
 *
 * Reuses the session in progress on that platform when there is one, and otherwise starts one with
 * the app and the tunnelled launch URL on its command line. Never throws.
 */
export async function ensureEasSessionAsync(
  projectRoot: string,
  options: EnsureEasSessionOptions
): Promise<EnsureEasSessionReport> {
  const startedAt = new Date();
  const session = await ensureSessionAsync(projectRoot, options);
  if (
    session.sessionId &&
    session.started &&
    options.stillWanted?.() === false &&
    (await endedBeforeBindAsync(projectRoot, options.platform, session.sessionId))
  ) {
    const reason = `Session ${session.sessionId} ended before it was recorded; nothing is bound.`;
    Log.log(reason);
    const gitExclude = await excludeCloudSessionEnvFromGitAsync(projectRoot);
    return { ...session, ok: false, reason, ...(gitExclude && { gitExclude }) };
  }
  if (session.sessionId) {
    let binding: CloudBinding;
    try {
      binding = await acquireCloudBindingAsync(projectRoot, {
        platform: options.platform,
        id: session.sessionId,
        origin: session.started ? 'started' : 'dotenv',
        start: session.started
          ? { at: startedAt, dotenvId: () => readCloudSessionIdSync(projectRoot) }
          : undefined,
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      if (!session.started)
        return {
          ...session,
          ok: false,
          reason: `EAS session ${session.sessionId} could not be recorded: ${why}`,
        };
      return await releaseUnrecordedStartAsync(projectRoot, session, session.sessionId, why);
    }
    if (binding.device.id !== session.sessionId)
      return {
        ...session,
        ok: false,
        sessionId: null,
        started: false,
        reason: `another run in this worktree started EAS session ${binding.device.id} at the same time, and ${CLOUD_SESSION_ENV_FILE} names it, so this run ended its own session ${session.sessionId} ("${cloudStopCommand(session.sessionId)}" ends it if that failed); run this again to use ${binding.device.id}`,
      };
    const gitExclude = await excludeCloudSessionEnvFromGitAsync(projectRoot);
    if (gitExclude) {
      return { ...session, gitExclude };
    }
  }
  return session;
}

// @ref llp/0035-one-device-per-worktree.rfc.md §EAS
async function excludeCloudSessionEnvFromGitAsync(
  projectRoot: string
): Promise<EnsureEasSessionReport['gitExclude']> {
  const excluded = await ensureGitExcludedAsync(projectRoot, CLOUD_SESSION_ENV_FILE);
  if (excluded.result === 'overridden') {
    Log.warn(
      `git does not ignore ${CLOUD_SESSION_ENV_FILE}, which holds this session's auth token: the rule ${excluded.rule} un-ignores it. Remove that rule, or "git add" can commit the token.`
    );
    return excluded.result;
  }
  if (excluded.result === 'added') {
    Log.progress(
      `Added ${CLOUD_SESSION_ENV_FILE} to git's info/exclude: it holds this session's auth token.`
    );
    return excluded.result;
  }
  if (excluded.result === 'tracked') {
    Log.warn(
      `git tracks ${CLOUD_SESSION_ENV_FILE}, which holds this session's auth token. Run "git rm --cached ${CLOUD_SESSION_ENV_FILE}" and list it in .gitignore.`
    );
    return excluded.result;
  }
  return undefined;
}

/**
 * Whether a listing that can be read no longer shows a session this run started after Metro
 * stopped: a concurrent `dev:stop --eas` may have ended it. A listing that cannot be read keeps it.
 */
// @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
async function endedBeforeBindAsync(
  projectRoot: string,
  platform: NativePlatform,
  sessionId: string
): Promise<boolean> {
  const probe = await probeCloudSessionAsync({
    projectRoot,
    platform,
    boundIds: [sessionId],
    timeoutMs: CLOUD_SESSION_TIMEOUT_MS,
  });
  if (probe.state === 'unknown' || probe.state === 'unavailable') return false;
  return !(isLive(probe) && probe.session.id === sessionId);
}

/**
 * A session this run started and could not bind. Stopped at once, unless a binding in this
 * worktree records it: another run may have selected it through the dotenv and bound it.
 */
// @ref llp/0035-one-device-per-worktree.rfc.md §Session binding — a session no binding records belongs to no run
async function releaseUnrecordedStartAsync(
  projectRoot: string,
  session: EnsureEasSessionReport,
  sessionId: string,
  why: string
): Promise<EnsureEasSessionReport> {
  const release = await releaseStartedSessionAsync(projectRoot, sessionId, 'dev');
  if (release.outcome === 'stopped')
    return {
      ...session,
      ok: false,
      sessionId: null,
      started: false,
      reason: `this run started EAS session ${sessionId}, could not record it (${why}), and stopped it`,
    };
  if (release.outcome === 'kept')
    return {
      ...session,
      ok: false,
      started: false,
      reason: `this run started EAS session ${sessionId} and could not record it (${why}); ${release.reason}`,
    };
  return {
    ...session,
    ok: false,
    reason: `EAS session ${sessionId} could not be recorded (${why}) or stopped: ${release.reason}`,
  };
}

/** @ref llp/0035-one-device-per-worktree.rfc.md §One session per worktree */
export function otherPlatformSession(
  probe: CloudSessionProbe,
  platform: NativePlatform
): { sessionId: string; platform: CloudPlatform | null } | null {
  return isLive(probe) && probe.session.platform !== platform
    ? { sessionId: probe.session.id, platform: probe.session.platform }
    : null;
}

// oxlint-disable-next-line max-lines-per-function -- known debt: split this before it grows
async function ensureSessionAsync(
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
  //    two minutes to learn that the session it is about to drive was there all along. The deep
  //    link still needs the tunnel, so the open after this waits for it (`openAppOnEasAsync`).
  const easCli = resolveEasCli(projectRoot);
  if (!easCli) {
    return failed(
      'no "eas" is in node_modules/.bin or on PATH, and no package runner ("npx" or "bunx") is on PATH to download one, so no EAS Simulator session could be reached'
    );
  }
  let claim: Awaited<ReturnType<typeof claimCloudBindingsAsync>>;
  try {
    claim = await claimCloudBindingsAsync(projectRoot, platform);
  } catch (error) {
    return failed(
      `the device registry could not be read, so no session was started: ${error instanceof Error ? firstLine(error.message) : String(error)}`
    );
  }
  if (claim.unreadable)
    return failed(
      `the EAS binding at ${claim.unreadable} cannot be read, so no session was started; remove that file after "${PROGRAM_PREFIX} dev:stop --eas"`
    );
  const probe = await probeCloudSessionAsync({
    projectRoot,
    easCli,
    platform,
    boundIds: claim.boundIds,
    timeoutMs: CLOUD_SESSION_TIMEOUT_MS,
  });
  // The renewal kept a reap off a session that may still be alive. One the listing does not show
  // is not, so its binding keeps the lease it had.
  if (claim.renewed && !(isLive(probe) && probe.session.id === claim.renewed.id))
    await restoreRenewedLeaseAsync(claim.renewed);
  if (probe.state === 'active' && probe.session.platform === platform) {
    event('open_app_eas_session_reused', { platform, sessionId: probe.session.id });
    return {
      ok: true,
      sessionId: probe.session.id,
      started: false,
      tunnelHost: null,
      openUrl: null,
      sessionUrl: null,
      reason: null,
    };
  }
  if (probe.state === 'unknown' || probe.state === 'unavailable') return failed(probe.reason);
  if (probe.state === 'queued' && probe.session.platform === platform)
    return failed(
      `EAS Simulator session ${probe.session.id} is not up yet${probe.session.status ? ` (status ${probe.session.status})` : ''}; run this again in a minute`,
      { sessionId: probe.session.id }
    );
  const other = otherPlatformSession(probe, platform);
  if (other) {
    const refusal = otherPlatformSessionError(other.platform, {
      wanted: platform,
      sessionId: other.sessionId,
      devServerRunning: true,
    });
    return failed(firstLine(refusal.message), { refusal });
  }
  if (!stillWanted()) {
    return failed('the dev server stopped before a session was started');
  }

  // 2. The app a new session installs. A development build with no id is looked up here, after the
  //    reuse above and before the tunnel wait: only a new session pays for the lookup, and a run
  //    with no build fails without waiting for a tunnel it would not use.
  const buildId = options.expoGo
    ? null
    : (options.buildId ??
      (
        await lookUpEasSimulatorBuildAsync(projectRoot, platform, {
          fingerprintCache: options.fingerprintCache,
        })
      )?.id ??
      null);
  if (!options.expoGo && !buildId) {
    return failed(
      options.noBuildReason ??
        `no EAS build to install on a new session: nothing named a finished "${EAS_SIMULATOR_PROFILE}" build of this project for ${platform}. Build one with "${easCommandPrefix()} build --platform ${platform} --profile ${EAS_SIMULATOR_PROFILE}" and run this again.`
    );
  }

  // 3. The tunnel, which a session about to be started is pointed at. Asked of the dev server
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

  // 4. The URL the app opens on the session, in the form the app it is takes: `exp://<host>` for
  //    Expo Go, `<scheme>://expo-development-client/?url=…` for a development build. Resolved the
  //    way `navigate` resolves it, so the two commands never disagree about the link.
  let openUrl: string;
  try {
    openUrl = await resolveEasOpenUrlAsync(projectRoot, options, tunnelHost);
  } catch (error: unknown) {
    return failed(error instanceof Error ? firstLine(error.message) : String(error), {
      tunnelHost,
    });
  }

  if (!stillWanted()) {
    return failed('the dev server stopped before a session was started', { tunnelHost, openUrl });
  }

  // 5. No usable session: start one, with the app and the URL on the command line.
  const app = buildId ? ({ expoGo: false, buildId } as const) : ({ expoGo: true } as const);
  const args = buildSessionStartArgs({
    platform,
    app,
    openUrl,
    name: options.sessionName ?? `${path.basename(projectRoot)} — agent-cli dev`,
  });
  event('open_app_eas_session_start', {
    platform,
    app: options.expoGo ? 'expo-go' : 'dev-build',
    buildId,
  });
  Log.progress(
    `Starting an EAS Simulator session (${platform}) with ${
      options.expoGo ? 'the Expo Go this SDK ships' : `build ${buildId}`
    } — a few minutes, nothing is stuck. ${
      options.keepSession
        ? `The session bills until "${PROGRAM_PREFIX} dev:stop --eas".`
        : 'This run will stop the session afterwards.'
    }`
  );
  const spawnOptions = {
    cwd: projectRoot,
    timeoutMs: options.waits?.sessionStartMs ?? EAS_SESSION_START_TIMEOUT_MS,
  };
  let result = await spawnCaptureAsync(easCli.command, easCliArgs(easCli, args), spawnOptions);
  if (
    result.exitCode !== 0 &&
    !readSessionId(`${result.stdout}\n${result.stderr}`) &&
    /Nonexistent flags?:[^\n]*--max-idle-time-minutes\b/i.test(result.stderr)
  ) {
    event('open_app_eas_flag_unsupported', { flag: '--max-idle-time-minutes' });
    const index = args.indexOf('--max-idle-time-minutes');
    const retry = [...args.slice(0, index), ...args.slice(index + 2)];
    result = await spawnCaptureAsync(easCli.command, easCliArgs(easCli, retry), spawnOptions);
  }
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
    return failed(
      `${easFailureReason(result, `${easCliLabel(easCli)} ${args.join(' ')}`)}${
        sessionId
          ? ` — the session ${sessionId} was created before it failed and may be billing; "${cloudStopCommand(sessionId)}" ends it`
          : ''
      }`,
      {
        tunnelHost,
        openUrl,
        sessionId,
        sessionUrl,
        started: sessionId != null,
      }
    );
  }
  return {
    ok: true,
    sessionId,
    started: true,
    tunnelHost,
    openUrl,
    sessionUrl,
    reason: null,
  };
}

/** The connection URL for the app the plan selected, shared by new and reused sessions. */
export async function resolveEasOpenUrlAsync(
  projectRoot: string,
  options: EnsureEasSessionOptions,
  tunnelHost: string
): Promise<string> {
  const resolved = await resolveRouteUrlAsync(projectRoot, {
    route: '/',
    platform: options.platform,
    devServerUrl: options.devServerUrl,
    devServerUrlSource: 'discovered',
    tunnelHost,
    routeCheck: false,
    command: 'navigate',
  });
  const target = options.expoGo ? 'expo-go' : 'dev-build';
  const connect = resolved.connect.find((entry) => entry.target === target);
  if (!connect) {
    throw new Error(
      `no URL to point ${options.expoGo ? 'Expo Go' : 'the development build'} at this dev server could be built — ${resolved.resolution}`
    );
  }
  // Full URL routes bypass openRoute's host check. Refuse a resolver fallback to LAN or loopback,
  // or any other host than the tunnel just read from the manifest.
  const serverUrl = options.expoGo ? connect.url : new URL(connect.url).searchParams.get('url');
  if (!serverUrl || new URL(serverUrl).host !== tunnelHost) {
    throw new Error('the connection URL does not point at the current tunnel');
  }
  return connect.url;
}

/** The dev server's advertised tunnel host, polled for until it appears or the wait runs out. */
export async function waitForTunnelHostAsync(
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
