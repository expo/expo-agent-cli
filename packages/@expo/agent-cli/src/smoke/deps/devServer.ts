import chalk from 'chalk';
import path from 'path';

import { devDetachAsync } from '../../dev/detachAsync';
import { resolveDevOptions } from '../../dev/resolveOptions';
import { resolveDevStopOptions } from '../../dev/resolveStopOptions';
import { devStopAsync, type DevStopResultJson } from '../../dev/stopAsync';
import { inspectBindingAsync } from '../../deviceBinding';
import { releaseStartedSessionAsync } from '../../deviceBinding/cloudRelease';
import { event } from '../../events';
import * as Log from '../../log';
import { PROGRAM_PREFIX } from '../../programName';
import { checkEntryBundleAsync } from '../../runtime/bundleCheck';
import { discoverDevServerAsync } from '../../runtime/discoverDevServer';
import { waitForBundlerReadyAsync } from '../../runtime/waitReady';
import { EAS_SIMULATOR_PROFILE, localRequirement } from '../../toolchain/runsOn';
import { firstLine } from '../../utils/text';
import {
  BUILD_DEV_SERVER_TIMEOUT_MS,
  START_DEV_SERVER_TIMEOUT_MS,
  type SmokeDeps,
} from '../phases';
import type { SmokeOptions } from '../resolveOptions';
import { smokeCommand } from '../suggest';
import { deviceBoundByStart, START_DEV_SERVER_ARGV, startPortArgs } from './startArgs';
import { smokeSessionResult, whatAndHow } from './reasons';
import type { SmokeDepsShared } from './shared';

/** How long discovery may spend on each candidate port. Short: a dev server that is up answers. */
const DISCOVERY_TIMEOUT_MS = 800;

export function discoverDevServer(
  s: SmokeDepsShared,
  projectRoot: string,
  options: SmokeOptions,
  explicitUrl: string | null
): ReturnType<SmokeDeps['discoverDevServer']> {
  return discoverDevServerAsync(explicitUrl ?? undefined, {
    timeoutMs: DISCOVERY_TIMEOUT_MS,
    projectRoot,
  });
}

// The detach path of `@expo/agent-cli dev`, with the readiness wait on: a foreground start would never
// return, and this run has seven more phases to perform (llp/0004 §Daemonization).
// The argv is `START_DEV_SERVER_ARGV`, whose documentation says why it carries `--no-open`.
export async function startDevServer(
  s: SmokeDepsShared,
  projectRoot: string,
  options: SmokeOptions
): ReturnType<SmokeDeps['startDevServer']> {
  // @ref llp/0005-runtime-loop-tools.rfc.md §It builds what the app needs, and says so first
  //
  // This used to refuse. The detached child runs whatever plan it makes, and for a project
  // whose development build is missing or stale that plan is a compiler — so the gate named
  // `dev` and stopped, which is a correct instruction and a dead end for a loop that cannot
  // leave itself to take it.
  //
  // It now runs the plan, and **says so before it starts**. A command that silently blocks for
  // twenty minutes is indistinguishable from one that has hung, so the one thing the caller
  // needs is the sentence that tells them which it is. On stderr, because stdout carries one
  // JSON object and nothing else (llp/0006 §Output contract), and as an event too so a reader
  // of the stream sees it without parsing English.
  s.keepBoundDevice = true;
  const target = await s.targetAsync();
  // @ref llp/0015-backend-selection-and-config.rfc.md §The selection — named, not taken. A
  // build that would land on EAS because this machine cannot build, and that nobody asked for,
  // uses EAS credits: the gate says so and stops, before anything is spawned. `--eas` takes it.
  if (target.buildLocation?.runsOn === 'eas' && target.buildLocation.selection?.implicit) {
    return {
      ok: false,
      devServerUrl: null,
      built: false,
      reason: `this machine cannot build for ${options.platform} (${target.buildLocation.selection.because}) and the build would land on EAS, which uses EAS credits — so it is not started without being asked. Run "${smokeCommand(options.platform)} --eas" to build there and gate the app on an EAS Simulator session, or install ${localRequirement(options.platform)} and run this again`,
    };
  }
  if (target.buildLocation != null) {
    // `runsOn` is where it compiles: this machine, or EAS. Worth saying, because the two have
    // very different costs and the caller may not have chosen either on purpose.
    const where = target.buildLocation.runsOn;
    event('smoke_building', { platform: options.platform, where });
    Log.progress(
      chalk.dim(
        [
          `Building the ${options.platform} development build first, ${where === 'eas' ? 'on EAS' : 'on this machine'}.`,
          `This project has none for its current fingerprint, and a native build takes some minutes — nothing is stuck.`,
        ].join(' ')
      )
    );
  }
  const built = target.buildLocation != null;
  if (built) {
    // @ref ./shared §forgetTarget — the build below rewrites the app config, so the answer
    // read above is about the project as it was before it.
    s.forgetTarget();
  }
  const before = s.ownBinding();
  const state =
    before &&
    (await inspectBindingAsync(projectRoot, options.platform, before.device.backend)).state;
  const beforeUp = state === 'up' || state === 'unknown';
  s.keepBoundDevice = beforeUp;
  const argv = [
    `--${options.platform}`,
    ...START_DEV_SERVER_ARGV,
    // @ref llp/0027-everything-on-eas.rfc.md §smoke — the device is on EAS, so the dev server
    // is tunnelled and a build the plan needs is the simulator profile on EAS Build. `--no-open`
    // above keeps the session start this run's own (`ensureEasSession`).
    ...(options.cloud === 'required' ? ['--eas'] : []),
    ...startPortArgs(options.devServerUrl),
  ];
  try {
    // `print: false`: the detached start is one phase of this run, and this run prints one
    // report. Its `cli:dev_detach` event is still emitted, so nothing about it is hidden.
    //
    // The budget is this phase's own (@ref ../phases §START_DEV_SERVER_TIMEOUT_MS) rather than
    // `--timeout`, which bounds the phases that read the app and is not charged for the start.
    await devDetachAsync(
      projectRoot,
      {
        ...resolveDevOptions(argv),
        // A plan that compiles needs a budget the shape of a compile
        // (@ref ../phases §BUILD_DEV_SERVER_TIMEOUT_MS).
        detachTimeoutMs:
          target.buildLocation != null ? BUILD_DEV_SERVER_TIMEOUT_MS : START_DEV_SERVER_TIMEOUT_MS,
      },
      { print: false }
    );
  } catch (error: unknown) {
    return {
      ok: false,
      devServerUrl: null,
      built,
      reason: `a dev server could not be started (${error instanceof Error ? firstLine(error.message) : String(error)})`,
    };
  }
  // Discovery finds it through the lock the detached run publishes, which is the same way
  // every other command finds a dev server this CLI started.
  const found = await discoverDevServerAsync(undefined, {
    timeoutMs: DISCOVERY_TIMEOUT_MS,
    projectRoot,
  });
  return {
    ok: found.reachable,
    devServerUrl: found.devServerUrl,
    built,
    bound: deviceBoundByStart(before, s.ownBinding(), beforeUp),
    reason: found.reachable
      ? null
      : `a dev server was started and nothing answered at ${found.devServerUrl} afterwards (${found.reason ?? 'no answer'})`,
  };
}

// `dev:stop`'s own act, through `dev:stop`'s own function, with its report suppressed: this
// run prints one report and the stop is a line in it. Everything that makes the stop safe is
// that command's — it signals the pid the project's lock names and refuses a dev server no
// lock answers for, so a cleanup can never take down something this run did not start.
export async function stopDevServer(
  s: SmokeDepsShared,
  projectRoot: string,
  options: SmokeOptions
): ReturnType<SmokeDeps['stopDevServer']> {
  const captured: { report: DevStopResultJson | null } = { report: null };
  const release = options.cloud !== 'required' && !s.keepBoundDevice;
  await devStopAsync(
    projectRoot,
    {
      ...resolveDevStopOptions(['--no-followups']),
      release,
      platform: options.platform,
    },
    {
      print: false,
      onReport: (stopped) => {
        captured.report = stopped;
      },
    }
  );
  const stopped = captured.report;
  const serverStopped = stopped != null && (stopped.stopped || stopped.reason === 'not-running');
  return {
    ok: serverStopped,
    target: stopped?.url ?? (stopped?.port == null ? null : `port ${stopped.port}`),
    reason: serverStopped ? null : (stopped?.detail ?? 'the dev server did not stop'),
    // A refused release leaves each kept row without a reason; dev:stop's refusal is that reason.
    devices: release
      ? stopped?.devices?.map((device) =>
          device.released || device.reason != null || stopped.deviceError == null
            ? device
            : { ...device, reason: whatAndHow(stopped.deviceError) }
        )
      : undefined,
  };
}

// @ref llp/0027-everything-on-eas.rfc.md §smoke
// The EAS device's boot-and-install: the session in progress on this platform, or one started
// with the app named. A development build needs a finished simulator build of this fingerprint
// on EAS; the gate never compiles one — `dev --eas` does, and is named.
export async function ensureEasSession(
  s: SmokeDepsShared,
  projectRoot: string,
  options: SmokeOptions,
  devServerUrl: string
): ReturnType<SmokeDeps['ensureEasSession']> {
  s.setDevice(null);
  const { ensureEasSessionAsync } =
    require('../../dev/easSession') as typeof import('../../dev/easSession');
  const target = await s.targetAsync();
  const result = await ensureEasSessionAsync(projectRoot, {
    platform: options.platform,
    expoGo: target.installWithKind === 'expo-go',
    devServerUrl,
    // A new session looks up the build of this fingerprint, and is never started without one.
    buildId: null,
    sessionName: `${path.basename(projectRoot)} — agent-cli smoke`,
    keepSession: false,
    noBuildReason: `no EAS Simulator session is up, and EAS has no finished "${EAS_SIMULATOR_PROFILE}" build of this project's ${options.platform} fingerprint to start one with — "${PROGRAM_PREFIX} dev --${options.platform} --eas" builds it and starts the session; this gate compiles nothing`,
  });
  if (result.ok && result.sessionId) {
    s.setDevice({ backend: 'cloud', platform: options.platform, deviceId: result.sessionId });
  }
  return smokeSessionResult(result);
}

export async function stopEasSession(
  s: SmokeDepsShared,
  projectRoot: string,
  options: SmokeOptions,
  sessionId: string
): ReturnType<SmokeDeps['stopEasSession']> {
  const release = await releaseStartedSessionAsync(projectRoot, sessionId, 'smoke');
  return release.outcome === 'stopped'
    ? { ok: true, target: sessionId, reason: null }
    : { ok: false, target: sessionId, reason: release.reason };
}

export function waitForBundlerReady(
  s: SmokeDepsShared,
  projectRoot: string,
  options: SmokeOptions,
  devServerUrl: string,
  timeoutMs: number
): ReturnType<SmokeDeps['waitForBundlerReady']> {
  return waitForBundlerReadyAsync(devServerUrl, { timeoutMs, projectRoot });
}

export function checkEntryBundle(
  s: SmokeDepsShared,
  projectRoot: string,
  options: SmokeOptions,
  devServerUrl: string,
  timeoutMs: number
): ReturnType<SmokeDeps['checkEntryBundle']> {
  return checkEntryBundleAsync(devServerUrl, {
    platform: options.platform,
    timeoutMs,
    projectRoot,
  });
}

export function buildDevServerDeps(
  s: SmokeDepsShared,
  projectRoot: string,
  options: SmokeOptions
): Pick<
  SmokeDeps,
  | 'discoverDevServer'
  | 'startDevServer'
  | 'stopDevServer'
  | 'ensureEasSession'
  | 'stopEasSession'
  | 'waitForBundlerReady'
  | 'checkEntryBundle'
> {
  return {
    discoverDevServer: (...args) => discoverDevServer(s, projectRoot, options, ...args),
    startDevServer: (...args) => startDevServer(s, projectRoot, options, ...args),
    stopDevServer: (...args) => stopDevServer(s, projectRoot, options, ...args),
    ensureEasSession: (...args) => ensureEasSession(s, projectRoot, options, ...args),
    stopEasSession: (...args) => stopEasSession(s, projectRoot, options, ...args),
    waitForBundlerReady: (...args) => waitForBundlerReady(s, projectRoot, options, ...args),
    checkEntryBundle: (...args) => checkEntryBundle(s, projectRoot, options, ...args),
  };
}
