// @ref llp/0035-one-device-per-worktree.rfc.md §Release
import {
  devicesDisabled,
  releaseWorktreeDevicesAsync,
  type ReleasedDevice,
} from '../deviceBinding';
import { deviceUnavailableError } from '../deviceBinding/errors';
import { keptDevices, unreadableBindingFiles } from '../deviceBinding/records';
import { readDevServerLockAsync } from '../devLock';
import type { DevStopOptions } from './resolveStopOptions';

export interface StoppedDevices {
  devices: ReleasedDevice[];
  deviceError: string | null;
}

export async function stopDevicesAsync(
  projectRoot: string,
  options: DevStopOptions,
  stop: { stopped: boolean; reason: string | null; port: number | null }
): Promise<StoppedDevices> {
  const report: StoppedDevices = { devices: [], deviceError: null };
  if (devicesDisabled()) return report;
  report.devices = keptDevices(projectRoot, options.platform);
  try {
    if (options.release) {
      // A requested port may be idle while this worktree's server runs on another port.
      // Read again after stopping: a replacement server may now hold the same lock.
      if (stop.reason === 'foreign-dev-server') {
        report.deviceError = `Devices were kept because a dev server this worktree did not start answers on port ${stop.port}.`;
      } else if (
        !(stop.stopped || stop.reason === 'not-running') ||
        (await readDevServerLockAsync(projectRoot))
      ) {
        report.deviceError =
          "Devices were kept because this worktree's dev server is still running.";
      } else {
        const released: ReleasedDevice[] = [];
        for (const platform of options.platform
          ? [options.platform]
          : (['ios', 'android'] as const)) {
          try {
            released.push(...(await releaseWorktreeDevicesAsync(projectRoot, { platform })));
          } catch (error) {
            report.deviceError ??= error instanceof Error ? error.message : String(error);
          }
        }
        const remaining = keptDevices(projectRoot, options.platform).filter(
          (kept) => !released.some((done) => done.id === kept.id && done.platform === kept.platform)
        );
        report.devices = [...released, ...remaining];
        const [unreadable] = unreadableBindingFiles(projectRoot, options.platform);
        if (unreadable)
          report.deviceError ??= deviceUnavailableError('unreadable', {
            platform: unreadable.platform,
            path: unreadable.file,
          }).message;
        if (report.devices.some((device) => !device.released))
          report.deviceError ??= 'Some devices could not be released; see devices for details.';
      }
    }
  } catch (error) {
    report.deviceError = error instanceof Error ? error.message : String(error);
  }
  return report;
}
