import { lockAddressFor, probeDevServerLockAsync } from '../devLock';
import {
  inspectDetachedStopAsync,
  requestOwnedStopAsync,
  retireDetachedAttempt,
  readDetachedAttemptAsync,
  type DetachedAttemptRef,
  stopUncertainError,
} from './detachedOwner';
import { captureCloudSessionsAsync, stopCloudSessionsAsync } from './stopCloudSessions';
import { captureDetachedDevices, stopDevicesAsync } from './stopDevices';
import { readDevServerLockAsync, type DevServerLockInfo } from '../devLock';
import { env } from '../utils/env';
import { EAS_SESSION_START_TIMEOUT_MS, EAS_TUNNEL_WAIT_MS } from './easSession';
import type { StartupSession } from '../utils/startupTasks';
import type { DevStopOptions } from './resolveStopOptions';
import { isProcessAlive } from './processLiveness';
import { isPortFreeAsync, POLL_INTERVAL_MS } from './processStop';
import type { DevStopResultJson } from './stopAsync';

export async function observeOwnedStopAsync(
  ref: DetachedAttemptRef,
  control: Awaited<ReturnType<typeof requestOwnedStopAsync>>,
  lock: DevServerLockInfo | null,
  options: DevStopOptions,
  startedAt: number
): Promise<{ report: DevStopResultJson; finishing: boolean; pending: boolean }> {
  let deadline = startedAt + options.timeoutMs;
  let receipt: StartupSession[] | null | undefined;
  void control.completion.then((value) => {
    receipt = value;
  });
  let finishing = false;
  let stopped = false;
  for (;;) {
    const probe = await probeDevServerLockAsync(lockAddressFor(ref.projectRoot).address);
    const current = probe.info;
    const matches = current?.detachedAttemptId === ref.id && current.pid === ref.pid;
    if (matches && current.phase === 'finishing' && !finishing) {
      finishing = true;
      lock = current;
      if (!options.eas) {
        stopped = true;
        break;
      }
      deadline = Math.min(
        Date.parse(current.startedAt) + EAS_TUNNEL_WAIT_MS + EAS_SESSION_START_TIMEOUT_MS,
        Date.now() + env.AGENT_CLI_EAS_SESSION_WAIT_MS
      );
      control.extendCompletionDeadline(deadline);
    }
    const lockGone =
      !probe.connected || (current != null && current.detachedAttemptId != null && !matches);
    if (receipt != null && !isProcessAlive(ref.pid) && lockGone) {
      stopped = true;
      finishing = false;
      break;
    }
    if (receipt === null || Date.now() + POLL_INTERVAL_MS >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const port = lock?.port ?? ref.port;
  return {
    finishing,
    pending: !stopped,
    report: {
      stopped: stopped || finishing,
      pid: ref.pid,
      port,
      url: lock?.url ?? null,
      lockHeld: lock != null,
      signal: null,
      forced: false,
      forceRefusedBy: null,
      processStillRunning: isProcessAlive(ref.pid),
      easPlatform: lock?.easPlatform ?? null,
      portStillAnswering: port == null ? null : !(await isPortFreeAsync(port)),
      reason: stopped || finishing ? null : 'still-running',
      detail: stopped
        ? control.action === 'cancel-startup'
          ? 'Startup stopped. An already submitted EAS build continues on EAS; "eas build:cancel" ends it.'
          : null
        : 'The captured owner did not prove completed cleanup and exit within the stop timeout. Its ownership was kept.',
      untracked: false,
      waitedMs: Date.now() - startedAt,
      followups: [],
    },
  };
}

export async function prepareDetachedStopAsync(
  root: string,
  options: DevStopOptions,
  expected?: DetachedAttemptRef
) {
  const inspected = await inspectDetachedStopAsync(root, options, expected);
  const ref = inspected.attempt?.ref;
  const captured =
    inspected.authorized && ref && options.eas ? await captureCloudSessionsAsync(root) : undefined;
  const releaseCaptured = captureDetachedDevices(root, options, expected ?? ref ?? undefined);
  const control = inspected.authorized && ref ? await requestOwnedStopAsync(ref, options) : null;
  let lock = inspected.lock;
  try {
    if (control?.action === 'stop-run') {
      lock = await readDevServerLockAsync(root);
      if (
        lock &&
        (lock.detachedAttemptId !== ref!.id ||
          lock.pid !== ref!.pid ||
          (options.port != null && options.port !== lock.port))
      )
        throw stopUncertainError();
    }
  } catch (error) {
    await control?.releaseAsync();
    throw error;
  }
  return {
    ...inspected,
    ref,
    lock,
    control,
    async cleanupAsync(report: DevStopResultJson, pending: boolean) {
      const sessions =
        control && options.eas && !pending && report.stopped ? await control.completion : null;
      if (control && options.eas && (!sessions || pending || !report.stopped)) {
        pending = true;
        report.session = {
          id: null,
          stopped: false,
          platform: lock?.easPlatform ?? null,
          reason:
            'The captured owner did not confirm completed session work and exit. Ownership and sessions were kept.',
        };
      }
      if (control && options.eas && !pending) report.processStillRunning = false;
      control?.dispose();
      const cloud =
        options.eas && !pending && !expected && (!control || report.stopped)
          ? await stopCloudSessionsAsync(root, captured, sessions ?? [])
          : null;
      if (cloud) report.session = cloud.session;
      const devices = releaseCaptured
        ? await releaseCaptured(report.stopped || report.reason === 'not-running')
        : await stopDevicesAsync(root, options, report, cloud);
      if (releaseCaptured && cloud) {
        devices.devices = devices.devices.filter(
          (device) =>
            device.id !== cloud.session.id &&
            !cloud.devices.some((released) => released.id === device.id)
        );
        devices.devices.push(...cloud.devices);
        devices.deviceError ??= cloud.deviceError;
      }
      Object.assign(report, devices);
      if (
        control &&
        options.eas &&
        !pending &&
        report.stopped &&
        !report.deviceError &&
        !retireDetachedAttempt(ref!) &&
        (await readDetachedAttemptAsync(root))
      )
        report.deviceError =
          'Captured startup ownership could not be retired. Inspect dev:logs before manual recovery.';
      return pending;
    },
  };
}
