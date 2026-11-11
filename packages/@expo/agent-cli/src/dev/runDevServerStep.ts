// @ref llp/0026-dev-owns-the-open.rfc.md
// @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
import type { AcquireResult } from '../deviceBinding';
import type { RunLock } from '../devLock';
import { readLastLoggedDevServerPort, readPortArg } from '../devLock/port';
import { EXIT_OUTCOME_FAILED } from '../exitCodes';
import { Log } from '../log';
import { event as planEvent } from '../plan/events';
import { rerunDevCommand } from '../plan/rerun';
import type { NativePlatform, PlanPlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import type { PlanStep, StartPlan } from '../project/types';
import { runDevServerAsync, type DevServerRun } from '../start/startAsync';
import { CommandError } from '../utils/errors';
import { isInteractive } from '../utils/interactive';
import type { SubprocessOutput } from '../utils/subprocess';
import { portDemandedError, warnPortMove } from './devServerPort';
import { event as devEvent } from './events';
import { buildsBeforeServing, withPortArg } from './forwardedArgs';
import { easRunLifecycle } from './openAppEas';
import {
  defaultMetroPort,
  detectPortCollision,
  findFreePortAsync,
  type PortCollision,
} from './portCollision';
import { easOpenPlatform, type DevOptions } from './resolveOptions';
import type { RunSteps } from './runSteps';

type RunScope = { lock: RunLock; steps: RunSteps };

interface DevServerAttempt {
  args: string[];
  spawnedAt: number;
  result: DevServerRun;
}

/** A runner for one plan. Reuse it across serving attempts to keep one app-open attempt. */
export class DevServerStepRunner {
  /** The EAS device platform to publish on the run lock, when EAS opening is enabled. */
  readonly easPlatform: NativePlatform | null;
  private readonly openPlatform: NativePlatform | null;
  private openAttempted = false;

  constructor(
    private readonly projectRoot: string,
    private readonly plan: StartPlan,
    private readonly options: DevOptions,
    private readonly acquired: AcquireResult | null,
    private readonly output: SubprocessOutput
  ) {
    this.openPlatform = openPlatformFor(options);
    this.easPlatform = this.openPlatform ? easOpenPlatform(options) : null;
  }

  /** Run one serving step and return the arguments used by its final attempt. */
  async runAsync(
    step: PlanStep,
    args: string[],
    easBuildId: string | null,
    scope: RunScope
  ): Promise<{ args: string[]; result: DevServerRun }> {
    const runAttempt = (stepArgs: string[]) =>
      this.runAttemptAsync(step, stepArgs, easBuildId, scope);
    const first = await runAttempt(args);
    // @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol
    // `expo run:*` can exit 0 after skipping its dev server.
    const collision = portCollisionIn(this.projectRoot, first);
    if (!collision) {
      return { args: first.args, result: first.result };
    }

    const { options } = this;
    if (options.port != null) {
      throw await portDemandedError(options.port, options.platform);
    }
    const askedPort = readPortArg(args) ?? defaultMetroPort();
    scope.steps.assertNotInterrupted();
    // @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
    // Once opening starts, the run can release its lock when the open and server both end.
    const retry = this.openAttempted
      ? null
      : await retryOnFreePortAsync(collision, args, this.plan.devServerPort, runAttempt);
    const last = retry ?? first;
    if (portCollisionIn(this.projectRoot, last) != null) {
      planEvent('start_plan_step_exit', { id: step.id, code: last.result.exitCode });
      throw await portTakenAfterRetryError({
        step,
        args: last.args,
        askedPort,
        movedTo: retry ? readPortArg(retry.args) : null,
        exitCode: last.result.exitCode,
        callerArgv: options.callerArgv,
        platform: options.platform,
      });
    }
    return { args: last.args, result: last.result };
  }

  private async runAttemptAsync(
    step: PlanStep,
    args: string[],
    easBuildId: string | null,
    { lock, steps }: RunScope
  ): Promise<DevServerAttempt> {
    const { projectRoot, plan, options, acquired, output } = this;
    // `expo run:*` installs and launches the app itself.
    const openPlatform = step.argv[1] === 'start' ? this.openPlatform : null;
    const spawnedAt = Date.now();
    // Session cleanup stays inside the active step so interruption waits for it.
    const result = await steps.stepAsync(async (signal) => {
      let attemptActive = true;
      const stillWanted = () => attemptActive && !steps.interrupted;
      const easPlatform = openPlatform ? this.easPlatform : null;
      const eas = easPlatform
        ? easRunLifecycle(projectRoot, {
            platform: easPlatform,
            expoGo: plan.target === 'expo-go',
            fingerprintCache: options.fingerprintCache,
            keepSession: options.detachedChild,
          })
        : null;
      return await runDevServerAsync(projectRoot, args, {
        agentSkills: options.agentSkills,
        output,
        signal,
        lock,
        phase: buildsBeforeServing(step.argv[1]) ? 'building' : 'serving',
        // @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
        easPlatform: eas?.platform ?? null,
        onDevServer: openPlatform
          ? ({ url }) => {
              if (this.openAttempted) return;
              this.openAttempted = true;
              if (eas) {
                lock.apply({ type: 'eas-open-started' });
                eas.open({ devServerUrl: url, stillWanted, buildId: easBuildId });
                void eas.finished.then(() => lock.apply({ type: 'eas-open-returned' }));
              } else {
                void openAppForRunAsync(
                  projectRoot,
                  plan,
                  openPlatform,
                  url,
                  stillWanted,
                  acquired
                );
              }
            }
          : undefined,
      }).finally(async () => {
        attemptActive = false;
        await eas?.finishAsync();
      });
    });
    return { args, spawnedAt, result };
  }
}

/**
 * The collision a dev-server step's output reports, or null.
 *
 * A dev server that reported or logged where it listens bound its port, so nothing in its output
 * is a bind collision. The port watch follows the step for as long as it runs, so a report after a
 * `run:*` build counts; `start.log` is what `@expo/cli` 57 and older write instead.
 *
 * A collision that names another port is not this step's: a `run:*` step's output carries Gradle
 * and Xcode output too, and an `EADDRINUSE` there is some other listener. A collision that names no
 * port (`Use port N instead?` alone) still counts.
 *
 * @param attempt The arguments, output, and start time of the same spawn.
 */
function portCollisionIn(
  projectRoot: string,
  { args, result, spawnedAt }: DevServerAttempt
): PortCollision | null {
  if (
    result.port?.source === 'reported' ||
    readLastLoggedDevServerPort(projectRoot, { since: spawnedAt }) != null
  ) {
    return null;
  }
  const collision = detectPortCollision(`${result.stderr}\n${result.stdout}`);
  const stepPort = readPortArg(args) ?? defaultMetroPort();
  if (collision?.requestedPort != null && collision.requestedPort !== stepPort) {
    return null;
  }
  return collision;
}

async function retryOnFreePortAsync(
  collision: PortCollision,
  args: string[],
  planned: StartPlan['devServerPort'],
  runAttempt: (stepArgs: string[]) => Promise<DevServerAttempt>
): Promise<DevServerAttempt | null> {
  const asked = planned?.port ?? collision.requestedPort ?? defaultMetroPort();
  const free = await findFreePortAsync(collision.offeredPort ?? asked + 1);
  const busy = planned?.port ?? collision.requestedPort;

  devEvent('start_plan_port_retry', {
    busyPort: busy,
    offeredPort: collision.offeredPort,
    port: free,
  });

  if (free == null) {
    return null;
  }

  warnPortMove(
    { busy, to: free, when: 'retry' },
    planned?.movedFrom ?? planned?.port ?? collision.requestedPort
  );
  return await runAttempt(withPortArg(args, free));
}

// @ref llp/0010-agent-conventions.rfc.md §Exit codes
async function portTakenAfterRetryError(stop: {
  step: PlanStep;
  args: string[];
  askedPort: number;
  movedTo: number | null;
  exitCode: number;
  callerArgv: string[];
  platform: PlanPlatform;
}): Promise<CommandError> {
  const { askedPort, movedTo } = stop;
  const { findPortListenerAsync } = require('./portListener') as typeof import('./portListener');
  const { isExpoDevServerAsync, looksLikeDevServerProcess } =
    require('./stopAsync') as typeof import('./stopAsync');
  const taken = movedTo ?? askedPort;
  const [listener, free, answersAsDevServer] = await Promise.all([
    findPortListenerAsync(taken),
    findFreePortAsync(taken + 1),
    isExpoDevServerAsync(taken),
  ]);
  const holder = listener
    ? `pid ${listener.pid}${listener.command ? ` (${listener.command})` : ''}`
    : 'a process this machine would not name';
  const invocation = `npx ${stop.step.argv[0]} ${stop.args.join(' ')}`;
  const why =
    movedTo != null
      ? `Why: the step asked for port ${askedPort}, which was taken, and the one retry moved it to port ${movedTo}, which ${holder} bound before the dev server did.`
      : `Why: ${holder} holds port ${askedPort}, and no free port was found to retry on.`;
  const onFreePort =
    free == null ? null : rerunDevCommand(stop.platform, withPortArg(stop.callerArgv, free));
  const forceStop =
    answersAsDevServer && listener != null && looksLikeDevServerProcess(listener)
      ? `${PROGRAM_PREFIX} dev:stop --port ${taken} --force`
      : null;
  const how = onFreePort
    ? `How: start on a free port with "${onFreePort}".`
    : forceStop
      ? `How: stop the dev server on port ${taken} with "${forceStop}", which stops it only when it answers as an Expo dev server, then run this command again.`
      : `How: stop ${holder} on port ${taken} yourself, then run this command again.`;
  const error = new CommandError(
    'PORT_TAKEN_AFTER_RETRY',
    [
      `No dev server was started: "${invocation}" stopped on a busy port and exited ${stop.exitCode}.`,
      why,
      how,
    ].join('\n')
  );
  const suggested = onFreePort ?? forceStop;
  if (suggested) {
    error.suggestedCommand = suggested;
  }
  error.exitCode = EXIT_OUTCOME_FAILED;
  return error;
}

// @ref llp/0026-dev-owns-the-open.rfc.md §The stub tier and devices
function openPlatformFor(options: DevOptions): NativePlatform | null {
  return options.mode === 'run' &&
    options.open &&
    (options.platform === 'ios' || options.platform === 'android') &&
    (options.deviceBackend === 'eas' || process.env.AGENT_CLI_NO_DEVICE !== '1')
    ? options.platform
    : null;
}

async function openAppForRunAsync(
  projectRoot: string,
  plan: StartPlan,
  platform: NativePlatform,
  devServerUrl: string,
  stillWanted: () => boolean,
  acquired: AcquireResult | null
): Promise<void> {
  const { openAppOnDeviceAsync, openAppFailureLine } =
    require('./openApp') as typeof import('./openApp');
  try {
    const report = await openAppOnDeviceAsync(projectRoot, {
      platform,
      expoGo: plan.target === 'expo-go',
      devServerUrl,
      stillWanted,
      interactive: isInteractive(),
      device: acquired?.device ?? null,
      justBooted: acquired?.justBooted ?? false,
    });
    if (report.opened) {
      Log.progress(
        `Opened the app on the ${platform === 'ios' ? 'iOS simulator' : 'Android device'}${
          report.booted ? ' it booted' : ''
        }.`
      );
    } else if (stillWanted()) {
      Log.warn(openAppFailureLine(platform, report.reason ?? 'no reason was given'));
    }
  } catch (error: unknown) {
    Log.warn(
      `The app was not opened: ${error instanceof Error ? error.message.split('\n', 1)[0] : String(error)}`
    );
  }
}
