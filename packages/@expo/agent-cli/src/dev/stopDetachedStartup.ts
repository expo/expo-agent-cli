import { lockAddressFor, probeDevServerLockAsync } from '../devLock';
import {
  inspectDetachedStopAsync,
  cancelDetachedAttemptAsync,
  retireDetachedAttempt,
  readDetachedAttemptAsync,
  type DetachedAttemptRef,
  stopUncertainError,
} from './detachedOwner';
import { captureCloudSessionsAsync, stopCloudSessionsAsync } from './stopCloudSessions';
import { captureDetachedDevices, stopDevicesAsync } from './stopDevices';
import { readDevServerLockAsync } from '../devLock';
import type { DevStopOptions } from './resolveStopOptions';
import { isProcessAlive } from './processLiveness';
import { isPortFreeAsync, POLL_INTERVAL_MS } from './processStop';
import type { DevStopResultJson } from './stopAsync';

export async function waitForDetachedExitAsync(ref: DetachedAttemptRef, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = await probeDevServerLockAsync(lockAddressFor(ref.projectRoot).address);
    const processGone = !isProcessAlive(ref.pid);
    const lockGone =
      !probe.connected || (probe.info != null && probe.info.detachedAttemptId !== ref.id);
    if (processGone && lockGone) return true;
    if (Date.now() + POLL_INTERVAL_MS >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export async function stopDetachedStartupAsync(
  ref: DetachedAttemptRef,
  control: Awaited<ReturnType<typeof cancelDetachedAttemptAsync>>,
  timeoutMs: number,
  startedAt: number
): Promise<DevStopResultJson> {
  const drained = await control.completion;
  const stopped =
    drained != null &&
    (await waitForDetachedExitAsync(
      ref,
      control.state === 'accepted' ? Math.max(0, startedAt + timeoutMs - Date.now()) : timeoutMs
    ));
  return {
    stopped,
    pid: ref.pid,
    port: ref.port,
    url: null,
    lockHeld: false,
    signal: null,
    forced: false,
    forceRefusedBy: null,
    processStillRunning: isProcessAlive(ref.pid),
    easPlatform: null,
    portStillAnswering: ref.port == null ? null : !(await isPortFreeAsync(ref.port)),
    reason: stopped ? null : 'still-running',
    detail: stopped
      ? 'Startup stopped. An already submitted EAS build continues on EAS; "eas build:cancel" ends it.'
      : 'The captured startup did not prove completed cleanup and exit within the stop timeout. Its ownership was kept.',
    untracked: false,
    waitedMs: Date.now() - startedAt,
    followups: [],
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
  const control =
    inspected.authorized && ref ? await cancelDetachedAttemptAsync(ref, options) : null;
  let lock = inspected.lock;
  let releaseCaptured: ReturnType<typeof captureDetachedDevices>;
  try {
    if (control?.state === 'locked') {
      lock = await readDevServerLockAsync(root);
      if (
        lock &&
        (lock.detachedAttemptId !== ref!.id ||
          lock.pid !== ref!.pid ||
          (options.port != null && options.port !== lock.port))
      )
        throw stopUncertainError();
    }
    releaseCaptured = captureDetachedDevices(root, options, expected ?? ref ?? undefined);
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
      if (
        control &&
        options.eas &&
        (!sessions || !(await waitForDetachedExitAsync(ref!, options.timeoutMs)))
      ) {
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
