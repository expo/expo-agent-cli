// @ref llp/0035-one-device-per-worktree.rfc.md §Release
import {
  devicesDisabled,
  releaseWorktreeDevicesAsync,
  type ReleasedDevice,
} from '../deviceBinding';
import { keptDevices } from '../deviceBinding/records';
import { readDevServerLockAsync } from '../devLock';
import type { DevStopOptions } from './resolveStopOptions';

export interface StoppedDevices {
  devices: ReleasedDevice[];
  deviceError: string | null;
}

export async function stopDevicesAsync(
  projectRoot: string,
  options: DevStopOptions,
  devServerOk: boolean
): Promise<StoppedDevices> {
  const report: StoppedDevices = { devices: [], deviceError: null };
  if (devicesDisabled()) return report;
  report.devices = keptDevices(projectRoot, options.platform);
  try {
    if (options.release) {
      // A requested port may be idle while this worktree's server runs on another port.
      // Read again after stopping: a replacement server may now hold the same lock.
      if (!devServerOk || (await readDevServerLockAsync(projectRoot))) {
        report.deviceError =
          "Devices were kept because this worktree's dev server is still running.";
      } else {
        report.devices = await releaseWorktreeDevicesAsync(projectRoot, {
          platform: options.platform,
        });
        const remaining = keptDevices(projectRoot, options.platform).filter(
          (kept) =>
            !report.devices.some(
              (released) => released.id === kept.id && released.platform === kept.platform
            )
        );
        report.devices.push(...remaining);
        if (report.devices.some((device) => !device.released))
          report.deviceError = 'Some devices could not be released; see devices for details.';
      }
    }
  } catch (error) {
    report.deviceError = error instanceof Error ? error.message : String(error);
  }
  return report;
}
