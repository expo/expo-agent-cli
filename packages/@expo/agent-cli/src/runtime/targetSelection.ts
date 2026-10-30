// @ref llp/0005-runtime-loop-tools.rfc.md §Android
// Which debugger targets one run reads, decided in one place.
//
// Three inputs, kept apart on purpose: the targets the dev server lists, the facts this machine's
// device tools report, and the run's scope, which is the caller's decision. `classifyTargets` is the
// one function that combines them, so every runtime read places a target the same way.

import type { NavigateDevice, NavigatePlatform } from '../navigate/device';
import type { CdpTarget } from './cdpClient';
import { platformOfTarget } from './targetPlatform';

/** What this machine's device tools report. Facts only: no decision of this run is in here. */
export interface DeviceInventory {
  /** Booted simulators of every runtime, as `xcrun simctl` reports them. */
  booted: { name: string; udid: string }[];
  /** Unknown includes an unrequested or failed lookup; unsupported means a non-macOS host. */
  bootedStatus: 'unknown' | 'observed' | 'unsupported';
  /** Hardware models of attached Android devices, as `adb devices -l` reports them; null when it did not exit 0. */
  androidModels: string[] | null;
}

/** Facts that know nothing, for a run that did not need to ask the device tools. */
export const EMPTY_DEVICE_INVENTORY: DeviceInventory = {
  booted: [],
  bootedStatus: 'unknown',
  androidModels: null,
};

export type SelectedDevice = { backend: 'cloud'; deviceId: string | null };
export function selectedDeviceOf(device: NavigateDevice): SelectedDevice | null {
  return device.backend === 'cloud' ? { backend: 'cloud', deviceId: device.deviceId } : null;
}

/** The decision of which targets this run reads, made once by the caller. */
export interface TargetSelection {
  /** The platform this run reads, and what named it; null reads every platform. */
  platform: { value: NavigatePlatform; by: 'flag' | 'device' } | null;
  device: SelectedDevice | null;
}

/** A run that reads every target. */
export const READ_EVERY_TARGET: TargetSelection = { platform: null, device: null };

/** Where one target falls for one scope. */
export type TargetClassification =
  | { group: 'read' }
  | { group: 'other-platform'; platform: NavigatePlatform }
  | { group: 'undetermined' }
  | { group: 'other-device' };

/** A target list, grouped by {@link TargetClassification}. */
export interface ClassifiedTargets {
  /** The targets this run may read. */
  read: CdpTarget[];
  /** Targets shown to be on another platform than the scope's. */
  otherPlatform: { target: CdpTarget; platform: NavigatePlatform }[];
  /** Targets nothing placed in this scope: no platform evidence, or no device claim. Never read. */
  undetermined: CdpTarget[];
  skipped: {
    target: CdpTarget;
    classification: Extract<TargetClassification, { group: 'other-device' }>;
  }[];
}

/** Whether a device tool whose answer can place a target in this scope gave no answer. */
export function scopeToolsUnknown(
  targetSelection: TargetSelection,
  deviceInventory: DeviceInventory
): boolean {
  return (
    targetSelection.platform?.value !== 'android' && deviceInventory.bootedStatus === 'unknown'
  );
}

/** Whether the cloud placement rule decides this scope. An Android session's names place it. */
function isCloudScope(targetSelection: TargetSelection): boolean {
  return (
    targetSelection.device?.backend === 'cloud' && targetSelection.platform?.value !== 'android'
  );
}

/** Whether a local device tool names this target's device: a booted simulator or an attached model. */
function claimedLocally(
  target: Pick<CdpTarget, 'appId' | 'deviceName'>,
  deviceInventory: DeviceInventory
): boolean {
  const deviceName = typeof target.deviceName === 'string' ? target.deviceName : '';
  return (
    deviceInventory.booted.some((simulator) => simulator.name === deviceName) ||
    (deviceInventory.androidModels ?? []).some(
      (model) => model === deviceName || deviceName.startsWith(`${model} - `)
    )
  );
}

/** Whether a target looks Android while `adb` gave no answer, so it may be a local emulator. */
function androidUnproven(
  target: Pick<CdpTarget, 'appId' | 'deviceName'>,
  deviceInventory: DeviceInventory
): boolean {
  return (
    deviceInventory.androidModels == null &&
    platformOfTarget(target, deviceInventory).platform === 'android'
  );
}

function classifyTarget(
  target: Pick<CdpTarget, 'appId' | 'deviceName'>,
  targetSelection: TargetSelection,
  deviceInventory: DeviceInventory
): TargetClassification {
  const { platform } = platformOfTarget(target, deviceInventory);
  if (
    targetSelection.platform != null &&
    platform != null &&
    platform !== targetSelection.platform.value
  )
    return { group: 'other-platform', platform };
  if (isCloudScope(targetSelection)) {
    // A cloud scope reads no target a local device tool claims. An app id says nothing about which
    // device runs it, so only an answered tool can show that no local device does.
    if (claimedLocally(target, deviceInventory)) return { group: 'other-device' };
    if (
      scopeToolsUnknown(targetSelection, deviceInventory) ||
      androidUnproven(target, deviceInventory)
    )
      return { group: 'undetermined' };
    return platform == null ? { group: 'undetermined' } : { group: 'read' };
  }
  return targetSelection.platform != null && platform == null
    ? { group: 'undetermined' }
    : { group: 'read' };
}

/**
 * Group a target list by where each target falls.
 *
 * `undetermined` is its own group rather than being folded into `read`, and that is the whole
 * point: a run that cannot tell what it is talking to must not earn a platform's verdict from it.
 *
 * One rule needs the whole list, so it lives here and not in `platformOfTarget`: on an EAS
 * Simulator session, with or without a platform flag, exactly one undetermined target is the
 * session's app. Its device name is the cloud simulator's model, which no local tool reports, and a
 * development build's app id is often the same on both platforms. The run named the session, so the
 * one target nothing on this machine claims is its app, provided the scope's device tools answered
 * or this host cannot run them. A failed inspection cannot establish absence, so an Android-shaped target stays undetermined while `adb` gave no answer. Two such targets stay
 * undetermined: nothing says which one is the session's. An Android session needs no rule,
 * because its device name shape places it.
 */
export function classifyTargets(
  targets: CdpTarget[],
  targetSelection: TargetSelection,
  deviceInventory: DeviceInventory
): ClassifiedTargets {
  const classifiedTargets: ClassifiedTargets = {
    read: [],
    otherPlatform: [],
    undetermined: [],
    skipped: [],
  };
  for (const target of targets) {
    const classification = classifyTarget(target, targetSelection, deviceInventory);
    switch (classification.group) {
      case 'read':
        classifiedTargets.read.push(target);
        break;
      case 'other-platform':
        classifiedTargets.otherPlatform.push({ target, platform: classification.platform });
        break;
      case 'other-device':
        classifiedTargets.skipped.push({ target, classification });
        break;
      case 'undetermined':
        classifiedTargets.undetermined.push(target);
        break;
    }
  }
  const [only, ...more] = classifiedTargets.undetermined;
  if (
    isCloudScope(targetSelection) &&
    !scopeToolsUnknown(targetSelection, deviceInventory) &&
    only &&
    !more.length &&
    !androidUnproven(only, deviceInventory) &&
    (targetSelection.platform != null || classifiedTargets.read.length === 0)
  ) {
    return {
      ...classifiedTargets,
      read: targets.filter((target) => target === only || classifiedTargets.read.includes(target)),
      undetermined: [],
    };
  }
  return classifiedTargets;
}

/** Whether the device tools can change where these targets fall for this scope. */
function toolsCanPlace(
  targets: readonly Pick<CdpTarget, 'appId' | 'deviceName'>[],
  targetSelection: TargetSelection
): boolean {
  // Unscoped reads still need platform evidence for their bundle checks.
  return (
    (isCloudScope(targetSelection) && targets.length > 0) ||
    targets.some((target) => platformOfTarget(target, EMPTY_DEVICE_INVENTORY).platform == null)
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
  return {
    ...previous,
    booted: tools.booted,
    bootedStatus: tools.bootedStatus,
    androidModels: tools.androidModels,
  };
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
 * Tool failures leave their evidence unknown. Expo Go ids and React Native Android names still
 * supply platform evidence, but a failed simulator lookup cannot justify cloud attribution.
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

  const booted = simctl?.exitCode === 0 ? parseBootedSimulators(simctl.stdout) : null;
  return {
    booted: booted ?? [],
    bootedStatus:
      booted != null ? 'observed' : process.platform === 'darwin' ? 'unknown' : 'unsupported',
    androidModels:
      adb?.exitCode === 0
        ? parseAndroidDevices(adb.stdout)
            .map((device) => device.model)
            .filter((model): model is string => model != null)
        : null,
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
