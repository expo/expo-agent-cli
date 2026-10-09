// @ref llp/0030-one-device-per-worktree.rfc.md §Records
// Let go of this worktree's own local bindings, one rule per origin. The file action runs under
// the lock, the device action after it.

import { killEmulatorIfOurs } from './android';
import { clearInspectCache } from './inspect';
import { listSimulatorAsync, shutdownSimulatorAsync } from './ios';
import {
  bindingPathFor,
  readBindingFile,
  removeBindingFile,
  withRegistryLockAsync,
  writeBindingFile,
} from './registry';
import { defaultTools } from './tools';
import type { Binding, DevicePlatform, DeviceTools, ReleasedDevice } from './types';

/** The waits of `acquire` and release; read verbs wait less (`./inspect.ts`). */
export const WRITE_LOCK_WAIT_MS = 30_000;

/**
 * Let go of this worktree's local bindings, or only `platform`'s. Never reaps.
 *
 * A `created` simulator is parked and shut down; an `explicit` device keeps its file with an
 * expired lease; a `spawned` instance loses its file and is killed; a binding whose device the
 * inventory does not list loses its file.
 */
export async function releaseWorktreeDevicesAsync(
  projectRoot: string,
  { platform, tools = defaultTools() }: { platform?: DevicePlatform; tools?: DeviceTools } = {}
): Promise<ReleasedDevice[]> {
  const platforms: DevicePlatform[] = platform ? [platform] : ['ios', 'android'];
  const released: ReleasedDevice[] = [];
  for (const each of platforms) {
    const letGo =
      each === 'ios'
        ? await releaseIosAsync(projectRoot, tools)
        : await releaseAndroidAsync(projectRoot, tools);
    if (letGo) {
      released.push(letGo);
    }
  }
  return released;
}

async function releaseIosAsync(
  projectRoot: string,
  tools: DeviceTools
): Promise<ReleasedDevice | null> {
  const file = bindingPathFor(projectRoot, 'ios', 'local-ios');
  const before = readBindingFile(file);
  if (before.kind !== 'binding' || before.binding.device.backend !== 'local-ios') {
    return null;
  }
  const { udid, name, origin } = before.binding.device;
  const listing = await listSimulatorAsync(tools, udid);

  const letGo = await withRegistryLockAsync(
    async () => {
      const read = readBindingFile(file);
      if (read.kind !== 'binding') {
        return null;
      }
      if (listing.kind === 'missing') {
        removeBindingFile(file);
        return { shutdown: false };
      }
      expireLease(file, read.binding, tools);
      return {
        shutdown:
          origin === 'created' && !(listing.kind === 'listed' && listing.state === 'Shutdown'),
      };
    },
    { waitMs: WRITE_LOCK_WAIT_MS, tools }
  );
  clearInspectCache();
  if (letGo == null) {
    return null;
  }
  const stopped = letGo.shutdown ? await shutdownSimulatorAsync(tools, udid) : null;
  return {
    backend: 'local-ios',
    platform: 'ios',
    id: udid,
    name,
    released: true,
    shutDown: stopped?.ok ?? false,
    reason: stopped?.reason ?? null,
  };
}

/** A `spawned` instance: remove the file, then kill the pid while it is ours. `explicit`: expire. */
async function releaseAndroidAsync(
  projectRoot: string,
  tools: DeviceTools
): Promise<ReleasedDevice | null> {
  const file = bindingPathFor(projectRoot, 'android', 'local-android');
  const before = readBindingFile(file);
  if (before.kind !== 'binding' || before.binding.device.backend !== 'local-android') {
    return null;
  }
  const { serial, origin } = before.binding.device;
  const letGo = await withRegistryLockAsync(
    async () => {
      const read = readBindingFile(file);
      if (read.kind !== 'binding') {
        return false;
      }
      if (origin.kind === 'spawned') {
        removeBindingFile(file);
      } else {
        expireLease(file, read.binding, tools);
      }
      return true;
    },
    { waitMs: WRITE_LOCK_WAIT_MS, tools }
  );
  clearInspectCache();
  if (!letGo) {
    return null;
  }
  const killed = origin.kind === 'spawned' ? killEmulatorIfOurs(tools, origin) : null;
  return {
    backend: 'local-android',
    platform: 'android',
    id: serial,
    name: origin.kind === 'spawned' ? `${origin.avd} on ${serial}` : serial,
    released: true,
    shutDown: killed?.killed ?? false,
    reason: killed?.reason ?? null,
  };
}

function expireLease(file: string, binding: Binding, tools: DeviceTools): void {
  writeBindingFile(file, { ...binding, expiresAt: tools.now().toISOString() });
}
