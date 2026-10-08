// @ref llp/0030-one-device-per-worktree.rfc.md §Entry points
// What a read verb learns about one binding: lock-free, no extension, one subprocess at most.

import * as Log from '../log';
import { noBoundDeviceError } from './errors';
import { listSimulatorAsync, SIMCTL_CALL_TIMEOUT_MS } from './ios';
import { extendLeaseAsync, isExpired } from './lease';
import { bindingPathFor, readBindingFile } from './registry';
import { defaultTools } from './tools';
import type { BoundDevice, DevicePlatform, DeviceTools, Inspection } from './types';

/** The wait of a read verb's lease extension; a timeout warns and goes on. */
export const READ_LOCK_WAIT_MS = 5_000;

/** The backends this PR inspects; `local-android` arrives with llp/0032. */
export type InspectableBackend = 'local-ios' | 'cloud';

export async function inspectBindingAsync(
  projectRoot: string,
  platform: DevicePlatform,
  backend: InspectableBackend,
  tools: DeviceTools = defaultTools(),
  { timeoutMs = SIMCTL_CALL_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<Inspection> {
  const path = bindingPathFor(projectRoot, platform, backend);
  const read = readBindingFile(path);
  if (read.kind === 'none') {
    return { binding: null, path, state: 'none' };
  }
  if (read.kind === 'unreadable') {
    return { binding: null, path, state: 'unreadable' };
  }
  const { binding } = read;
  const expired = isExpired(binding, tools.now());
  if (binding.device.backend === 'cloud') {
    return expired
      ? { binding, path, state: 'gone', cause: 'expired' }
      : { binding, path, state: 'recorded' };
  }
  if (binding.device.backend !== 'local-ios') {
    return { binding, path, state: 'unreadable' };
  }
  const listing = await listSimulatorAsync(tools, binding.device.udid, { timeoutMs });
  if (listing.kind === 'tool') {
    return { binding, path, state: 'unknown', cause: 'tool', toolError: listing.error };
  }
  if (listing.kind === 'timeout') {
    return { binding, path, state: 'unknown', cause: 'timeout' };
  }
  if (expired) {
    return { binding, path, state: 'gone', cause: 'expired' };
  }
  if (listing.kind === 'missing') {
    return { binding, path, state: 'gone', cause: 'device-gone' };
  }
  return { binding, path, state: listing.state === 'Booted' ? 'up' : 'not-up' };
}

const cache = new Map<string, Promise<Inspection>>();

/** One inspection per process, root, platform and backend, for the suggestion ladders. */
export function inspectBindingCachedAsync(
  projectRoot: string,
  platform: DevicePlatform,
  backend: InspectableBackend,
  options: { tools?: DeviceTools; timeoutMs?: number } = {}
): Promise<Inspection> {
  const key = `${projectRoot}\0${platform}\0${backend}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = inspectBindingAsync(projectRoot, platform, backend, options.tools, options);
    cache.set(key, pending);
  }
  return pending;
}

export function clearInspectCache(): void {
  cache.clear();
}

/**
 * Take an `up` inspection, extend its lease, and hand back the device. Never inspects again and
 * never boots. `lost` throws `gone` with cause `expired`.
 */
export async function useBoundDeviceAsync(
  inspection: Inspection,
  tools: DeviceTools = defaultTools()
): Promise<BoundDevice> {
  const binding = inspection.binding;
  if (inspection.state !== 'up' || binding == null) {
    throw new Error(`useBoundDeviceAsync needs an up inspection, not ${inspection.state}`);
  }
  const { platform, backend } = binding.device;
  let outcome: 'extended' | 'lost';
  try {
    outcome = await extendLeaseAsync(binding.projectRoot, platform, backend, tools, {
      waitMs: READ_LOCK_WAIT_MS,
    });
  } catch (error: unknown) {
    if ((error as { code?: string }).code !== 'DEVICE_REGISTRY_LOCKED') {
      throw error;
    }
    Log.warn(
      `The device registry is locked, so the lease on ${deviceLabel(binding.device)} was not extended.`
    );
    return binding.device;
  }
  if (outcome === 'lost') {
    throw noBoundDeviceError('gone', { platform, cause: 'expired', path: inspection.path });
  }
  return binding.device;
}

function deviceLabel(device: BoundDevice): string {
  return device.backend === 'local-ios' ? device.name : device.backend;
}
