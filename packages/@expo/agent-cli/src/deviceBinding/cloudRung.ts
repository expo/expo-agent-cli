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
import { claimable, live, readCloudBindings, type CloudBinding } from './cloud';
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

/** One read of this worktree's cloud binding files, which a caller can pass on to the rung. */
export type CloudSnapshot = ReturnType<typeof readCloudBindings>;

/** The session the rung settled on. */
export interface CloudRungDevice {
  platform: CloudPlatform;
  id: string;
  name: string;
}

/** A probe that selected no session: what a caller names when the rung has no device. */
export type NoDeviceProbe = Exclude<CloudSessionProbe, LiveCloudSessionProbe>;

/**
 * How the caller reaches the rung. `required`: the caller named the cloud (`--eas`), so a session it
 * cannot use is refused. `fallback`: the last rung of a plain read verb, so a pending session or one
 * on another platform than the flag is no device here; the caller names it next to its own refusal.
 */
export type CloudRungUse = 'required' | 'fallback';

/** `P` is the probe a rung with no device hands back: only a fallback rung hands back a live one. */
export type CloudRung<P extends CloudSessionProbe = NoDeviceProbe> =
  | { kind: 'device'; device: CloudRungDevice }
  | { kind: 'none'; probe: P };

export type CloudVerdict<P extends CloudSessionProbe = NoDeviceProbe> =
  /** `extend` is the binding that names the session; null when only the dotenv names it. */
  | { kind: 'device'; device: CloudRungDevice; extend: CloudBinding | null }
  | { kind: 'refuse'; error: CommandError }
  | { kind: 'none'; probe: P };

/**
 * Settle the cloud rung for `platform` (any platform when null).
 *
 * @throws {CommandError} when a binding file cannot be read, when a recorded session is expired,
 * queued or ended, when the session is on the other platform or did not report one, and when the
 * lease of the selected binding was lost. With `use: 'fallback'`, a queued session and one on the
 * other platform are no device instead.
 */
export async function cloudRungAsync(
  projectRoot: string,
  platform: CloudPlatform | null,
  use: 'fallback',
  tools?: DeviceTools,
  snapshot?: CloudSnapshot
): Promise<CloudRung<CloudSessionProbe>>;
export async function cloudRungAsync(
  projectRoot: string,
  platform: CloudPlatform | null,
  use: 'required',
  tools?: DeviceTools,
  snapshot?: CloudSnapshot
): Promise<CloudRung>;
export async function cloudRungAsync(
  projectRoot: string,
  platform: CloudPlatform | null,
  use: CloudRungUse,
  tools: DeviceTools = defaultTools(),
  snapshot: CloudSnapshot = readCloudBindings(projectRoot)
): Promise<CloudRung<CloudSessionProbe>> {
  const now = tools.now();
  const unreadable = snapshot.unreadable.find(
    (entry) => platform == null || entry.platform === platform
  );
  if (unreadable) throw noBoundDeviceError('unreadable', { ...unreadable, eas: true });
  const probe = await probeCloudSessionAsync({
    projectRoot,
    platform,
    boundIds: boundIdsFor(snapshot.bindings, platform, now),
  });
  const verdict = cloudVerdict(snapshot.bindings, probe, platform, now, use);
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
  now: Date,
  use: CloudRungUse = 'required'
): CloudVerdict<CloudSessionProbe> {
  const records = bindings.filter(({ device }) => platform == null || device.platform === platform);
  if (probe.state === 'queued' || probe.state === 'active') {
    return sessionVerdict(bindings, probe, platform, now, use);
  }
  // A probe that could not list sessions says nothing about the lease, and the caller raises it.
  if (probe.state === 'unknown' || probe.state === 'unavailable') return { kind: 'none', probe };
  // An expired binding must not hide a different, live session named by dotenv: that case is
  // `active` above.
  const expired = records.find((binding) => isExpired(binding, now));
  if (expired && records.every((binding) => isExpired(binding, now))) {
    return refuse(expired, 'expired');
  }
  if (probe.state === 'inactive') {
    const ended = unlistedBinding(records, probe.sessionId, now);
    if (ended) return refuse(ended, 'ended');
  }
  return { kind: 'none', probe };
}

/** The ids of the live bindings, this platform's first (`claimable`), because a probe that lists none names the first. */
function boundIdsFor(
  bindings: CloudBinding[],
  platform: CloudPlatform | null,
  now: Date
): string[] {
  const ordered = platform == null ? bindings : claimable(bindings, platform, now);
  return live(ordered, now).map(({ device }) => device.id);
}

/** The verdict for a selected session, queued or up. */
function sessionVerdict(
  bindings: CloudBinding[],
  probe: LiveCloudSessionProbe,
  platform: CloudPlatform | null,
  now: Date,
  use: CloudRungUse
): CloudVerdict<CloudSessionProbe> {
  const { session } = probe;
  if (use === 'fallback' && notUsableHere(probe, platform)) return { kind: 'none', probe };
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

/**
 * The live binding the probe did not select, so it is not up. The listing selects a live binding of
 * the platform asked, so a probe that names an id of another platform still means this one's ended.
 */
function unlistedBinding(
  records: CloudBinding[],
  sessionId: string,
  now: Date
): CloudBinding | undefined {
  const open = live(records, now);
  return open.find(({ device }) => device.id === sessionId) ?? open[0];
}

/** A session the fallback rung names next to the local refusal: still pending, or another platform. */
function notUsableHere(probe: LiveCloudSessionProbe, platform: CloudPlatform | null): boolean {
  const { session } = probe;
  return (
    probe.state === 'queued' ||
    (platform != null && session.platform != null && session.platform !== platform)
  );
}

function refuse(binding: CloudBinding, fault: 'expired' | 'ended'): CloudVerdict<never> {
  return { kind: 'refuse', error: cloudBindingError(binding.device.platform, fault) };
}
