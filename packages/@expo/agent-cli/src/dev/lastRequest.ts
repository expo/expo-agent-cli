// @ref llp/0035-one-device-per-worktree.rfc.md §Lifecycle output
import fs from 'fs';
import path from 'path';

import { live, readCloudBindings } from '../deviceBinding/cloud';
import type { Binding, DevicePlatform } from '../deviceBinding/types';
import { easOpenPlatform, type DevOptions } from './resolveOptions';

/** Recovery preferences, never evidence that a process or device is alive. */
export type LastDevRequest = Pick<
  DevOptions,
  'platform' | 'port' | 'device' | 'buildBackend' | 'runTarget'
> & {
  /**
   * `eas` when the run opened its app on an EAS session, else `local`; absent in a record from
   * before the field. The readers prefer that session (llp/0035 §Readers, Scope).
   */
  deviceBackend?: 'local' | 'eas';
};

const FILE = 'agent-cli-last-dev.json';

export function readLastDevRequest(projectRoot: string): LastDevRequest | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(projectRoot, '.expo', FILE), 'utf8'));
    if (
      value?.version !== 1 ||
      !['ios', 'android', 'web'].includes(value.platform) ||
      !(
        value.port === null ||
        (Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535)
      ) ||
      ![null, 'local', 'eas'].includes(value.buildBackend) ||
      ![null, 'expo-go', 'dev-build'].includes(value.runTarget) ||
      !(value.device === undefined || typeof value.device === 'string') ||
      ![undefined, 'local', 'eas'].includes(value.deviceBackend)
    )
      return null;
    const { platform, port, device, buildBackend, runTarget, deviceBackend } = value;
    return { platform, port, device, buildBackend, runTarget, deviceBackend };
  } catch {
    return null;
  }
}

export function recordLastDevRequest(projectRoot: string, options: DevOptions): void {
  if (options.mode !== 'run') return;
  try {
    // Nonrecursive: a late invocation must not resurrect a deleted checkout.
    try {
      fs.mkdirSync(path.join(projectRoot, '.expo'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return;
    }
    const { platform, port, device, buildBackend, runTarget } = options;
    const deviceBackend = easOpenPlatform(options) != null ? 'eas' : 'local';
    fs.writeFileSync(
      path.join(projectRoot, '.expo', FILE),
      JSON.stringify({
        version: 1,
        platform,
        port,
        device,
        buildBackend,
        runTarget,
        deviceBackend,
      }) + '\n'
    );
  } catch {
    // Advisory only. An unwritable cache must not prevent development.
  }
}

/**
 * The live EAS session that the last `dev` of this worktree opened its app on, on the run's
 * platform. It outranks a live local binding, for the readers and for the commands that act on a
 * device, so one run reads and acts on the same device. A session file that cannot be read gives
 * none here: the local binding keeps its rank.
 */
export function lastDevSession(
  projectRoot: string,
  platform: DevicePlatform | null | undefined
): Binding | null {
  const last = readLastDevRequest(projectRoot);
  if (last?.deviceBackend !== 'eas' || last.platform === 'web') return null;
  if (platform != null && platform !== last.platform) return null;
  const sessions = live(readCloudBindings(projectRoot).bindings, new Date()).filter(
    (binding) => binding.device.platform === last.platform
  );
  return sessions.length === 1 ? sessions[0]! : null;
}
