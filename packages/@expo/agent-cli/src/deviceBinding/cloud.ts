// @ref llp/0035-one-device-per-worktree.rfc.md §Session binding
import { canonicalizeExistingPath } from '../utils/dir';
import type { Cleanup } from './cleanup';
import { deviceUnavailableError } from './errors';
import { clearInspectCache } from './inspect';
import { isExpired, leaseFrom } from './lease';
import { acquireSectionAsync } from './reap';
import { deviceReport, ownBindingFiles } from './records';
import {
  bindingPathFor,
  readBindingFile,
  removeBindingFile,
  withRegistryLockAsync,
  writeBindingFile,
} from './registry';
import { WRITE_LOCK_WAIT_MS } from './release';
import { defaultTools } from './tools';
import type { Binding, BoundDevice, DevicePlatform, DeviceTools, ReleasedDevice } from './types';

export type CloudDevice = Extract<BoundDevice, { backend: 'cloud' }>;
export type CloudBinding = Binding & { device: CloudDevice };

/** This worktree's cloud bindings at any age, and the cloud binding files that cannot be read. */
export function readCloudBindings(projectRoot: string): {
  bindings: CloudBinding[];
  unreadable: { platform: DevicePlatform; path: string }[];
} {
  const bindings: CloudBinding[] = [];
  const unreadable: { platform: DevicePlatform; path: string }[] = [];
  for (const platform of ['ios', 'android'] as const) {
    const file = bindingPathFor(projectRoot, platform, 'cloud');
    const read = readBindingFile(file);
    if (read.kind === 'unreadable') unreadable.push({ platform, path: file });
    else if (read.kind === 'binding' && isCloudBinding(read.binding)) bindings.push(read.binding);
  }
  return { bindings, unreadable };
}

function isCloudBinding(binding: Binding): binding is CloudBinding {
  return binding.device.backend === 'cloud';
}

export function live(bindings: CloudBinding[], now: Date): CloudBinding[] {
  return bindings.filter((binding) => !isExpired(binding, now));
}

/** This worktree's cloud bindings whose lease has not expired. */
export function liveCloudBindings(projectRoot: string, now = new Date()): CloudBinding[] {
  return live(readCloudBindings(projectRoot).bindings, now);
}

/** The bindings a `dev --<platform> --eas` counts: this platform's at any age, the other's live. */
export function claimable(
  bindings: CloudBinding[],
  platform: DevicePlatform,
  now: Date
): CloudBinding[] {
  return bindings.filter(
    (binding) => binding.device.platform === platform || !isExpired(binding, now)
  );
}

/**
 * This worktree's bound cloud session ids, for a `dev --eas` probe. Renews this platform's
 * expired lease under the registry lock first, so a reap in another worktree cannot stop that
 * session while the probe runs.
 */
export async function claimCloudBindingsAsync(
  projectRoot: string,
  platform: DevicePlatform,
  tools: DeviceTools = defaultTools()
): Promise<{ boundIds: string[]; unreadable: string | null }> {
  try {
    return await withRegistryLockAsync(
      async () => {
        const file = bindingPathFor(projectRoot, platform, 'cloud');
        const read = readBindingFile(file);
        if (read.kind === 'unreadable') return { boundIds: [], unreadable: file };
        if (read.kind === 'binding' && isExpired(read.binding, tools.now()))
          writeBindingFile(file, { ...read.binding, expiresAt: leaseFrom(tools.now()).expiresAt });
        const { bindings } = readCloudBindings(projectRoot);
        return {
          boundIds: claimable(bindings, platform, tools.now()).map(({ device }) => device.id),
          unreadable: null,
        };
      },
      { waitMs: WRITE_LOCK_WAIT_MS, tools }
    );
  } finally {
    clearInspectCache();
  }
}

export async function acquireCloudBindingAsync(
  projectRoot: string,
  {
    platform,
    id,
    origin,
    start,
    tools = defaultTools(),
  }: {
    platform: DevicePlatform;
    id: string;
    origin: 'started' | 'dotenv';
    /** Only a run that started the session: when it began, and the id the dotenv names now. */
    start?: { at: Date; dotenvId: () => string | null };
    tools?: DeviceTools;
  }
): Promise<CloudBinding> {
  return acquireSectionAsync(projectRoot, tools, async (actions) => {
    const file = bindingPathFor(projectRoot, platform, 'cloud');
    const read = readBindingFile(file);
    if (read.kind === 'unreadable')
      throw deviceUnavailableError('unreadable', { platform, path: file });
    const before = read.kind === 'binding' && isCloudBinding(read.binding) ? read.binding : null;
    const lease = leaseFrom(tools.now());
    const binding: CloudBinding =
      before?.device.id === id
        ? { ...before, expiresAt: lease.expiresAt }
        : {
            version: 1,
            projectRoot: canonicalizeExistingPath(projectRoot),
            device: { backend: 'cloud', platform, id, origin },
            ...lease,
          };
    const raced =
      start != null &&
      before != null &&
      before.device.id !== id &&
      Date.parse(before.boundAt) >= start.at.getTime();
    if (raced && start.dotenvId() !== id) {
      // §Session guard: only the session the dotenv names can be driven, so the other run's stays.
      actions.push(concurrentStop(binding));
      return before;
    }
    if (raced && before.device.origin === 'started') actions.push(concurrentStop(before));
    writeBindingFile(file, binding);
    return binding;
  });
}

function concurrentStop(binding: CloudBinding): Cleanup {
  return { binding, action: 'stop-cloud', reason: 'concurrent-start' };
}

/** Stop callers remove only the session they actually stopped, regardless of lease age. */
export async function releaseCloudBindingAsync(
  projectRoot: string,
  sessionId: string,
  tools = defaultTools()
): Promise<ReleasedDevice[]> {
  try {
    return await withRegistryLockAsync(
      async () => {
        const released: ReleasedDevice[] = [];
        for (const { file, backend } of ownBindingFiles(projectRoot)) {
          if (backend !== 'cloud') continue;
          const read = readBindingFile(file);
          if (
            read.kind !== 'binding' ||
            read.binding.device.backend !== 'cloud' ||
            read.binding.device.id !== sessionId
          )
            continue;
          removeBindingFile(file);
          released.push({ ...deviceReport(read.binding), released: true, shutDown: true });
        }
        return released;
      },
      { waitMs: WRITE_LOCK_WAIT_MS, tools }
    );
  } finally {
    clearInspectCache();
  }
}
