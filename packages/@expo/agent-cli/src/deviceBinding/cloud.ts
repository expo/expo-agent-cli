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

/**
 * The bindings a `dev --<platform> --eas` counts: this platform's at any age, the other's live.
 * This platform's come first, because a probe that lists none of them names the first.
 */
export function claimable(
  bindings: CloudBinding[],
  platform: DevicePlatform,
  now: Date
): CloudBinding[] {
  const asked = bindings.filter((binding) => binding.device.platform === platform);
  const other = bindings.filter(
    (binding) => binding.device.platform !== platform && !isExpired(binding, now)
  );
  return [...asked, ...other];
}

/** An expired lease the claim renewed: the file, its session, and both lease ends. */
export interface RenewedLease {
  file: string;
  id: string;
  previous: string;
  renewed: string;
}

/**
 * This worktree's bound cloud session ids, for a `dev --eas` probe. Renews this platform's
 * expired lease under the registry lock first, so a reap in another worktree cannot stop that
 * session while the probe runs. `renewed` names that renewal, so a probe that does not list the
 * session can undo it ({@link restoreRenewedLeaseAsync}).
 */
export async function claimCloudBindingsAsync(
  projectRoot: string,
  platform: DevicePlatform,
  tools: DeviceTools = defaultTools()
): Promise<{ boundIds: string[]; unreadable: string | null; renewed: RenewedLease | null }> {
  try {
    return await withRegistryLockAsync(
      async () => {
        const file = bindingPathFor(projectRoot, platform, 'cloud');
        const read = readBindingFile(file);
        if (read.kind === 'unreadable') return { boundIds: [], unreadable: file, renewed: null };
        let renewed: RenewedLease | null = null;
        if (
          read.kind === 'binding' &&
          isCloudBinding(read.binding) &&
          isExpired(read.binding, tools.now())
        ) {
          const { expiresAt } = leaseFrom(tools.now());
          writeBindingFile(file, { ...read.binding, expiresAt });
          renewed = {
            file,
            id: read.binding.device.id,
            previous: read.binding.expiresAt,
            renewed: expiresAt,
          };
        }
        const { bindings } = readCloudBindings(projectRoot);
        return {
          boundIds: claimable(bindings, platform, tools.now()).map(({ device }) => device.id),
          unreadable: null,
          renewed,
        };
      },
      { waitMs: WRITE_LOCK_WAIT_MS, tools }
    );
  } finally {
    clearInspectCache();
  }
}

/**
 * Put back the lease end a claim renewed, when the probe did not list that session. Only while the
 * file still holds that session with the renewed end, so a write by another run stays. Never throws.
 */
export async function restoreRenewedLeaseAsync(
  lease: RenewedLease,
  tools: DeviceTools = defaultTools()
): Promise<void> {
  try {
    await withRegistryLockAsync(
      async () => {
        const read = readBindingFile(lease.file);
        if (
          read.kind === 'binding' &&
          isCloudBinding(read.binding) &&
          read.binding.device.id === lease.id &&
          read.binding.expiresAt === lease.renewed
        )
          writeBindingFile(lease.file, { ...read.binding, expiresAt: lease.previous });
      },
      { waitMs: WRITE_LOCK_WAIT_MS, tools }
    );
  } catch {
    // A lock that cannot be taken leaves the renewal; it ends in one lease.
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
