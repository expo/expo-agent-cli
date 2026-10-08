// @ref llp/0030-one-device-per-worktree.rfc.md §Entry points
// Each worktree gets its own device. `dev` and `smoke` acquire; every other verb reads.

import { BOOT_DEVICE_TIMEOUT_MS } from '../device/bootDevice';
import { canonicalizeExistingPath } from '../utils/dir';
import { chooseIosDevice, type IosInventory } from './choose';
import { deviceUnavailableError } from './errors';
import { clearInspectCache } from './inspect';
import {
  bootSimulatorAsync,
  createSimulatorAsync,
  listSimulatorAsync,
  readIosInventoryAsync,
  shutdownSimulatorAsync,
} from './ios';
import { leaseFrom } from './lease';
import {
  bindingPathFor,
  digestForRoot,
  readBindingFile,
  removeBindingFile,
  withRegistryLockAsync,
  writeBindingFile,
} from './registry';
import { defaultTools } from './tools';
import type { AcquireAction, AcquireResult, Binding, DeviceTools, ReleasedDevice } from './types';

export { deviceCommand, noBoundDeviceError, deviceUnavailableError } from './errors';
export {
  clearInspectCache,
  inspectBindingAsync,
  inspectBindingCachedAsync,
  useBoundDeviceAsync,
} from './inspect';
export { findBoundDeviceAsync, type AndroidRung, type BoundDeviceSearch } from './rungs';
export { defaultTools } from './tools';
export type * from './types';

/** The waits of `acquire` and release; read verbs wait less (`./inspect.ts`). */
export const WRITE_LOCK_WAIT_MS = 30_000;

/** `AGENT_CLI_NO_DEVICE` turns every device off for a harness whose machines must not be touched. */
export function devicesDisabled(): boolean {
  return process.env.AGENT_CLI_NO_DEVICE === '1';
}

export interface AcquireDeviceOptions {
  /** Any choice but a reuse is refused `not-reusable`. */
  reuseOnly?: boolean;
  tools?: DeviceTools;
}

/**
 * Bind this worktree's simulator and boot it.
 *
 * The inventory is read before the lock. Under the lock, in one section: the own binding is
 * read, the choice made and written, with `simctl create` inside the section. After it, the boot
 * runs on every choice, whatever the inventory said. A failed boot lets go of the binding.
 *
 * @throws `DEVICE_UNAVAILABLE` with `data.reason`, `DEVICE_REGISTRY_LOCKED`, or the tool error.
 */
export async function acquireDeviceAsync(
  projectRoot: string,
  platform: 'ios',
  { reuseOnly = false, tools = defaultTools() }: AcquireDeviceOptions = {}
): Promise<AcquireResult> {
  const inventory = await readIosInventoryAsync(tools);
  const { binding, wasBooted, action } = await withRegistryLockAsync(
    () => bindIosSectionAsync(projectRoot, { inventory, reuseOnly, tools }),
    { waitMs: WRITE_LOCK_WAIT_MS, tools }
  );
  clearInspectCache();

  const device = binding.device as Extract<Binding['device'], { backend: 'local-ios' }>;
  const boot = await bootSimulatorAsync(tools, device.udid, {
    timeoutMs: BOOT_DEVICE_TIMEOUT_MS.ios,
  });
  if (!boot.ok) {
    await releaseWorktreeDevicesAsync(projectRoot, { platform, tools });
    throw deviceUnavailableError('boot-failed', { platform, detail: boot.reason ?? undefined });
  }
  return { device, justBooted: !wasBooted, action };
}

/** The section: read the own binding, choose, write. `simctl create` runs inside it. */
async function bindIosSectionAsync(
  projectRoot: string,
  {
    inventory,
    reuseOnly,
    tools,
  }: { inventory: IosInventory; reuseOnly: boolean; tools: DeviceTools }
): Promise<{ binding: Binding; wasBooted: boolean; action: AcquireAction }> {
  const file = bindingPathFor(projectRoot, 'ios', 'local-ios');
  const read = readBindingFile(file);
  if (read.kind === 'unreadable') {
    throw deviceUnavailableError('unreadable', { platform: 'ios', path: file });
  }
  const own = read.kind === 'binding' ? read.binding : null;
  const choice = chooseIosDevice({ own, inventory, reuseOnly, digest: digestForRoot(projectRoot) });
  if (own != null && choice.kind !== 'reuse') {
    removeBindingFile(file);
  }
  // The reap of other worktrees' stale bindings arrives with llp/0033.
  if (choice.kind === 'refuse') {
    throw deviceUnavailableError(choice.reason, { platform: 'ios' });
  }
  const lease = leaseFrom(tools.now());
  if (choice.kind === 'reuse') {
    const reused = { ...choice.binding, ...lease };
    writeBindingFile(file, reused);
    return { binding: reused, wasBooted: choice.listed.state === 'Booted', action: 'reused' };
  }
  const udid = await createSimulatorAsync(tools, choice);
  const created: Binding = {
    version: 1,
    device: { backend: 'local-ios', platform: 'ios', udid, name: choice.name, origin: 'created' },
    projectRoot: canonicalizeExistingPath(projectRoot),
    ...lease,
  };
  writeBindingFile(file, created);
  return { binding: created, wasBooted: false, action: 'created' };
}

/**
 * Let go of this worktree's local bindings, or only `platform`'s. Never reaps.
 *
 * A `created` simulator is parked and shut down; an `explicit` one keeps its file with an expired
 * lease; a binding whose simulator the inventory does not list loses its file.
 */
export async function releaseWorktreeDevicesAsync(
  projectRoot: string,
  { platform, tools = defaultTools() }: { platform?: 'ios' | 'android'; tools?: DeviceTools } = {}
): Promise<ReleasedDevice[]> {
  if (platform === 'android') {
    return [];
  }
  const file = bindingPathFor(projectRoot, 'ios', 'local-ios');
  const before = readBindingFile(file);
  if (before.kind !== 'binding' || before.binding.device.backend !== 'local-ios') {
    return [];
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
      writeBindingFile(file, { ...read.binding, expiresAt: tools.now().toISOString() });
      return {
        shutdown:
          origin === 'created' && !(listing.kind === 'listed' && listing.state === 'Shutdown'),
      };
    },
    { waitMs: WRITE_LOCK_WAIT_MS, tools }
  );
  clearInspectCache();
  if (letGo == null) {
    return [];
  }
  const stopped = letGo.shutdown ? await shutdownSimulatorAsync(tools, udid) : null;
  return [
    {
      backend: 'local-ios',
      platform: 'ios',
      id: udid,
      name,
      released: true,
      shutDown: stopped?.ok ?? false,
      reason: stopped?.reason ?? null,
    },
  ];
}
