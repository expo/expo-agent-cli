// @ref llp/0005-runtime-loop-tools.rfc.md §Android
// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
// Which debugger targets one run reads, decided in one place.
//
// Three inputs, kept apart on purpose: the targets the dev server lists, the facts this machine's
// device tools report, and the run's scope, which is the caller's decision. `classifyTargets` is the
// one function that combines them, so every runtime read places a target the same way.

import type { BoundDevice } from '../deviceBinding/types';
import { liveIosBindings, type LiveIosBinding } from '../deviceBinding/records';
import { SIMCTL_TIMEOUT_MS } from '../device/simulators';
import type { NavigateDevice, NavigatePlatform } from '../navigate/device';
import type { CdpTarget } from './cdpClient';
import { onAndroidModel, platformOfTarget } from './targetPlatform';

/** What this machine's device tools report. Facts only: no decision of this run is in here. */
export interface DeviceInventory {
  /** Booted simulators of every runtime, as `xcrun simctl` reports them. */
  booted: { name: string; udid: string }[];
  /** Unknown includes an unrequested or failed lookup; unsupported means a non-macOS host. */
  bootedStatus: 'unknown' | 'observed' | 'unsupported';
  /**
   * Attached Android devices with their models, as `adb devices -l` reports them; empty when this
   * host has no `adb`, null when `adb` was not asked or failed.
   */
  androidDevices: { serial: string; model: string | null }[] | null;
  /**
   * The devices of one model that reverse this dev server's port, asked only when two attached
   * devices share the bound device's model; null when not asked or `adb` failed.
   */
  androidReverse: { port: number; serials: string[] } | null;
  /**
   * Every worktree's live local iOS binding, read only for a run in a project. A run with no
   * project root (`dev:wait`, a `navigate` wait) has no "this worktree", so it reads none.
   */
  iosBindings: LiveIosBinding[];
}

/** Facts that know nothing, for a run that did not need to ask the device tools. */
export const EMPTY_DEVICE_INVENTORY: DeviceInventory = {
  booted: [],
  bootedStatus: 'unknown',
  androidDevices: null,
  androidReverse: null,
  iosBindings: [],
};

/** The device a run reads, independent of how it was resolved. */
export type SelectedDevice =
  | { backend: 'local-ios'; udid: string; name: string }
  | { backend: 'local-android'; serial: string }
  | { backend: 'cloud'; deviceId: string | null };
export interface TargetSelection {
  platform: { value: NavigatePlatform; by: 'flag' | 'bound-device' | 'device' } | null;
  device: SelectedDevice | null;
  bound: boolean;
}
export const READ_EVERY_TARGET: TargetSelection = { platform: null, device: null, bound: false };

/** A resolved device as a scope value. */
export function selectedDeviceOf(device: NavigateDevice | BoundDevice): SelectedDevice {
  switch (device.backend) {
    case 'local-ios':
      if (!device.name)
        throw new Error('A local iOS device has no simulator name to scope reads to');
      return {
        backend: 'local-ios',
        udid: 'udid' in device ? device.udid : device.deviceId,
        name: device.name,
      };
    case 'local-android':
      return {
        backend: 'local-android',
        serial: 'serial' in device ? device.serial : device.deviceId,
      };
    case 'cloud':
      return { backend: 'cloud', deviceId: 'id' in device ? device.id : device.deviceId };
  }
}
/** The scope as a report prints it: a public shape, owned by no internal type. */
export interface ScopeJson {
  platform: NavigatePlatform | null;
  platformFrom: NonNullable<TargetSelection['platform']>['by'] | null;
  bound: boolean;
  /** `id` is the simulator udid, the adb serial or the session id; `name` only a simulator has. */
  device: { backend: SelectedDevice['backend']; id: string | null; name: string | null } | null;
}

export function scopeJson({ platform, device, bound }: TargetSelection): ScopeJson {
  return {
    platform: platform?.value ?? null,
    platformFrom: platform?.by ?? null,
    bound,
    device:
      device == null
        ? null
        : {
            backend: device.backend,
            id:
              device.backend === 'local-ios'
                ? device.udid
                : device.backend === 'local-android'
                  ? device.serial
                  : device.deviceId,
            name: device.backend === 'local-ios' ? device.name : null,
          },
  };
}

export function describeSelectedDevice(device: SelectedDevice): string {
  switch (device.backend) {
    case 'local-ios':
      return `the iOS simulator "${device.name}"`;
    case 'local-android':
      return `the Android device ${device.serial}`;
    case 'cloud':
      return device.deviceId == null
        ? 'an EAS Simulator session'
        : `the EAS Simulator session ${device.deviceId}`;
  }
}

/** Where one target falls for one scope. */
export type TargetClassification =
  | { group: 'read' }
  | { group: 'other-platform'; platform: NavigatePlatform }
  | { group: 'undetermined' }
  | { group: 'other-device' }
  | { group: 'other-worktree'; projectRoots: string[] };

export type SkippedTargetClassification = Extract<
  TargetClassification,
  { group: 'other-worktree' | 'other-device' }
>;
export type SkippedApp = { deviceName: string } & SkippedTargetClassification;

/** A target list, grouped by {@link TargetClassification}. */
export interface ClassifiedTargets {
  /** The targets this run may read. */
  read: CdpTarget[];
  /** Targets shown to be on another platform than the scope's. */
  otherPlatform: { target: CdpTarget; platform: NavigatePlatform }[];
  /** Targets nothing placed in this scope: no platform evidence, or no device claim. Never read. */
  undetermined: CdpTarget[];
  skipped: { target: CdpTarget; classification: SkippedTargetClassification }[];
}

/** The skipped targets of a placed list, as a report names them. */
export function skippedAppsOf(classifiedTargets: Pick<ClassifiedTargets, 'skipped'>): SkippedApp[] {
  return classifiedTargets.skipped.map(({ target, classification }) => ({
    deviceName: target.deviceName,
    ...classification,
  }));
}

/** The one sentence every report, refusal and stderr line uses to name the skipped apps. */
export function describeSkippedApps(apps: readonly SkippedApp[]): string {
  const each = apps.map((app) => {
    switch (app.group) {
      case 'other-device':
        return `"${app.deviceName}" is not the device this run reads`;
      case 'other-worktree':
        return `"${app.deviceName}" runs on a simulator another worktree bound (${app.projectRoots.join(', ')})`;
    }
  });
  return `Skipped ${apps.length} app${apps.length === 1 ? '' : 's'}: ${each.join('; ')}.`;
}

/**
 * The other worktrees whose simulator this target runs on, or null when it may be this one's.
 *
 * A target names its device by name only. So it is another worktree's only when every booted
 * simulator with that name has a udid that only other worktrees bind. A name nothing booted has,
 * or a simulator nobody or this worktree binds, keeps the target. When the simulator list could
 * not be read, a binding's stored name stands in for it: a name that only other worktrees' bindings
 * hold is skipped. A stale stored name can only skip more.
 */
function otherWorktreesOf(
  target: Pick<CdpTarget, 'deviceName'>,
  deviceInventory: DeviceInventory
): string[] | null {
  if (deviceInventory.bootedStatus === 'unknown') {
    const owners = deviceInventory.iosBindings.filter(
      (binding) => binding.name === target.deviceName
    );
    return owners.length > 0 && !owners.some((binding) => binding.own)
      ? [...new Set(owners.map((binding) => binding.projectRoot))]
      : null;
  }
  const booted = deviceInventory.booted.filter((simulator) => simulator.name === target.deviceName);
  const roots = new Set<string>();
  for (const { udid } of booted) {
    const owners = deviceInventory.iosBindings.filter((binding) => binding.udid === udid);
    if (owners.length === 0 || owners.some((binding) => binding.own)) {
      return null;
    }
    owners.forEach((binding) => roots.add(binding.projectRoot));
  }
  return roots.size > 0 ? [...roots] : null;
}

/** Whether a device tool whose answer can place a target in this scope gave no answer. */
export function scopeToolsUnknown(
  targetSelection: TargetSelection,
  deviceInventory: DeviceInventory
): boolean {
  const platform = targetSelection.platform?.value;
  return (
    (platform !== 'android' && deviceInventory.bootedStatus === 'unknown') ||
    (platform !== 'ios' && deviceInventory.androidDevices == null)
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
    (deviceInventory.androidDevices ?? []).some(
      (device) => device.model != null && onAndroidModel(deviceName, device.model)
    )
  );
}

/** Whether a target looks Android while `adb` gave no answer, so it may be a local emulator. */
function androidUnproven(
  target: Pick<CdpTarget, 'appId' | 'deviceName'>,
  deviceInventory: DeviceInventory
): boolean {
  return (
    deviceInventory.androidDevices == null &&
    platformOfTarget(target, deviceInventory).platform === 'android'
  );
}

function classifyTarget(
  target: Pick<CdpTarget, 'appId' | 'deviceName'>,
  targetSelection: TargetSelection,
  deviceInventory: DeviceInventory
): TargetClassification {
  const projectRoots = otherWorktreesOf(target, deviceInventory);
  if (projectRoots != null) {
    return { group: 'other-worktree', projectRoots };
  }
  const { platform } = platformOfTarget(target, deviceInventory);
  if (
    targetSelection.platform != null &&
    platform != null &&
    platform !== targetSelection.platform.value
  )
    return { group: 'other-platform', platform };
  if (targetSelection.device?.backend === 'local-ios') {
    return target.deviceName === targetSelection.device.name
      ? { group: 'read' }
      : { group: 'other-device' };
  }
  if (targetSelection.device?.backend === 'local-android') {
    return placeOnAndroidDevice(target, targetSelection.device.serial, deviceInventory);
  }
  if (targetSelection.device?.backend === 'cloud') {
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
 * A React Native Android target names its device `<model> - <release> - API <n>`, so the model is
 * all it says. It is on the bound device when no other attached device has that model, or when
 * the bound device is the only one of that model that reverses this dev server's port.
 */
function placeOnAndroidDevice(
  target: Pick<CdpTarget, 'deviceName'>,
  serial: string,
  deviceInventory: DeviceInventory
): TargetClassification {
  const devices = deviceInventory.androidDevices;
  if (devices == null) return { group: 'undetermined' };
  const bound = devices.find((device) => device.serial === serial);
  if (bound == null) return { group: 'other-device' };
  if (bound.model == null) return { group: 'undetermined' };
  const { model } = bound;
  if (!onAndroidModel(target.deviceName, model)) return { group: 'other-device' };
  if (devices.filter((device) => device.model === model).length === 1) return { group: 'read' };
  const reverse = deviceInventory.androidReverse?.serials;
  return reverse?.length === 1 && reverse[0] === serial
    ? { group: 'read' }
    : { group: 'undetermined' };
}

/** The attached devices that share the bound device's model, when there are two or more. */
export function androidModelTwins(
  targetSelection: TargetSelection,
  deviceInventory: DeviceInventory
): { serial: string; model: string; twins: string[] } | null {
  if (targetSelection.device?.backend !== 'local-android') return null;
  const { serial } = targetSelection.device;
  const model = deviceInventory.androidDevices?.find((device) => device.serial === serial)?.model;
  const twins = (deviceInventory.androidDevices ?? [])
    .filter((device) => model != null && device.model === model)
    .map((device) => device.serial);
  return model != null && twins.length > 1 ? { serial, model, twins } : null;
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
 * development build's app id is often the same on both platforms. The run named the session, or this
 * worktree bound it, so the one target nothing on this machine claims is its app, provided the
 * scope's device tools answered or this host cannot run them. A failed inspection cannot establish
 * absence, so an Android-shaped target stays undetermined while `adb` gave no answer. Two such
 * targets stay undetermined: nothing says which one is the session's. An Android
 * session needs no rule, because its device name shape places it. A target on another worktree's
 * simulator is skipped in every scope, so it never takes that slot.
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
      case 'undetermined':
        classifiedTargets.undetermined.push(target);
        break;
      case 'other-worktree':
      case 'other-device':
        classifiedTargets.skipped.push({ target, classification });
        break;
    }
  }
  const [only, ...more] = classifiedTargets.undetermined;
  // An Android session's own target has React Native Android's name shape, so an unplaced one is
  // never it.
  if (
    targetSelection.device?.backend === 'cloud' &&
    targetSelection.platform?.value !== 'android' &&
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
  targetSelection: TargetSelection,
  deviceInventory: DeviceInventory
): boolean {
  // Unscoped reads still need platform evidence for their bundle checks. A binding's stored
  // display name can be stale, so a foreign binding needs the current name-to-UDID mapping.
  return (
    (targetSelection.platform?.value !== 'android' &&
      deviceInventory.iosBindings.some((binding) => !binding.own)) ||
    targetSelection.device?.backend === 'local-android' ||
    (targetSelection.device?.backend === 'cloud' && targets.length > 0) ||
    targets.some(
      (target) =>
        !(
          targetSelection.device?.backend === 'local-ios' &&
          target.deviceName === targetSelection.device.name
        ) && platformOfTarget(target, EMPTY_DEVICE_INVENTORY).platform == null
    )
  );
}

/**
 * Ask the device tools again for a new list, when their answer can change where it falls. Twins of
 * the bound Android model are asked what they reverse of the dev server's port, as the first read
 * does: a twin that attached since then decides whether the own app is placed.
 */
export async function refreshDeviceInventoryAsync(
  targets: readonly Pick<CdpTarget, 'appId' | 'deviceName'>[],
  targetSelection: TargetSelection,
  previous: DeviceInventory,
  devServerUrl: string | null,
  timeoutMs?: number
): Promise<DeviceInventory> {
  if (!toolsCanPlace(targets, targetSelection, previous)) {
    return previous;
  }
  const tools = await readDeviceInventoryAsync(timeoutMs);
  const inventory = {
    ...previous,
    booted: tools.booted,
    bootedStatus: tools.bootedStatus,
    androidDevices: tools.androidDevices,
  };
  const twins = androidModelTwins(targetSelection, inventory);
  const port = devServerUrl == null ? null : devServerPort(devServerUrl);
  const androidReverse =
    twins && port != null ? await readAndroidReverseAsync(twins.twins, port) : null;
  return { ...inventory, androidReverse };
}

/** Read bindings and ask the tools only when their answer can change placement. */
export async function deviceInventoryForSelectionAsync(
  targets: readonly Pick<CdpTarget, 'appId' | 'deviceName'>[],
  targetSelection: TargetSelection,
  projectRoot: string | null,
  devServerUrl: string | null = null,
  timeoutMs: number = SIMCTL_TIMEOUT_MS
): Promise<DeviceInventory> {
  const iosBindings = projectRoot == null ? [] : liveIosBindings(projectRoot);
  return await refreshDeviceInventoryAsync(
    targets,
    targetSelection,
    { ...EMPTY_DEVICE_INVENTORY, iosBindings },
    devServerUrl,
    timeoutMs
  );
}

function devServerPort(devServerUrl: string): number | null {
  try {
    const url = new URL(devServerUrl);
    return url.port ? Number(url.port) : null;
  } catch {
    return null;
  }
}

/**
 * Which of `serials` reverse `port` to the host, once per run: `adb -s <serial> reverse --list` on
 * each. Null when one of them could not be asked, because a missing answer cannot rule a device out.
 */
async function readAndroidReverseAsync(
  serials: string[],
  port: number
): Promise<DeviceInventory['androidReverse']> {
  const { parseReverseList, runAdbAsync } =
    require('../device/adb') as typeof import('../device/adb');
  const answers = await Promise.all(
    serials.map((serial) => runAdbAsync(['-s', serial, 'reverse', '--list']).catch(() => null))
  );
  if (answers.some((answer) => answer?.exitCode !== 0)) return null;
  return {
    port,
    serials: serials.filter((_, index) =>
      parseReverseList(answers[index]!.stdout).some((entry) => entry.host === `tcp:${port}`)
    ),
  };
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
  // No `adb` means no Android device this host drives, which is an answer, not an unknown.
  const androidDevices =
    adb?.exitCode === 0
      ? parseAndroidDevices(adb.stdout).map(({ deviceId, model }) => ({ serial: deviceId, model }))
      : adb?.notRunnable
        ? []
        : null;
  return {
    ...EMPTY_DEVICE_INVENTORY,
    booted: booted ?? [],
    bootedStatus:
      booted != null ? 'observed' : process.platform === 'darwin' ? 'unknown' : 'unsupported',
    androidDevices,
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
