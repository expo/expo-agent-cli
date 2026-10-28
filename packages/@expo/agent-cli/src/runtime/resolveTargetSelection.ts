// @ref llp/0005-runtime-loop-tools.rfc.md §One preflight for the runtime family
import type { NavigateDevice, NavigatePlatform } from '../navigate/device';
import type { CdpTarget } from './cdpClient';
import {
  deviceInventoryForSelectionAsync,
  classifyTargets,
  type DeviceInventory,
  type ClassifiedTargets,
  type TargetSelection,
} from './targetSelection';

export interface ResolveTargetSelectionOptions {
  projectRoot: string | null;
  flags: { platform: NavigatePlatform | null | undefined; eas: boolean };
  device?: NavigateDevice | null;
  targets: CdpTarget[];
  deviceInventory?: DeviceInventory;
}
export interface ResolvedTargetSelection {
  targetSelection: TargetSelection;
  deviceInventory: DeviceInventory;
  classifiedTargets: ClassifiedTargets;
}

/** The run's scope, from its flags and the device it opens. Reads nothing. */
export function targetSelectionOf({
  flags,
  device,
}: Pick<ResolveTargetSelectionOptions, 'flags' | 'device'>): TargetSelection {
  const platform = flags.platform ?? device?.platform;
  return {
    platform:
      platform == null ? null : { value: platform, by: flags.platform != null ? 'flag' : 'device' },
    device: null,
  };
}

/** Resolve one scope and place the caller's already-read target list. */
export async function resolveTargetSelectionAsync(
  options: ResolveTargetSelectionOptions
): Promise<ResolvedTargetSelection> {
  const targetSelection = targetSelectionOf(options);
  const deviceInventory =
    options.deviceInventory ??
    (await deviceInventoryForSelectionAsync(options.targets, targetSelection));
  return {
    targetSelection,
    deviceInventory,
    classifiedTargets: classifyTargets(options.targets, targetSelection, deviceInventory),
  };
}
