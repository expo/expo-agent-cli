// @ref llp/0005-runtime-loop-tools.rfc.md §Android
// Which debugger targets one run reads, decided in one place.
//
// Three inputs, kept apart on purpose: the targets the dev server lists, the facts this machine's
// device tools report, and the run's scope, which is the caller's decision. `classifyTargets` is the
// one function that combines them, so every runtime read places a target the same way.

import type { NavigatePlatform } from '../navigate/device';
import type { CdpTarget } from './cdpClient';
import { platformOfTarget } from './targetPlatform';

/** What this machine's device tools report. Facts only: no decision of this run is in here. */
export interface DeviceInventory {
  /** Booted simulators of every runtime, as `xcrun simctl` reports them. */
  booted: { name: string; udid: string }[];
  /** Hardware models of attached Android devices, as `adb devices -l` reports them. */
  androidModels: string[];
}

/** Facts that know nothing, for a run that did not need to ask the device tools. */
export const EMPTY_DEVICE_INVENTORY: DeviceInventory = { booted: [], androidModels: [] };

/** The decision of which targets this run reads, made once by the caller. */
export interface TargetSelection {
  /** The platform this run reads, and what named it; null reads every platform. */
  platform: { value: NavigatePlatform; by: 'flag' | 'device' } | null;
  device: null;
}

/** A run that reads every target. */
export const READ_EVERY_TARGET: TargetSelection = { platform: null, device: null };

/** Where one target falls for one scope. */
export type TargetClassification =
  | { group: 'read' }
  | { group: 'other-platform'; platform: NavigatePlatform }
  | { group: 'undetermined' };

/** A target list, grouped by {@link TargetClassification}. */
export interface ClassifiedTargets {
  /** The targets this run may read. */
  read: CdpTarget[];
  /** Targets shown to be on another platform than the scope's. */
  otherPlatform: { target: CdpTarget; platform: NavigatePlatform }[];
  /** Targets whose platform nothing decided, in a platform scope. Never read. */
  undetermined: CdpTarget[];
}

function classifyTarget(
  target: Pick<CdpTarget, 'appId' | 'deviceName'>,
  targetSelection: TargetSelection,
  deviceInventory: DeviceInventory
): TargetClassification {
  if (targetSelection.platform == null) {
    return { group: 'read' };
  }
  const { platform } = platformOfTarget(target, deviceInventory);
  if (platform === targetSelection.platform.value) {
    return { group: 'read' };
  }
  return platform == null ? { group: 'undetermined' } : { group: 'other-platform', platform };
}

/**
 * Group a target list by where each target falls.
 *
 * `undetermined` is its own group rather than being folded into `read`, and that is the whole
 * point: a run that cannot tell what it is talking to must not earn a platform's verdict from it.
 */
export function classifyTargets(
  targets: CdpTarget[],
  targetSelection: TargetSelection,
  deviceInventory: DeviceInventory
): ClassifiedTargets {
  const classifiedTargets: ClassifiedTargets = { read: [], otherPlatform: [], undetermined: [] };
  for (const target of targets) {
    const classification = classifyTarget(target, targetSelection, deviceInventory);
    switch (classification.group) {
      case 'read':
        classifiedTargets.read.push(target);
        break;
      case 'other-platform':
        classifiedTargets.otherPlatform.push({ target, platform: classification.platform });
        break;
      case 'undetermined':
        classifiedTargets.undetermined.push(target);
        break;
    }
  }
  return classifiedTargets;
}

/** Whether the device tools can change where these targets fall for this scope. */
function toolsCanPlace(
  targets: readonly Pick<CdpTarget, 'appId' | 'deviceName'>[],
  _targetSelection: TargetSelection
): boolean {
  // Unscoped reads still need platform evidence for their bundle checks.
  return targets.some(
    (target) => platformOfTarget(target, EMPTY_DEVICE_INVENTORY).platform == null
  );
}

/** Ask the device tools again for a new list, when their answer can change where it falls. */
export async function refreshDeviceInventoryAsync(
  targets: readonly Pick<CdpTarget, 'appId' | 'deviceName'>[],
  targetSelection: TargetSelection,
  previous: DeviceInventory,
  timeoutMs?: number
): Promise<DeviceInventory> {
  if (!toolsCanPlace(targets, targetSelection)) {
    return previous;
  }
  const tools = await readDeviceInventoryAsync(timeoutMs);
  return { ...previous, booted: tools.booted, androidModels: tools.androidModels };
}

/** The facts needed to place this list, read only when the device tools can place it. */
export async function deviceInventoryForSelectionAsync(
  targets: readonly Pick<CdpTarget, 'appId' | 'deviceName'>[],
  targetSelection: TargetSelection
): Promise<DeviceInventory> {
  return refreshDeviceInventoryAsync(targets, targetSelection, EMPTY_DEVICE_INVENTORY);
}

/**
 * Ask this machine's device tools what is attached.
 *
 * Never throws and never fails a command: a missing `xcrun` or `adb` only costs the strongest of
 * the platform rules, and the other two still answer for Expo Go and for React Native Android.
 */
export async function readDeviceInventoryAsync(timeoutMs?: number): Promise<DeviceInventory> {
  const { parseAndroidDevices, runAdbAsync } =
    require('../device/adb') as typeof import('../device/adb');
  const { parseBootedSimulators } =
    require('../device/simulators') as typeof import('../device/simulators');
  const { spawnCaptureAsync } =
    require('../utils/spawnCapture') as typeof import('../utils/spawnCapture');

  const [simctl, adb] = await Promise.all([
    spawnCaptureAsync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { timeoutMs }).catch(
      () => null
    ),
    runAdbAsync(['devices', '-l'], { timeoutMs }).catch(() => null),
  ]);

  return {
    booted: simctl?.exitCode === 0 ? parseBootedSimulators(simctl.stdout) : [],
    androidModels:
      adb?.exitCode === 0
        ? parseAndroidDevices(adb.stdout)
            .map((device) => device.model)
            .filter((model): model is string => model != null)
        : [],
  };
}

/** Whether a new page is on a device this scope skips. */
export function isSkippedTarget(
  target: Pick<CdpTarget, 'appId' | 'deviceName'>,
  targetSelection: TargetSelection,
  deviceInventory: DeviceInventory
): boolean {
  return ['other-worktree', 'other-device'].includes(
    classifyTarget(target, targetSelection, deviceInventory).group
  );
}
