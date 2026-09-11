// @ref llp/0028-installed-app-check.rfc.md §Reported by status
// The `installed` section: what the app on a device says, as opposed to what this machine recorded
// building. Only ever asked under `--explain`, because every answer costs a device read.

import {
  checkInstalledAppAsync,
  type PlatformCheck,
} from '../installedApp/installedAppAsync';
import { hostPlatforms, type InstalledAppPlatform } from '../installedApp/options';
import type { InstalledPlatformStatus, InstalledStatus } from './types';

export interface InstalledStatusOptions {
  /** False outside `--explain`, which is the whole cost control. */
  lookUp: boolean;
  /** The simulator or device the caller named, and the consent for the physical-iPhone probe. */
  device?: string | null;
  fingerprintCache?: boolean;
  /** Overrides the host platform detection, for tests. */
  hostPlatform?: string;
}

/**
 * Ask every device this machine can reach what it has installed.
 *
 * Null without `--explain`, so a default `status` reads no device at all. Never throws: a platform
 * whose device tool is missing answers `no-device`, which is a row in the report rather than an
 * error.
 */
export async function readInstalledStatusAsync(
  projectRoot: string,
  options: InstalledStatusOptions
): Promise<InstalledStatus | null> {
  if (!options.lookUp) {
    return null;
  }
  const platforms: InstalledAppPlatform[] = hostPlatforms(options.hostPlatform);
  const report = await checkInstalledAppAsync(projectRoot, {
    platforms,
    device: options.device ?? null,
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
