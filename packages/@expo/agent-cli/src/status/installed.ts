// @ref llp/0004-smart-start-and-project-state.rfc.md §Reported by status
// This only shapes the answer; `status` decides when the check runs.

import { checkInstalledAppAsync, type PlatformCheck } from '../installedApp/installedAppAsync';
import { hostPlatforms, type InstalledAppPlatform } from '../installedApp/options';
import type { InstalledPlatformStatus, InstalledStatus } from './types';

export interface InstalledStatusOptions {
  /** `--device`: only the simulator, emulator or device with this name or identifier. */
  device: string | null;
  fingerprintCache?: boolean;
  /** Overrides the host platform detection, for tests. */
  hostPlatform?: string;
}

/**
 * Ask every device this machine can reach what it has installed.
 *
 * Never throws: a platform whose device tool is missing answers `no-device`, which is a row in
 * the report rather than an error.
 */
export async function readInstalledStatusAsync(
  projectRoot: string,
  options: InstalledStatusOptions
): Promise<InstalledStatus> {
  const platforms: InstalledAppPlatform[] = hostPlatforms(options.hostPlatform);
  const report = await checkInstalledAppAsync(projectRoot, {
    platforms,
    device: options.device,
    appId: null,
    fingerprintCache: options.fingerprintCache,
  });
  return {
    outcome: report.outcome,
    platforms: platforms
      .map((platform) => toPlatformStatus(platform, report.platforms[platform]))
      .filter((entry): entry is InstalledPlatformStatus => entry !== null),
  };
}

function toPlatformStatus(
  platform: InstalledAppPlatform,
  check: PlatformCheck | undefined
): InstalledPlatformStatus | null {
  if (!check) {
    return null;
  }
  return {
    platform,
    status: check.status,
    reason: check.reason,
    recommendation: check.recommendation,
    commands: check.commands,
    deviceName: check.device?.name ?? null,
    installedHash: check.installedHash,
    currentHash: check.currentHash,
  };
}
