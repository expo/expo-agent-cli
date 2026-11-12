// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
// @ref llp/0010-agent-conventions.rfc.md §Exit codes
import { spawn } from 'child_process';
import fs from 'fs';
import { otherPlatformSessionError } from '../device/cloudErrors';
import {
  buildEndedError,
  detachFailureError,
  isOwnBundlerAnsweringAsync,
  lostDevServerError,
  needsOpenPlatformGrace,
  notReadyError,
  notStartedError,
  OPEN_PLATFORM_GRACE_MS,
  readChildVerdictSync,
  relayedDeviceError,
  resolveDetachFailure,
  waitFailureAsync,
  waitForChildVerdictAsync,
  watchOpenPlatformGraceAsync,
} from './detachHealth';
import { waitForDetachedStartupAsync } from './detachLockWait';
import { detachEas, reportDetached, WHOLE_LOG } from './detachReport';
import { otherPlatformSessionAsync } from './openAppEas';
import { reopenEasAsync } from './reopenEas';
import { devServerRunningStopAsync } from './runningDevServer';

import { devicesDisabled, hostBindsPlatform, localBackendOf } from '../deviceBinding';
import { SIMCTL_CALL_TIMEOUT_MS } from '../deviceBinding/ios';
import { readBindingSummaryAsync, type BindingSummary } from '../deviceBinding/summary';
import { readDevServerLockAsync, type DevServerLockInfo } from '../devLock';
import type { NativePlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import { defaultSmokePlatformAsync, statedSmokePlatform } from '../smoke/suggest';
import { requestsTunnel } from '../start/followUps';
import { CommandError } from '../utils/errors';
import { detachedEventLogEnv } from '../utils/eventLogEnv';
import { fetchAdvertisedUrlAsync, readDevServerLogSync } from './advertisedUrl';
import { childOpensPlatform, parseDetachedChildVerdict, VERDICT_LOG_LINES } from './childVerdict';
import {
  childStartsSessionSync,
  knownSessionIdSync,
  waitForEasSessionAsync,
} from './detachEasProgress';
import { CALLER_ARGV_ENV } from './deviceOption';
import { event } from './events';
import {
  detachedLogPath,
  openDetachedLogSync,
  readDetachedLogSync,
  type DetachedLogRead,
} from './logFile';
import { isProcessAlive } from './processLiveness';
import { recordLastDevRequest } from './lastRequest';
import { easOpenPlatform, type DevOptions } from './resolveOptions';
import { waitForDetachedReadyAsync } from './waitForDetachedReady';

/** The argv of the detached child, as a value a test can assert without spawning anything. */
export interface DetachSpawn {
  /** Executable to run: this process' own Node. */
  command: string;
  args: string[];
}

/**
 * The command line the detached child is started with.
 *
 * Three flags are stripped, and each for its own reason:
 *
 * - `--detach` — the child is the run, so passing it on would detach a detached run, forever.
 * - `--wait-ready` — the readiness wait is the parent's, and the child has nobody to report it to.
 * - `--json` — the parent owns stdout and prints the one object of this run. In the child it would
 *   also switch the plan's subprocess output to `capture`, which is exactly the output the log
 *   file exists to hold.
 *
 * @param binPath the `@expo/agent-cli` entry script, i.e. this process' own `process.argv[1]`.
 */
export function buildDetachSpawn(binPath: string, argv: string[]): DetachSpawn {
  const dropped = new Set(['--detach', '--wait-ready', '--json']);
  return {
    command: process.execPath,
    args: [binPath, 'dev', ...argv.filter((arg) => !dropped.has(arg))],
  };
}

export interface DevDetachOptions {
  /**
   * Whether to print the report at all.
   *
   * False for a caller that is *part of* another command's answer: `@expo/agent-cli smoke` starts a
   * dev server as one phase of eight, and under `--json` its stdout is one object — a second report
   * printed into it would make the whole run unparseable, which is the failure llp/0010 §The
   * `--json` error envelope records for `dev` itself. The `cli:dev_detach` event is emitted either
   * way, so a suppressed report is never a silent start.
   */
  print?: boolean;
  /**
   * On a dev server that is already running, open this caller's EAS session on it and record the
   * request.
   *
   * @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
   * `dev --eas` passes true. A local `dev` never reaches a running server here: it stops on the
   * lock first. `smoke` leaves it unset and opens its device in its own boot phase.
   */
  reopenEasSession?: boolean;
}

interface DetachContext {
  projectRoot: string;
  options: DevOptions;
  startedAt: number;
  print: boolean;
  reopenEasSession: boolean;
  smokePlatform: NativePlatform;
}

type DetachSource =
  | { kind: 'spawn' }
  | { kind: 'existing'; lock: DevServerLockInfo }
  | { kind: 'building'; lock: DevServerLockInfo };

type ChildExit = { code: number | null; signal: NodeJS.Signals | null };
type ChildState = { status: 'running' } | { status: 'exited'; exit: ChildExit };
type DetachedChild = ReturnType<typeof spawnDetachedChild>;
type Readiness =
  | { status: 'unchecked'; lock: DevServerLockInfo }
  | { status: 'ready'; lock: DevServerLockInfo; projectRootMatched: true | null };

/** Start or follow one detached run. Return 0 for a report; throw for a failed outcome. */
export async function devDetachAsync(
  projectRoot: string,
  options: DevOptions,
  { print = true, reopenEasSession = false }: DevDetachOptions = {}
): Promise<number> {
  const startedAt = Date.now();
  const smokePlatform =
    statedSmokePlatform(options.platform) ?? (await defaultSmokePlatformAsync(projectRoot));
  const context = { projectRoot, options, startedAt, smokePlatform, print, reopenEasSession };
  const source = await resolveDetachSourceAsync(context);
  switch (source.kind) {
    case 'building':
      return await reportBuildingRunAsync(context, source.lock, true);
    case 'existing':
      return await reuseRunningAsync(context, source.lock);
    case 'spawn':
      return await startDetachedAsync(context);
  }
}

async function resolveDetachSourceAsync(context: DetachContext): Promise<DetachSource> {
  const { projectRoot, options, startedAt } = context;
  let running = await readDevServerLockAsync(projectRoot);
  if (running?.phase === 'building') {
    const followed = running;
    const wait = await waitForDetachedStartupAsync(
      projectRoot,
      options,
      startedAt,
      () => !isProcessAlive(followed.pid)
    );
    if (wait.kind === 'building') return { kind: 'building', lock: wait.lock };
    if (wait.kind === 'build-ended' || wait.kind === 'unobserved') {
      const verdict = await waitForChildVerdictAsync(projectRoot);
      throw relayedDeviceError(verdict) ?? buildEndedError(followed, verdict?.exitCode ?? null);
    }
    running = wait.lock;
  }
  if (running?.phase === 'finishing') {
    throw await devServerRunningStopAsync(projectRoot, running, options.platform);
  }
  return running ? { kind: 'existing', lock: running } : { kind: 'spawn' };
}

async function reportBuildingRunAsync(
  context: DetachContext,
  lock: DevServerLockInfo,
  alreadyRunning: boolean
): Promise<number> {
  const { projectRoot, options, startedAt, print, smokePlatform } = context;
  return reportDetached(projectRoot, options, {
    lock,
    alreadyRunning,
    startedAt,
    print,
    smokePlatform,
    eas: detachEas(projectRoot, options),
    ready: null,
    projectRootMatched: null,
    tunnelUrl: null,
    device: await boundDeviceAsync(projectRoot, options),
  });
}

async function reuseRunningAsync(
  context: DetachContext,
  running: DevServerLockInfo
): Promise<number> {
  const { projectRoot, options, startedAt, print, smokePlatform } = context;
  const runningPid = running.pid;
  const hasExited = () => !isProcessAlive(runningPid);

  // Health first: no session is opened next to a server that is dying or not ready.
  if (!options.waitReady) await checkReuseFailureAsync(context, hasExited, running);
  const checked = options.waitReady
    ? await waitForDetachedReadyAsync(projectRoot, running, {
        timeoutMs: Math.max(0, options.detachTimeoutMs - (Date.now() - startedAt)),
        hasExited,
      })
    : null;
  if (checked?.lock.phase === 'finishing') {
    throw lostDevServerError(checked.lock, detachedLogPath(projectRoot));
  }
  if (checked && (!checked.result.ready || checked.result.projectRootMatched === false)) {
    await checkReuseFailureAsync(context, hasExited, checked.lock);
    throw notReadyError(
      checked.lock,
      detachedLogPath(projectRoot),
      checked.result,
      options.platform,
      detachEas(projectRoot, options)
    );
  }
  const lock = checked?.lock ?? running;
  // Reuse only reads the current tunnel; it does not wait for a new one to appear.
  const tunnelUrl = await currentTunnelUrlAsync(projectRoot, lock.url);
  // @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions — a child still starting
  // its session is followed: a reopen would start a second one, or exit 1 on a queued one.
  const easSessionId = await sessionForExistingRunAsync(context, lock, tunnelUrl, hasExited);
  const device = await boundDeviceAsync(projectRoot, options);
  const statusAnswering =
    checked?.result.ready === true ? await isOwnBundlerAnsweringAsync(projectRoot, lock.url) : null;
  // Read the verdict and PID after all probes: any can outlast the running server.
  await checkReuseFailureAsync(context, hasExited, lock, statusAnswering);
  if (context.reopenEasSession) recordLastDevRequest(projectRoot, options);
  return reportDetached(projectRoot, options, {
    lock,
    alreadyRunning: true,
    eas: easOpenPlatform(options) ? { sessionId: easSessionId } : null,
    ready: checked?.result.ready ?? null,
    projectRootMatched: checked?.result.projectRootMatched ?? null,
    startedAt,
    print,
    tunnelUrl,
    device,
    smokePlatform,
  });
}

async function checkReuseFailureAsync(
  context: DetachContext,
  hasExited: () => boolean,
  lock: DevServerLockInfo,
  statusAnswering: boolean | null = null
): Promise<void> {
  const { projectRoot, options } = context;
  const stopped = await waitFailureAsync(projectRoot, hasExited(), Date.parse(lock.startedAt));
  if (stopped || statusAnswering === false) {
    throw detachFailureError(stopped?.failure ?? 'not-answering', {
      projectRoot,
      lock,
      logFile: detachedLogPath(projectRoot),
      verdict: stopped?.verdict ?? null,
      childExit: null,
      platform: options.platform,
      eas: detachEas(projectRoot, options),
    });
  }
}

async function sessionForExistingRunAsync(
  context: DetachContext,
  lock: DevServerLockInfo,
  tunnelUrl: string | null,
  hasExited: () => boolean
): Promise<string | null> {
  const { projectRoot, options, reopenEasSession } = context;
  const sessionPlatform = reopenEasSession ? easOpenPlatform(options) : null;
  const followsSession =
    sessionPlatform != null && childStartsSessionSync(projectRoot, lock, sessionPlatform);
  return followsSession
    ? options.waitReady
      ? await waitForEasSessionAsync(projectRoot, {
          platform: sessionPlatform,
          lock,
          tunnelUrl,
          since: Date.parse(lock.startedAt),
          knownId: knownSessionIdSync(projectRoot, sessionPlatform),
          hasExited,
          callerArgv: options.callerArgv,
        })
      : null
    : reopenEasSession
      ? await reopenEasAsync(projectRoot, options, lock.url, tunnelUrl)
      : null;
}

function spawnDetachedChild(projectRoot: string, options: DevOptions) {
  const { logFile, fd } = openDetachedLogSync(projectRoot);
  const { command, args } = buildDetachSpawn(resolveBinPath(), options.detachArgv);

  event('detach_spawn', { logFile, argv: args });
  const child = spawn(command, args, {
    cwd: projectRoot,
    detached: true,
    // Both streams into the log. `ignore` on stdin, because a detached process has no terminal to
    // read one from, and an inherited stdin would keep this shell attached to it.
    stdio: ['ignore', fd, fd],
    // The parent command owns usage telemetry; this child only continues its work. The second
    // variable makes the child's failures name their code in the log, which this process reads back.
    env: {
      ...detachedEventLogEnv(process.env),
      __EXPO_AGENT_CLI_INTERNAL_INVOCATION: '1',
      __EXPO_AGENT_CLI_DETACHED: '1',
      [CALLER_ARGV_ENV]: JSON.stringify(options.callerArgv),
    },
  });
  fs.closeSync(fd);
  child.unref();

  let state: ChildState = { status: 'running' };
  const childGone = new AbortController();
  child.once('exit', (code, signal) => {
    state = { status: 'exited', exit: { code, signal } };
    childGone.abort();
  });
  child.once('error', () => {
    state = { status: 'exited', exit: { code: null, signal: null } };
    childGone.abort();
  });
  return {
    logFile,
    pid: child.pid ?? null,
    signal: childGone.signal,
    hasExited: () => state.status === 'exited',
    get exit(): ChildExit | null {
      return state.status === 'exited' ? state.exit : null;
    },
  };
}

async function startDetachedAsync(context: DetachContext): Promise<number> {
  const { projectRoot, options, startedAt, print, smokePlatform } = context;
  // @ref llp/0035-one-device-per-worktree.rfc.md §One session per worktree — the refusal is the
  // exit code. Reusing a running server delegates the same refusal to reopenEasAsync.
  const easPlatform = easOpenPlatform(options);
  const other = easPlatform ? await otherPlatformSessionAsync(projectRoot, easPlatform) : null;
  if (easPlatform && other)
    throw otherPlatformSessionError(other.platform, {
      wanted: easPlatform,
      sessionId: other.sessionId,
      devServerRunning: false,
    });
  // The session bound before the spawn, expired or not, is the one the child reuses and renews.
  const keptSessionId = easPlatform ? knownSessionIdSync(projectRoot, easPlatform) : null;

  const child = spawnDetachedChild(projectRoot, options);
  const { logFile, hasExited } = child;
  const wait = await waitForDetachedStartupAsync(projectRoot, options, startedAt, hasExited);
  if (wait.kind === 'building') return await reportBuildingRunAsync(context, wait.lock, false);
  // A run that ended in its build holds no lock any more, and its log says why.
  if (wait.kind === 'finishing') throw lostDevServerError(wait.lock, logFile);
  if (wait.kind !== 'serving') {
    // A device refusal in the child ends it before any lock, and reaches the caller unchanged.
    const verdict = child.exit
      ? await waitForChildVerdictAsync(projectRoot)
      : readChildVerdictSync(projectRoot);
    const relayed = relayedDeviceError(verdict);
    if (relayed) {
      throw relayed;
    }
    if (wait.kind === 'build-ended') {
      throw buildEndedError(wait.lock, child.exit?.code ?? verdict?.exitCode ?? null);
    }
    throw notStartedError(
      projectRoot,
      logFile,
      child.exit,
      child.pid,
      Date.now() - startedAt,
      options.platform
    );
  }

  let lock = wait.lock;
  const childPid = lock.pid;
  const childIsGone = () => hasExited() || !isProcessAlive(childPid);

  const readiness = await checkSpawnedReadinessAsync(context, lock, child, childIsGone);
  lock = readiness.lock;
  const ready = readiness.status === 'ready' ? true : null;
  const projectRootMatched = readiness.status === 'ready' ? readiness.projectRootMatched : null;

  const tunnelUrl = await waitForTunnelUrlAsync(projectRoot, options, childIsGone);
  const device = await boundDeviceAsync(projectRoot, options);

  const log = await checkSpawnedHealthAsync(context, lock, child, childIsGone, ready);

  // @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions — with `--eas`, ready is the
  // session binding as well as the bundler.
  let eas = detachEas(projectRoot, options);
  if (easPlatform && ready === true) {
    const sessionId = await waitForEasSessionAsync(projectRoot, {
      platform: easPlatform,
      lock,
      tunnelUrl,
      since: startedAt,
      knownId: keptSessionId,
      hasExited: childIsGone,
      callerArgv: options.callerArgv,
    });
    if (sessionId == null) {
      const stopped = await waitFailureAsync(projectRoot, true);
      throw detachFailureError(stopped?.failure ?? 'child-exited', {
        projectRoot,
        lock,
        logFile,
        verdict: stopped?.verdict ?? null,
        childExit: child.exit,
        platform: options.platform,
        eas,
      });
    }
    eas = { sessionId };
  }

  return reportDetached(projectRoot, options, {
    lock,
    alreadyRunning: false,
    eas,
    ready,
    projectRootMatched,
    startedAt,
    print,
    tunnelUrl,
    device,
    log,
    smokePlatform,
  });
}

async function checkSpawnedReadinessAsync(
  context: DetachContext,
  lock: DevServerLockInfo,
  child: DetachedChild,
  childIsGone: () => boolean
): Promise<Readiness> {
  const { projectRoot, options, startedAt } = context;
  const { logFile } = child;
  if (!options.waitReady) return { status: 'unchecked', lock };
  const checked = await waitForDetachedReadyAsync(projectRoot, lock, {
    timeoutMs: Math.max(0, options.detachTimeoutMs - (Date.now() - startedAt)),
    hasExited: childIsGone,
    // Abort readiness when the child exits, even before a PID probe notices.
    signal: child.signal,
  });
  lock = checked.lock;
  // @ref llp/0004-smart-start-and-project-state.rfc.md §Dev-server lock — Metro exited during
  // the wait, and the child still binds its session: there is no dev server to call not ready.
  if (lock.phase === 'finishing') throw lostDevServerError(lock, logFile);
  const { result } = checked;
  if (!result.ready || result.projectRootMatched === false) {
    // Prefer the child's failure to the readiness timeout.
    const stopped = await waitFailureAsync(projectRoot, childIsGone());
    if (stopped) {
      throw detachFailureError(stopped.failure, {
        projectRoot,
        lock,
        logFile,
        verdict: stopped.verdict,
        childExit: child.exit,
        platform: options.platform,
        eas: detachEas(projectRoot, options),
      });
    }
    throw notReadyError(lock, logFile, result, options.platform, detachEas(projectRoot, options));
  }
  return { status: 'ready', lock, projectRootMatched: result.projectRootMatched };
}

async function checkSpawnedHealthAsync(
  context: DetachContext,
  lock: DevServerLockInfo,
  child: DetachedChild,
  childIsGone: () => boolean,
  ready: boolean | null
): Promise<DetachedLogRead | null> {
  const { projectRoot, options, startedAt } = context;
  const { logFile } = child;
  // @ref llp/0021-honest-reports.rfc.md §The rules
  // The probe can outlast the child. Read its state and log only after that await, so a handoff
  // written while the probe was pending outranks the probe's generic "not answering" result.
  const statusAnswering =
    ready === true ? await isOwnBundlerAnsweringAsync(projectRoot, lock.url) : null;
  // One read of the whole log, for the phase, the verdict and the report's port move.
  const log = readDetachedLogSync(projectRoot, WHOLE_LOG);
  const opensPlatform = log != null && childOpensPlatform(log.lines);
  let verdict = log == null ? null : parseDetachedChildVerdict(log.lines.slice(-VERDICT_LOG_LINES));
  let failure = resolveDetachFailure({
    exited: childIsGone(),
    verdict,
    statusAnswering,
  });

  if (failure == null && needsOpenPlatformGrace({ ready, opensPlatform })) {
    const grace = await watchOpenPlatformGraceAsync(projectRoot, lock.url, {
      hasExited: childIsGone,
      budgetMs: Math.min(
        OPEN_PLATFORM_GRACE_MS,
        // Bounded by the budget the caller gave the whole run, never beyond it: a `--wait-ready`
        // that has already spent its timeout must not spend a second one here.
        Math.max(0, options.detachTimeoutMs - (Date.now() - startedAt))
      ),
      // Only a run that waited for the bundler may be failed on the bundler.
      watchStatus: ready === true,
    });
    failure = grace.failure;
    verdict = grace.verdict ?? verdict;
  }

  if (failure) {
    // Both the final probe and the grace window can observe an exit before the handoff is
    // readable. Give either path the same bounded wait, once, and prefer the child's own verdict.
    if (verdict?.scenario == null && childIsGone()) {
      verdict = await waitForChildVerdictAsync(projectRoot);
      failure = verdict?.scenario != null ? 'needs-human' : 'child-exited';
    }
    throw detachFailureError(failure, {
      projectRoot,
      lock,
      logFile,
      verdict,
      childExit: child.exit,
      platform: options.platform,
      eas: detachEas(projectRoot, options),
    });
  }

  return log;
}

/**
 * How long a `--tunnel` run waits for its dev server to say where the tunnel is.
 *
 * The tunnel is established after the bundler answers `/status`, so `--wait-ready` returning is not
 * the same as the tunnel being up — a scripted `dev --detach --tunnel --wait-ready` followed by
 * `navigate --print-url` used to land in that gap and get the address of *this machine* with no
 * note that a tunnel was on its way [observed — live, 2026-08-25]. Bounded, because a tunnel that
 * does not come up must not hold a dev server that did: the run reports `tunnelUrl: null` and the
 * log says why.
 */
export const TUNNEL_URL_WAIT_MS = 20_000;

/** How often the log is re-read while that wait runs. */
const TUNNEL_URL_POLL_MS = 250;

/** The tunnel this project's dev server currently advertises, or null. */
function currentTunnelUrlSync(projectRoot: string): string | null {
  const captured = readDevServerLogSync(projectRoot);
  return captured?.advertised?.hostType === 'tunnel' ? captured.advertised.url : null;
}

/**
 * The tunnel host, from the log or from the dev server itself.
 *
 * The log is asked first because it costs nothing, and because `Waiting on <url>` is the dev
 * server's own announcement. It is not always there: a detached `--tunnel` run's log held no host
 * at all while the tunnel was up [observed — live run S3, 2026-08-26]. The manifest of the dev
 * server this run already has a lock for carries the same address, one request away.
 */
async function currentTunnelUrlAsync(
  projectRoot: string,
  devServerUrl: string
): Promise<string | null> {
  const fromLog = currentTunnelUrlSync(projectRoot);
  if (fromLog != null) {
    return fromLog;
  }
  const advertised = await fetchAdvertisedUrlAsync(devServerUrl);
  return advertised?.hostType === 'tunnel' ? advertised.url : null;
}

/**
 * Wait for the tunnel URL, but only for a run that asked for one.
 *
 * A run with no `--tunnel` has nothing to wait for and pays nothing: the whole cost of this is
 * paid by the runs it is for.
 *
 * `hasExited` ends the wait early, because a tunnel cannot arrive from a process that is gone —
 * and this is the wait the child died inside of while the parent went on to report `ready: true`
 * (F61, S4).
 */
async function waitForTunnelUrlAsync(
  projectRoot: string,
  options: DevOptions,
  hasExited: () => boolean = () => false
): Promise<string | null> {
  if (!requestsTunnel(options.expoArgs)) {
    return null;
  }
  const lock = await readDevServerLockAsync(projectRoot);
  const deadline = Date.now() + TUNNEL_URL_WAIT_MS;
  for (;;) {
    const url =
      lock == null
        ? currentTunnelUrlSync(projectRoot)
        : await currentTunnelUrlAsync(projectRoot, lock.url);
    if (url != null || hasExited() || Date.now() >= deadline) {
      return url;
    }
    await new Promise((resolve) => setTimeout(resolve, TUNNEL_URL_POLL_MS));
  }
}

/** Read from the binding file, under the same conditions `dev` binds under. */
async function boundDeviceAsync(
  projectRoot: string,
  options: DevOptions
): Promise<BindingSummary | null> {
  const platform = options.platform;
  if (
    (platform !== 'ios' && platform !== 'android') ||
    options.deviceBackend === 'eas' ||
    devicesDisabled() ||
    !hostBindsPlatform(platform)
  ) {
    return null;
  }
  const backend = localBackendOf(platform);
  return (
    (await readBindingSummaryAsync(projectRoot, SIMCTL_CALL_TIMEOUT_MS)).find(
      (entry) => entry.backend === backend
    ) ?? null
  );
}

/**
 * This CLI's own entry script, for the child to run.
 *
 * `process.argv[1]` is the `bin/cli.js` that the caller invoked, whatever it is installed as,
 * which is the one thing guaranteed to start the same CLI the parent is.
 */
function resolveBinPath(): string {
  const bin = process.argv[1];
  if (!bin) {
    throw new CommandError(
      'DEV_DETACH_FAILED',
      `Could not work out which script to start in the background, because this process was started without one (process.argv[1] is empty). Run "${PROGRAM_PREFIX} dev --ios|--android|--web" instead, which needs no second process.`
    );
  }
  return bin;
}
