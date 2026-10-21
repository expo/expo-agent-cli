// @ref llp/0035-one-device-per-worktree.rfc.md §Readers
// The cloud rung of the read verbs' ladder: this worktree's cloud bindings, checked against what the
// EAS service lists. One snapshot of the registry, one probe, one verdict.

import { cloudPlatformMismatchError, cloudPlatformUnknownError } from '../device/cloudErrors';
import {
  probeCloudSessionAsync,
  type CloudPlatform,
  type CloudSessionProbe,
  type LiveCloudSessionProbe,
} from '../device/cloudSimulator';
import { live, readCloudBindings, type CloudBinding } from './cloud';
import {
  cloudBindingError,
  cloudSessionQueuedError,
  noBoundDeviceError,
  type CommandError,
} from './errors';
import { extendBoundLeaseAsync } from './inspect';
import { isExpired } from './lease';
import { bindingPathFor } from './registry';
import { defaultTools } from './tools';
import type { DeviceTools } from './types';

/** The session the rung settled on. */
export interface CloudRungDevice {
  platform: CloudPlatform;
  id: string;
  name: string;
}

/** A probe that selected no session: what a caller names when the rung has no device. */
export type NoDeviceProbe = Exclude<CloudSessionProbe, LiveCloudSessionProbe>;

export type CloudRung =
  | { kind: 'device'; device: CloudRungDevice }
  | { kind: 'none'; probe: NoDeviceProbe };

export type CloudVerdict =
  /** `extend` is the binding that names the session; null when only the dotenv names it. */
  | { kind: 'device'; device: CloudRungDevice; extend: CloudBinding | null }
  | { kind: 'refuse'; error: CommandError }
  | { kind: 'none'; probe: NoDeviceProbe };

/**
 * Settle the cloud rung for `platform` (any platform when null).
 *
 * @throws {CommandError} when a binding file cannot be read, when a recorded session is expired,
 * queued or ended, when the session is on the other platform or did not report one, and when the
 * lease of the selected binding was lost.
 */
export async function cloudRungAsync(
  projectRoot: string,
  platform: CloudPlatform | null,
  tools: DeviceTools = defaultTools()
): Promise<CloudRung> {
  const snapshot = readCloudBindings(projectRoot);
  const now = tools.now();
  const unreadable = snapshot.unreadable.find(
    (entry) => platform == null || entry.platform === platform
  );
  if (unreadable) throw noBoundDeviceError('unreadable', unreadable);
  const probe = await probeCloudSessionAsync({
    projectRoot,
    platform,
    boundIds: live(snapshot.bindings, now).map(({ device }) => device.id),
  });
  const verdict = cloudVerdict(snapshot.bindings, probe, platform, now);
  if (verdict.kind === 'refuse') throw verdict.error;
  if (verdict.kind === 'none') return verdict;
  const binding = verdict.extend;
  if (binding) {
    const path = bindingPathFor(projectRoot, binding.device.platform, 'cloud');
    await extendBoundLeaseAsync(binding, path, tools);
  }
  return { kind: 'device', device: verdict.device };
}

/** What the probe and this worktree's bindings together say to do. Pure. */
export function cloudVerdict(
  bindings: CloudBinding[],
  probe: CloudSessionProbe,
  platform: CloudPlatform | null,
  now: Date
): CloudVerdict {
  const records = bindings.filter(
    (binding) => platform == null || binding.device.platform === platform
  );
  if (probe.state === 'queued' || probe.state === 'active') {
    const { session } = probe;
    // A session is created for one platform and keeps it, so a flag that names the other one is
    // answered with the mismatch, whether the session is up or still pending.
    if (platform != null && session.platform != null && session.platform !== platform) {
      return {
        kind: 'refuse',
        error: cloudPlatformMismatchError(platform, session.platform, session.id),
      };
    }
    const sessionPlatform = session.platform ?? platform;
    if (probe.state === 'queued') {
      return {
        kind: 'refuse',
        error: cloudSessionQueuedError({ ...session, platform: sessionPlatform }),
      };
    }
    // The URL shape differs per platform, so a session that reported none, read with no flag that
    // names one, is not a device this rung can hand out.
    if (sessionPlatform == null) {
      return { kind: 'refuse', error: cloudPlatformUnknownError(session.id) };
    }
    const record = bindings.find(({ device }) => device.id === session.id) ?? null;
    if (record && isExpired(record, now)) {
      return refuse(record, 'expired');
    }
    return {
      kind: 'device',
      device: {
        platform: sessionPlatform,
        id: session.id,
        // The session's own `--name` when it has one, because a project with several sessions up
        // has just had one chosen for it, and the name is what says which (llp/0005 §Cloud simulator).
        name: session.name ?? 'EAS Simulator session',
      },
      extend: record,
    };
  }
  // An expired binding must not hide a different, live session named by dotenv: that case is
  // `active` above.
  const expired = records.find((binding) => isExpired(binding, now));
  if (expired && records.every((binding) => isExpired(binding, now))) {
    return refuse(expired, 'expired');
  }
  if (probe.state === 'inactive') {
    const ended = records.find(({ device }) => device.id === probe.sessionId);
    if (ended) return refuse(ended, 'ended');
  }
  return { kind: 'none', probe };
}

function refuse(binding: CloudBinding, fault: 'expired' | 'ended'): CloudVerdict {
  return { kind: 'refuse', error: cloudBindingError(binding.device.platform, fault) };
}
