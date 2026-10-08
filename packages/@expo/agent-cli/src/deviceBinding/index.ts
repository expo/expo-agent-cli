// @ref llp/0030-one-device-per-worktree.rfc.md §Entry points
// Each worktree gets its own device. `dev` and `smoke` acquire; every other verb reads.

import { BOOT_DEVICE_TIMEOUT_MS } from '../device/bootDevice';
import { bindAndroidSectionAsync, bootEmulatorAsync } from './android';
import { androidToolsResolve, readAndroidInventoryAsync } from './emulator';
import { deviceUnavailableError } from './errors';
import { clearInspectCache } from './inspect';
import { bootSimulatorAsync, readIosInventoryAsync } from './ios';
import { bindIosSectionAsync } from './iosAcquire';
import { bindExplicitSection } from './explicit';
import { acquireSectionAsync } from './reap';
import { releaseWorktreeDevicesAsync } from './release';
import { defaultTools } from './tools';
import {
  deviceIdOf,
  deviceNameOf,
  type AcquireAction,
  type AcquireResult,
  type Binding,
  type DevicePlatform,
  type DeviceTools,
  type EmulatorHandle,
} from './types';

export { deviceCommand, noBoundDeviceError, deviceUnavailableError } from './errors';
export {
  clearInspectCache,
  inspectBindingAsync,
  inspectBindingCachedAsync,
  useBoundDeviceAsync,
} from './inspect';
export { releaseWorktreeDevicesAsync, WRITE_LOCK_WAIT_MS } from './release';
export { findBoundDeviceAsync, type BoundDeviceSearch } from './rungs';
export { defaultTools } from './tools';
export { deviceIdOf, deviceNameOf, localBackendOf } from './types';
export type * from './types';

/** `AGENT_CLI_NO_DEVICE` turns every device off for a harness whose machines must not be touched. */
export function devicesDisabled(): boolean {
  return process.env.AGENT_CLI_NO_DEVICE === '1';
}

/**
 * Whether this host can run the platform's local device: simulators exist on macOS only, and an
 * emulator instance needs the Android SDK's `adb` and `emulator`. Elsewhere `dev` serves for a
 * device somewhere else and binds nothing.
 */
export function hostBindsPlatform(platform: DevicePlatform): boolean {
  return platform === 'ios' ? process.platform === 'darwin' : androidToolsResolve();
}

/** The one line a caller prints on stderr: which device the run bound, and how. */
export function acquireLine({ device, action }: AcquireResult): string {
  if (action === 'explicit')
    return `Bound ${deviceNameOf(device)} (${deviceIdOf(device)}) to this worktree; it will not be shut down or deleted.`;
  if (device.backend === 'local-android') {
    const avd = device.origin.kind === 'spawned' ? ` of ${device.origin.avd}` : '';
    return action === 'spawned'
      ? `Started a read-only emulator instance${avd} on ${device.serial} for this worktree.`
      : `Reusing this worktree's emulator instance${avd} on ${device.serial}.`;
  }
  const label = `${deviceNameOf(device)} (${deviceIdOf(device)})`;
  return action === 'created'
    ? `Created the iOS simulator ${label} for this worktree.`
    : `Reusing this worktree's iOS simulator ${label}.`;
}

export interface AcquireDeviceOptions {
  /** Any choice but a reuse is refused `not-reusable`. */
  reuseOnly?: boolean;
  tools?: DeviceTools;
  explicit?: string;
}

/**
 * Bind this worktree's device and boot it.
 *
 * The inventory is read before the lock. Under the lock, in one section: the own binding is
 * read, the choice made and written, with `simctl create` or the emulator spawn inside the
 * section. After it, the boot runs on every choice, whatever the inventory said. A failed boot
 * lets go of the binding.
 *
 * @throws `DEVICE_UNAVAILABLE` with `data.reason`, `DEVICE_REGISTRY_LOCKED`, or the tool error.
 */
export async function acquireDeviceAsync(
  projectRoot: string,
  platform: DevicePlatform,
  { reuseOnly = false, tools = defaultTools(), explicit }: AcquireDeviceOptions = {}
): Promise<AcquireResult> {
  const section =
    platform === 'ios'
      ? await acquireIosAsync(projectRoot, { reuseOnly, tools, explicit })
      : await acquireAndroidAsync(projectRoot, { reuseOnly, tools, explicit });
  clearInspectCache();
  const { binding, action, boot } = section;
  const result = await boot();
  if (!result.ok) {
    await releaseWorktreeDevicesAsync(projectRoot, { platform, tools, expected: binding });
    throw deviceUnavailableError('boot-failed', { platform, detail: result.reason ?? undefined });
  }
  return { device: binding.device, justBooted: section.justBooted, action };
}

interface Acquired {
  binding: Binding;
  action: AcquireAction;
  justBooted: boolean;
  boot: () => Promise<{ ok: boolean; reason: string | null }>;
}

async function acquireIosAsync(
  projectRoot: string,
  { reuseOnly, tools, explicit }: { reuseOnly: boolean; tools: DeviceTools; explicit?: string }
): Promise<Acquired> {
  const inventory = await readIosInventoryAsync(tools);
  const { binding, wasBooted, action } = await acquireSectionAsync(
    projectRoot,
    tools,
    async (actions) => {
      if (explicit === undefined)
        return bindIosSectionAsync(projectRoot, { inventory, reuseOnly, tools });
      const candidates = inventory.simulators
        .filter((sim) => sim.isAvailable)
        .map((sim) => ({
          backend: 'local-ios' as const,
          platform: 'ios' as const,
          udid: sim.udid,
          name: sim.name,
          origin: 'explicit' as const,
        }));
      const result = bindExplicitSection(
        projectRoot,
        'ios',
        candidates,
        explicit,
        reuseOnly,
        tools,
        actions
      );
      return {
        ...result,
        wasBooted: inventory.simulators.some(
          (sim) => sim.udid === deviceIdOf(result.binding.device) && sim.state === 'Booted'
        ),
      };
    },
    inventory
  );
  const udid = deviceIdOf(binding.device);
  return {
    binding,
    action,
    justBooted: !wasBooted,
    boot: () => bootSimulatorAsync(tools, udid, { timeoutMs: BOOT_DEVICE_TIMEOUT_MS.ios }),
  };
}

async function acquireAndroidAsync(
  projectRoot: string,
  { reuseOnly, tools, explicit }: { reuseOnly: boolean; tools: DeviceTools; explicit?: string }
): Promise<Acquired> {
  const inventory = await readAndroidInventoryAsync(tools);
  const { binding, action, handle } = await acquireSectionAsync(
    projectRoot,
    tools,
    async (actions) => {
      if (explicit === undefined)
        return bindAndroidSectionAsync(projectRoot, { inventory, reuseOnly, tools });
      const candidates = inventory.runningSerials.map((serial) => ({
        backend: 'local-android' as const,
        platform: 'android' as const,
        serial,
        origin: { kind: 'explicit' as const },
      }));
      return {
        ...bindExplicitSection(
          projectRoot,
          'android',
          candidates,
          explicit,
          reuseOnly,
          tools,
          actions
        ),
        handle: null,
      };
    }
  );
  const serial = deviceIdOf(binding.device);
  return {
    binding,
    action,
    justBooted: action === 'spawned',
    boot: () =>
      bootEmulatorAsync(tools, serial, instanceWatcher(binding, handle, tools), {
        timeoutMs: BOOT_DEVICE_TIMEOUT_MS.android,
      }),
  };
}

/** Why the instance is gone: a spawned child that exited, or a reused pid that died. */
function instanceWatcher(
  binding: Binding,
  handle: EmulatorHandle | null,
  tools: DeviceTools
): () => string | null {
  const { device } = binding;
  if (handle) {
    let exit: { code: number | null } | null = null;
    void handle.exited.then((code) => {
      exit = { code };
    });
    return () => (exit ? `the emulator exited with ${exit.code ?? 'a signal'}` : null);
  }
  if (device.backend === 'local-android' && device.origin.kind === 'spawned') {
    const { emulatorPid } = device.origin;
    return () => (tools.isPidAlive(emulatorPid) ? null : `the emulator pid ${emulatorPid} is gone`);
  }
  return () => null;
}
