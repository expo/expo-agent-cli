// @ref llp/0035-one-device-per-worktree.rfc.md §Release
import {
  devicesDisabled,
  releaseWorktreeDevicesAsync,
  type ReleasedDevice,
} from '../deviceBinding';
import { deviceUnavailableError } from '../deviceBinding/errors';
import { keptDevices, ownBindingFiles, unreadableBindingFiles } from '../deviceBinding/records';
import { readBindingFile } from '../deviceBinding/registry';
import { readDetachedAttemptAsync, type DetachedAttemptRef } from './detachedOwner';
import { reapDevicesAsync } from '../deviceBinding/reap';
import type { CleanupReport } from '../deviceBinding/cleanup';
import { readDevServerLockAsync, type DevServerLockInfo } from '../devLock';
import { PROGRAM_PREFIX } from '../programName';
import type { DevStopOptions } from './resolveStopOptions';
import { RUN_PHASE } from './runPhase';

export interface StoppedDevices {
  devices: ReleasedDevice[];
  reaped: CleanupReport[];
  deviceError: string | null;
}

export function captureDetachedDevices(
  root: string,
  options: DevStopOptions,
  attempt?: DetachedAttemptRef
) {
  if (!attempt) return null;
  const kept = keptDevices(root, options.platform);
  const bindings = ownBindingFiles(root)
    .filter(
      ({ platform, backend }) =>
        backend !== 'cloud' && (!options.platform || platform === options.platform)
    )
    .flatMap(({ file }) => {
      const read = readBindingFile(file);
      return read.kind === 'binding' ? [read.binding] : [];
    });
  return async (stopped: boolean): Promise<StoppedDevices> => {
    const report: StoppedDevices = { devices: [...kept], reaped: [], deviceError: null };
    const canRelease = async () => {
      const current = await readDetachedAttemptAsync(root);
      if (!current || current.ref?.id === attempt.id) return true;
      report.deviceError =
        'Device cleanup was skipped because detached ownership changed or became uncertain.';
      return false;
    };
    if (!options.release || !stopped || devicesDisabled() || !(await canRelease())) return report;
    try {
      for (const binding of bindings) {
        report.devices = report.devices.filter(
          (device) => device.backend === 'cloud' || device.platform !== binding.device.platform
        );
        report.devices.push(
          ...(await releaseWorktreeDevicesAsync(root, {
            platform: binding.device.platform,
            expected: binding,
            canRelease,
          }))
        );
      }
      if (report.devices.some((device) => !device.released))
        report.deviceError ??= 'Some captured devices could not be released.';
    } catch (error) {
      report.deviceError = error instanceof Error ? error.message : String(error);
    }
    return report;
  };
}

/**
 * @param cloud what `dev:stop --eas` did to this worktree's EAS sessions. Its rows replace the
 * recorded cloud rows, and its error comes after the local devices' error.
 */
export async function stopDevicesAsync(
  projectRoot: string,
  options: DevStopOptions,
  stop: { reason: string | null; port: number | null; url: string | null },
  cloud: Pick<StoppedDevices, 'devices' | 'deviceError'> | null = null
): Promise<StoppedDevices> {
  const report = await stopLocalDevicesAsync(projectRoot, options, stop);
  if (cloud) {
    report.devices.push(...cloud.devices);
    report.deviceError ??= cloud.deviceError;
  } else if (!devicesDisabled()) {
    report.devices.push(
      ...keptDevices(projectRoot, options.platform).filter((device) => device.backend === 'cloud')
    );
  }
  return report;
}

async function stopLocalDevicesAsync(
  projectRoot: string,
  options: DevStopOptions,
  stop: { reason: string | null; port: number | null; url: string | null }
): Promise<StoppedDevices> {
  const report: StoppedDevices = { devices: [], reaped: [], deviceError: null };
  if (devicesDisabled()) return report;
  const kept = () =>
    keptDevices(projectRoot, options.platform).filter((device) => device.backend !== 'cloud');
  report.devices = kept();
  try {
    if (options.release) {
      // A requested port may be idle while this worktree's server runs on another port.
      // Read again after stopping: a replacement server may now hold the same lock.
      const activeRun =
        stop.reason === 'still-running' ? null : await activeRunLockAsync(projectRoot);
      if (stop.reason === 'still-running') {
        report.deviceError =
          "Devices were kept because this worktree's dev server is still running.";
      } else if (activeRun) {
        report.deviceError = `Devices were kept: ${RUN_PHASE[activeRun.phase].state(activeRun)}.\nHow: run "${PROGRAM_PREFIX} dev:stop --release" with no --port.`;
      } else if (stop.reason === 'foreign-dev-server' && stop.url != null) {
        // `url` is set only when the port answered as an Expo dev server.
        report.deviceError = `Devices were kept because a dev server this worktree did not lock answers on port ${stop.port}.\nHow: stop that dev server where it was started, then run "${PROGRAM_PREFIX} dev:stop --release" again.`;
      } else {
        const { released, error } = await releaseDevicesAsync(projectRoot, options.platform);
        report.deviceError ??= error;
        const remaining = kept().filter(
          (device) =>
            !released.some((done) => done.id === device.id && done.platform === device.platform)
        );
        report.devices = [...released, ...remaining];
        const [unreadable] = unreadableBindingFiles(projectRoot, options.platform);
        if (unreadable)
          report.deviceError ??= deviceUnavailableError('unreadable', {
            platform: unreadable.platform,
            path: unreadable.file,
          }).message;
        if (report.devices.some((device) => device.released === false))
          report.deviceError ??= `Some devices could not be released; see devices for details.\nHow: run "${PROGRAM_PREFIX} dev:stop --release" again.`;
      }
    }
  } catch (error) {
    report.deviceError = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      const reaped = await reapDevicesAsync(projectRoot);
      report.reaped = reaped.reports;
      report.deviceError ??=
        reaped.error ?? reaped.reports.find((device) => device.error)?.error ?? null;
    } catch (error) {
      report.deviceError ??= error instanceof Error ? error.message : String(error);
    }
  }
  return report;
}

async function releaseDevicesAsync(
  projectRoot: string,
  platform: DevStopOptions['platform']
): Promise<{ released: ReleasedDevice[]; error: string | null }> {
  const released: ReleasedDevice[] = [];
  let error: string | null = null;
  for (const each of platform ? [platform] : (['ios', 'android'] as const)) {
    try {
      released.push(...(await releaseWorktreeDevicesAsync(projectRoot, { platform: each })));
    } catch (caught) {
      error ??= caught instanceof Error ? caught.message : String(caught);
    }
  }
  return { released, error };
}

/**
 * This worktree's run that still builds or serves. A `finishing` run has no dev server left, so
 * its devices can go (llp/0035 §Preserved sessions).
 */
async function activeRunLockAsync(projectRoot: string): Promise<DevServerLockInfo | null> {
  const lock = await readDevServerLockAsync(projectRoot);
  return lock?.phase === 'finishing' ? null : lock;
}
