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

import { claimable, readCloudBindings } from '../deviceBinding/cloud';
import { releaseStartedSessionAsync } from '../deviceBinding/cloudRelease';

import {
  probeCloudSessionAsync,
  readCloudSessionIdSync,
  CLOUD_SESSION_TIMEOUT_MS,
  type CloudPlatform,
} from '../device/cloudSimulator';
import * as Log from '../log';
import { openRouteAsync } from '../navigate/openRoute';
import type { NativePlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import { EAS_SIMULATOR_PROFILE } from '../toolchain/runsOn';
import { easCliArgs, resolveEasCli, type EasCli } from '../utils/easCli';
import { spawnCaptureAsync } from '../utils/spawnCapture';
import type { CommandError } from '../utils/errors';
import { firstLine } from '../utils/text';
import { parseCachedBuild } from '../impact/buildCache';
import { event } from './events';
import {
  EAS_TUNNEL_WAIT_MS,
  ensureEasSessionAsync,
  otherPlatformSession,
  resolveEasOpenUrlAsync,
  waitForTunnelHostAsync,
  type EnsureEasSessionOptions,
} from './easSession';

/** How long the `build:list` that names the build this run just made may take. */
const BUILD_LOOKUP_TIMEOUT_MS = 60_000;

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
  /** The one-session-per-worktree refusal, when {@link reason} is that refusal. */
  refusal?: CommandError;
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
 * The session on another platform that would refuse a `dev --<platform> --eas`, asked before a
 * detached run starts its dev server. Read-only. Null when no binding and no dotenv point at
 * another platform, or when discovery is unsure: the child then decides. A session that reports no
 * platform counts, as it does for the refusal in `ensureSessionAsync`.
 */
export async function otherPlatformSessionAsync(
  projectRoot: string,
  platform: NativePlatform
): Promise<{ sessionId: string; platform: CloudPlatform | null } | null> {
  const bindings = claimable(readCloudBindings(projectRoot).bindings, platform, new Date());
  const ids = bindings.map(({ device }) => device.id);
  const askedIds = bindings.flatMap(({ device }) =>
    device.platform === platform ? [device.id] : []
  );
  const dotenvId = readCloudSessionIdSync(projectRoot);
  if (ids.length === askedIds.length && (dotenvId == null || askedIds.includes(dotenvId))) {
    return null;
  }
  const easCli = resolveEasCli(projectRoot);
  if (!easCli) {
    return null;
  }
  const probe = await probeCloudSessionAsync({
    projectRoot,
    easCli,
    platform,
    boundIds: ids,
    timeoutMs: CLOUD_SESSION_TIMEOUT_MS,
  });
  return otherPlatformSession(probe, platform);
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
    refusal: session.refusal,
  };
  if (!session.ok) {
    return { ...base, opened: false, reason: session.reason ?? 'no session was reached' };
  }
  if (session.started) {
    // `--open-url` opened the app as the session came up; there is nothing further to send.
    event('open_app_eas_opened', { platform, sessionId: session.sessionId, started: true });
    return { ...base, opened: true, reason: null };
  }

  // The session can outlive Metro and its tunnel. Wait for the current tunnel before opening the
  // app, just as when starting a session; a cloud device cannot reach this machine's loopback.
  const tunnelHost = await waitForTunnelHostAsync(options, stillWanted);
  if (!tunnelHost) {
    return {
      ...base,
      opened: false,
      reason: stillWanted()
        ? `the dev server advertised no tunnel host within ${Math.round((options.waits?.tunnelMs ?? EAS_TUNNEL_WAIT_MS) / 1000)}s, and a session on EAS cannot reach this machine's loopback — the dev server has to run with --tunnel`
        : 'the dev server stopped before the app was opened',
    };
  }
  Log.progress(
    `Opening the app on EAS Simulator session ${session.sessionId}, which is already up.`
  );
  try {
    // A development build's bare scheme only navigates the app it already loaded. Send the
    // launcher URL used for a new session so a reused session loads this Metro's current tunnel.
    // Expo Go's route URL already contains that host, so its existing open stays unchanged.
    const route = options.expoGo
      ? '/'
      : await resolveEasOpenUrlAsync(projectRoot, options, tunnelHost);
    if (!stillWanted()) {
      return { ...base, opened: false, reason: 'the dev server stopped before the app was opened' };
    }
    const result = await openRouteAsync(projectRoot, {
      route,
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

/** The one line `dev` says about an open on EAS that did not happen, with the door that still works. */
export function openAppOnEasFailureLine(platform: NativePlatform, reason: string): string {
  return `The app was not opened on an EAS Simulator session: ${reason}. The dev server is up; once a session is, "${PROGRAM_PREFIX} navigate / --eas --${platform}" opens the app on it.`;
}

/** The EAS session work of one dev-server step that opens the app. */
export interface EasRunLifecycle {
  /** The EAS platform the dev-server lock records for this run. */
  platform: NativePlatform;
  /** Opens the app alongside Metro. A failed open never stops Metro. */
  open(run: { devServerUrl: string; stillWanted: () => boolean; buildId: string | null }): void;
  /** Resolves when the open returns, bound or failed. Never resolves without an open. */
  finished: Promise<void>;
  /**
   * Waits for the open, so an in-flight session start cannot escape cleanup. Then stops and
   * releases a session this run started, unless the run keeps it.
   */
  finishAsync(): Promise<void>;
}

/**
 * The EAS session lifecycle of one dev-server step. A foreground `dev` stops the session it started
 * when Metro exits; a detached child keeps it for the worktree. The signal handlers stay installed
 * until {@link EasRunLifecycle.finishAsync} returns.
 */
// @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
export function easRunLifecycle(
  projectRoot: string,
  {
    platform,
    expoGo,
    fingerprintCache,
    keepSession,
    onSignal,
  }: {
    platform: NativePlatform;
    expoGo: boolean;
    fingerprintCache?: boolean;
    keepSession: boolean;
    onSignal: () => void;
  }
): EasRunLifecycle {
  let task: Promise<OpenAppOnEasReport | null> | undefined;
  let markFinished!: () => void;
  const finished = new Promise<void>((resolve) => (markFinished = resolve));
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return {
    platform,
    finished,
    open({ devServerUrl, stillWanted, buildId }) {
      task = openAppOnEasForRunAsync(projectRoot, {
        platform,
        expoGo,
        devServerUrl,
        buildId,
        fingerprintCache,
        stillWanted,
        keepSession,
      });
      void task.finally(markFinished);
    },
    async finishAsync() {
      try {
        if (!task) return;
        Log.progress('Finishing EAS session work before exiting.');
        const session = await task;
        if (keepSession || !session?.started || !session.sessionId) return;
        const release = await releaseStartedSessionAsync(projectRoot, session.sessionId, 'dev');
        if (release.outcome === 'stopped')
          Log.progress(`Stopped EAS Simulator session ${session.sessionId}, created by this run.`);
        else if (release.outcome === 'kept')
          Log.progress(`Kept EAS Simulator session ${session.sessionId}: ${release.reason}.`);
        else
          Log.warn(`Could not stop EAS Simulator session ${session.sessionId}: ${release.reason}.`);
      } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      }
    },
  };
}

/**
 * Open the app on an EAS Simulator session for a running dev server, and say what happened.
 *
 * @ref llp/0027-everything-on-eas.rfc.md §The open is a session
 * The same contract as the local open: never throws, never stops the server, and a session that
 * was started says so with the command that stops it — it bills until then.
 */
async function openAppOnEasForRunAsync(
  projectRoot: string,
  options: OpenAppOnEasOptions & { stillWanted: () => boolean }
): Promise<OpenAppOnEasReport | null> {
  const { platform, stillWanted } = options;
  try {
    const report = await openAppOnEasAsync(projectRoot, options);
    if (report.opened && stillWanted()) {
      Log.progress(
        `Opened the app on EAS Simulator session ${report.sessionId ?? '(id unknown)'}${
          report.started ? ', started by this run' : ', which was already up'
        }.${report.sessionUrl ? ` Watch it at ${report.sessionUrl}.` : ''} ${
          report.started && !options.keepSession
            ? `This run stops the session when the dev server exits. Use Ctrl-C or "${PROGRAM_PREFIX} dev:stop --eas".`
            : `It bills until "${PROGRAM_PREFIX} dev:stop --eas".`
        }`
      );
    } else if (stillWanted()) {
      Log.warn(
        report.refusal?.message ??
          openAppOnEasFailureLine(platform, report.reason ?? 'no reason was given')
      );
    }
    return report;
  } catch (error: unknown) {
    // `openAppOnEasAsync` promises not to throw; this guard is for the promise breaking.
    Log.warn(
      `The app was not opened on EAS: ${error instanceof Error ? firstLine(error.message) : String(error)}`
    );
  }
  return null;
}
