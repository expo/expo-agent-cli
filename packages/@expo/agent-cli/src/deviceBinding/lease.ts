// @ref llp/0030-one-device-per-worktree.rfc.md §Lease
// Liveness is a 60 min lease, renewed by use. Nothing else.

import fs from 'fs';

import {
  bindingPathFor,
  readBindingFile,
  withRegistryLockAsync,
  writeBindingFile,
} from './registry';
import type { Binding, BindingBackend, DevicePlatform, DeviceTools } from './types';

export const LEASE_MS = 3_600_000;
export const EXTEND_EVERY_MS = 300_000;

export function leaseFrom(now: Date): { boundAt: string; expiresAt: string } {
  return {
    boundAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
  };
}

export function isExpired(binding: Binding, now: Date): boolean {
  return !(Date.parse(binding.expiresAt) > now.getTime());
}

/** Expired, or the root is deleted (RFC Decision 6). */
export function isStale(binding: Binding, now: Date): boolean {
  if (isExpired(binding, now)) {
    return true;
  }
  try {
    fs.lstatSync(binding.projectRoot);
    return false;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Renew a live lease under the lock. An expired or missing one is `lost`, and nothing is written.
 *
 * @throws `DEVICE_REGISTRY_LOCKED` when the lock is not obtained in `waitMs`.
 */
export async function extendLeaseAsync(
  projectRoot: string,
  platform: DevicePlatform,
  backend: BindingBackend,
  tools: DeviceTools,
  { waitMs }: { waitMs: number }
): Promise<'extended' | 'lost'> {
  const file = bindingPathFor(projectRoot, platform, backend);
  return await withRegistryLockAsync(
    async () => {
      const read = readBindingFile(file);
      const now = tools.now();
      if (read.kind !== 'binding' || isExpired(read.binding, now)) {
        return 'lost';
      }
      writeBindingFile(file, {
        ...read.binding,
        expiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
      });
      return 'extended';
    },
    { waitMs, tools }
  );
}
