// @ref llp/0005-runtime-loop-tools.rfc.md §One preflight for the runtime family
// @ref llp/0035-one-device-per-worktree.rfc.md §Readers
import { devicesDisabled, localBackendOf, noBoundDeviceError } from '../deviceBinding';
import { live, readCloudBindings } from '../deviceBinding/cloud';
import { isExpired } from '../deviceBinding/lease';
import { bindingPathFor, readBindingFile } from '../deviceBinding/registry';
import type { Binding, BoundDevice, DevicePlatform } from '../deviceBinding/types';
import type { NavigateDevice, NavigatePlatform } from '../navigate/device';
import type { CdpTarget } from './cdpClient';
import {
  deviceInventoryForSelectionAsync,
  selectedDeviceOf,
  classifyTargets,
  type DeviceInventory,
  type ClassifiedTargets,
  type TargetSelection,
} from './targetSelection';

export interface ResolveTargetSelectionOptions {
  projectRoot: string | null;
  flags: { platform: NavigatePlatform | null | undefined; eas: boolean };
  /** A device the caller already resolved; no binding is read. */
  device?: NavigateDevice | null;
  targets: CdpTarget[];
  deviceInventory?: DeviceInventory;
  /** The dev server the targets came from; its port tells two Android devices of one model apart. */
  devServerUrl?: string | null;
}
export interface ResolvedTargetSelection {
  targetSelection: TargetSelection;
  deviceInventory: DeviceInventory;
  classifiedTargets: ClassifiedTargets;
}

/** The run's scope, from its flags and the device it opens or this worktree bound. Reads nothing. */
export function targetSelectionOf({
  flags,
  device,
  binding = null,
}: Pick<ResolveTargetSelectionOptions, 'flags' | 'device'> & {
  binding?: BoundDevice | null;
}): TargetSelection {
  const bound = device == null && binding != null;
  const candidate = device ?? binding;
  const platform = flags.platform ?? candidate?.platform;
  return {
    platform:
      platform == null
        ? null
        : {
            value: platform,
            by: flags.platform != null ? 'flag' : bound ? 'bound-device' : 'device',
          },
    device: candidate
      ? selectedDeviceOf(candidate)
      : flags.eas
        ? { backend: 'cloud', deviceId: null }
        : null,
    bound,
  };
}

/** The run's scope: {@link targetSelectionOf} on this worktree's binding when no device is given. */
export async function resolveScopeAsync(
  options: Pick<ResolveTargetSelectionOptions, 'projectRoot' | 'flags' | 'device'>
): Promise<TargetSelection> {
  const binding =
    !options.device && options.projectRoot
      ? await boundDeviceAsync(options.projectRoot, options.flags)
      : null;
  return targetSelectionOf({ ...options, binding });
}

/** Resolve the device scope and place the caller's target observation. */
export async function resolveTargetSelectionAsync(
  options: ResolveTargetSelectionOptions
): Promise<ResolvedTargetSelection> {
  const targetSelection = await resolveScopeAsync(options);
  const deviceInventory =
    options.deviceInventory ??
    (await deviceInventoryForSelectionAsync(
      options.targets,
      targetSelection,
      options.projectRoot,
      options.devServerUrl
    ));
  return {
    targetSelection,
    deviceInventory,
    classifiedTargets: classifyTargets(options.targets, targetSelection, deviceInventory),
  };
}

/**
 * This worktree's local binding on the run's platform is the scope, whether or not its device is up
 * now. No inspection decides it: a device that is not up has no app, so the read finds none. With
 * no local binding, the one live cloud binding is the scope. With devices disabled, only `--eas`
 * reads a binding.
 *
 * @throws `NO_BOUND_DEVICE` when an own binding file cannot be read.
 */
async function boundDeviceAsync(
  projectRoot: string,
  flags: ResolveTargetSelectionOptions['flags']
): Promise<BoundDevice | null> {
  // AGENT_CLI_NO_DEVICE keeps this machine's devices untouched; an EAS session is not one of them.
  if (!flags.eas && !devicesDisabled()) {
    const local = liveLocalBinding(projectRoot, flags.platform ?? undefined);
    if (local) return local.device;
  }
  const { bindings, unreadable } = readCloudBindings(projectRoot);
  const own = unreadable.find((each) => flags.platform == null || each.platform === flags.platform);
  if (own) throw noBoundDeviceError('unreadable', own);
  const sessions = live(bindings, new Date()).filter(
    (binding) => flags.platform == null || binding.device.platform === flags.platform
  );
  return sessions.length === 1 ? sessions[0]!.device : null;
}

/** With no platform, iOS (on macOS) and Android; of two live bindings, the newer one. */
function liveLocalBinding(
  projectRoot: string,
  platform: DevicePlatform | undefined
): Binding | null {
  const platforms: DevicePlatform[] = platform
    ? [platform]
    : process.platform === 'darwin'
      ? ['ios', 'android']
      : ['android'];
  const now = new Date();
  let newest: Binding | null = null;
  for (const each of platforms) {
    const path = bindingPathFor(projectRoot, each, localBackendOf(each));
    const read = readBindingFile(path);
    if (read.kind === 'unreadable')
      throw noBoundDeviceError('unreadable', { platform: each, path });
    if (read.kind !== 'binding' || isExpired(read.binding, now)) continue;
    if (newest == null || read.binding.boundAt > newest.boundAt) newest = read.binding;
  }
  return newest;
}
