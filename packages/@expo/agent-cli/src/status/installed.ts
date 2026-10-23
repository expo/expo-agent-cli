// @ref llp/0004-smart-start-and-project-state.rfc.md §Reported by status
// This only shapes the answer; `status` decides when the check runs.

import { deviceCommand } from '../deviceBinding/errors';
import type { InspectState } from '../deviceBinding/types';
import { DEFAULT_RESPONSE_TIMEOUT_MS } from '../installedApp/fingerprintCheckProtocol';
import { checkInstalledAppAsync, type PlatformCheck } from '../installedApp/installedAppAsync';
import { hostPlatforms, type InstalledAppPlatform } from '../installedApp/options';
import type { InstalledPlatformStatus, InstalledStatus } from './types';

export interface InstalledStatusOptions {
  /**
   * `--device`: only the simulator, emulator or device with this name or identifier. Naming a
   * physical iPhone is the consent to launch the app on it.
   */
  device: string | null;
  fingerprintCache?: boolean;
  /** `--device-timeout`: how long a phone gets to answer once the app was launched. */
  timeoutMs?: number;
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
    timeoutMs: options.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
  });
  return {
    outcome: report.outcome,
    platforms: platforms
      .map((platform) => toPlatformStatus(platform, report.platforms[platform]))
      .filter((entry): entry is InstalledPlatformStatus => entry !== null),
  };
}

/**
 * Mark the rows that found no local device while this worktree records an EAS session for that
 * platform: the check reads local devices only, so it did not check the app on the session. Status
 * makes no session service call, so the session is recorded, not confirmed. A binding whose lease
 * expired (`gone`) names `dev --eas`, which binds a session again.
 */
export function withCloudSessions(
  installed: InstalledStatus,
  sessions: readonly { platform: string; id: string; state?: InspectState }[]
): InstalledStatus {
  return {
    ...installed,
    platforms: installed.platforms.map((entry) => {
      const session = sessions.find(({ platform }) => platform === entry.platform);
      if (entry.reason !== 'no-device' || !session) return entry;
      if (session.state === 'gone') {
        return {
          ...entry,
          reason: 'cloud-session',
          recommendation: `not checked; this check reads local devices, and the lease on EAS Simulator session ${session.id} expired`,
          commands: [deviceCommand(entry.platform, { eas: true })],
        };
      }
      return {
        ...entry,
        reason: 'cloud-session',
        recommendation: `not checked; this check reads local devices, and the app runs on EAS Simulator session ${session.id}`,
        commands: [],
      };
    }),
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
