// @ref llp/0030-one-device-per-worktree.rfc.md §Entry points
// What a read verb learns about one binding: lock-free, no extension, one subprocess at most.

import * as Log from '../log';
import { getEmulatorStateAsync } from './emulator';
import { noBoundDeviceError } from './errors';
import { listSimulatorAsync, SIMCTL_CALL_TIMEOUT_MS } from './ios';
import { extendLeaseAsync, isExpired } from './lease';
import { bindingPathFor, readBindingFile } from './registry';
import { defaultTools } from './tools';
import {
  deviceIdOf,
  type Binding,
  type BindingBackend,
  type BoundDevice,
  type DevicePlatform,
  type DeviceTools,
  type Inspection,
} from './types';

/** The wait of a read verb's lease extension; a timeout warns and goes on. */
export const READ_LOCK_WAIT_MS = 5_000;

export async function inspectBindingAsync(
  projectRoot: string,
  platform: DevicePlatform,
  backend: BindingBackend,
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
  const listing =
    binding.device.backend === 'local-ios'
      ? await listSimulatorAsync(tools, binding.device.udid, { timeoutMs })
      : await getEmulatorStateAsync(tools, binding.device.serial, { timeoutMs });
  if (listing.kind === 'tool') {
    return { binding, path, state: 'unknown', cause: 'tool', toolError: listing.error };
  }
  if (listing.kind === 'timeout') {
    return { binding, path, state: 'unknown', cause: 'timeout' };
  }
  if (expired) {
    return { binding, path, state: 'gone', cause: 'expired' };
  }
  if (listing.kind === 'missing' || instanceDead(binding, tools)) {
    return { binding, path, state: 'gone', cause: 'device-gone' };
  }
  const up = binding.device.backend === 'local-ios' ? 'Booted' : 'device';
  return { binding, path, state: listing.state === up ? 'up' : 'not-up' };
}

/** A `spawned` instance whose `emulatorPid` is dead, whatever `adb` lists under its serial. */
function instanceDead(binding: Binding, tools: DeviceTools): boolean {
  const { device } = binding;
  return (
    device.backend === 'local-android' &&
    device.origin.kind === 'spawned' &&
    !tools.isPidAlive(device.origin.emulatorPid)
  );
}

const cache = new Map<string, Promise<Inspection>>();

/** One inspection per process, root, platform and backend, for the suggestion ladders. */
export function inspectBindingCachedAsync(
  projectRoot: string,
  platform: DevicePlatform,
  backend: BindingBackend,
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
  return device.backend === 'local-ios' ? device.name : deviceIdOf(device);
}
