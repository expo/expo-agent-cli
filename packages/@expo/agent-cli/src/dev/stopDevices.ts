// @ref llp/0035-one-device-per-worktree.rfc.md §Release
import {
  devicesDisabled,
  releaseWorktreeDevicesAsync,
  type ReleasedDevice,
} from '../deviceBinding';
import { deviceUnavailableError } from '../deviceBinding/errors';
import { keptDevices, unreadableBindingFiles } from '../deviceBinding/records';
import { reapDevicesAsync } from '../deviceBinding/reap';
import type { CleanupReport } from '../deviceBinding/cleanup';
import { readDevServerLockAsync } from '../devLock';
import { PROGRAM_PREFIX } from '../programName';
import type { DevStopOptions } from './resolveStopOptions';

export interface StoppedDevices {
  devices: ReleasedDevice[];
  reaped: CleanupReport[];
  deviceError: string | null;
}

export async function stopDevicesAsync(
  projectRoot: string,
  options: DevStopOptions,
  stop: { reason: string | null; port: number | null; url: string | null }
): Promise<StoppedDevices> {
  const report: StoppedDevices = { devices: [], reaped: [], deviceError: null };
  if (devicesDisabled()) return report;
  // `--local` left the session running over the config, so the retry must too.
  const onLocal = options.local ? ' --local' : '';
  report.devices = keptDevices(projectRoot, options.platform);
  try {
    if (options.release) {
      // A requested port may be idle while this worktree's server runs on another port.
      // Read again after stopping: a replacement server may now hold the same lock.
      if (stop.reason === 'still-running') {
        report.deviceError =
          "Devices were kept because this worktree's dev server is still running.";
      } else if (await readDevServerLockAsync(projectRoot)) {
        report.deviceError = `Devices were kept because this worktree's dev server is still running.\nHow: run "${PROGRAM_PREFIX} dev:stop --release${onLocal}" with no --port.`;
      } else if (stop.reason === 'foreign-dev-server' && stop.url != null) {
        // `url` is set only when the port answered as an Expo dev server.
        report.deviceError = `Devices were kept because a dev server this worktree did not lock answers on port ${stop.port}.\nHow: stop that dev server where it was started, then run "${PROGRAM_PREFIX} dev:stop --release${onLocal}" again.`;
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
        if (report.devices.some((device) => device.released === false))
          report.deviceError ??= `Some devices could not be released; see devices for details.\nHow: run "${PROGRAM_PREFIX} dev:stop --release${onLocal}" again.`;
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
