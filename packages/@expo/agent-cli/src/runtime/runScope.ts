// @ref llp/0005-runtime-loop-tools.rfc.md §Android
// Which debugger targets one run reads, decided in one place.
//
// Three inputs, kept apart on purpose: the targets the dev server lists, the facts this machine's
// device tools report, and the run's scope, which is the caller's decision. `placeTargets` is the
// one function that combines them, so every runtime read places a target the same way.

import type { NavigateDevice, NavigatePlatform } from '../navigate/device';
import type { CdpTarget } from './cdpClient';
import { platformOfTarget } from './targetPlatform';

/** What this machine's device tools report. Facts only: no decision of this run is in here. */
export interface DeviceFacts {
  /** Booted simulators of every runtime, as `xcrun simctl` reports them. */
  booted: { name: string; udid: string }[];
  /** Hardware models of attached Android devices, as `adb devices -l` reports them. */
  androidModels: string[];
}

/** Facts that know nothing, for a run that did not need to ask the device tools. */
export const NO_DEVICE_FACTS: DeviceFacts = { booted: [], androidModels: [] };

/** The decision of which targets this run reads, made once by the caller. */
export interface RunScope {
  /** The platform this run reads, and what named it; null reads every platform. */
  platform: { value: NavigatePlatform; by: 'flag' } | null;
  /**
   * The device this run reads. `eas-flag` is a run with `--eas` and a platform, or a `navigate`
   * that resolved to an EAS Simulator session: the session of that platform is the device.
   */
  device: { kind: 'any' } | { kind: 'eas-flag' };
}

/** The scope a command's flags give: the platform flag, and `--eas` when a platform names a session. */
export function scopeOfFlags({
  platform,
  eas,
}: {
  platform: NavigatePlatform | null | undefined;
  eas: boolean;
}): RunScope {
  if (platform == null) {
    return { platform: null, device: { kind: 'any' } };
  }
  return { platform: { value: platform, by: 'flag' }, device: { kind: eas ? 'eas-flag' : 'any' } };
}

/** The scope of a device a run already resolved: a cloud device is the EAS Simulator session. */
export function scopeOfDevice(device: Pick<NavigateDevice, 'backend' | 'platform'>): RunScope {
  return scopeOfFlags({ platform: device.platform, eas: device.backend === 'cloud' });
}

/** Where one target falls for one scope. */
export type Placement =
  | { group: 'read' }
  | { group: 'other-platform'; platform: NavigatePlatform }
  | { group: 'undetermined' };

/** A target list, grouped by {@link Placement}. */
export interface PlacedTargets {
  /** The targets this run may read. */
  read: CdpTarget[];
  /** Targets shown to be on another platform than the scope's. */
  otherPlatform: { target: CdpTarget; platform: NavigatePlatform }[];
  /** Targets whose platform nothing decided, in a platform scope. Never read. */
  undetermined: CdpTarget[];
}

function placeTarget(
  target: Pick<CdpTarget, 'appId' | 'deviceName'>,
  scope: RunScope,
  facts: DeviceFacts
): Placement {
  if (scope.platform == null) {
    return { group: 'read' };
  }
  const { platform } = platformOfTarget(target, facts);
  if (platform === scope.platform.value) {
    return { group: 'read' };
  }
  return platform == null ? { group: 'undetermined' } : { group: 'other-platform', platform };
}

/**
 * Group a target list by where each target falls.
 *
 * `undetermined` is its own group rather than being folded into `read`, and that is the whole
 * point: a run that cannot tell what it is talking to must not earn a platform's verdict from it.
 *
 * One rule needs the whole list, so it lives here and not in `platformOfTarget`: on an EAS
 * Simulator iOS session, exactly one undetermined target is the session's app. Its device name is
 * the cloud simulator's model, which no local tool reports, and a development build's app id is
 * often the same on both platforms. The run named the session, so the one target nothing on this
 * machine claims is its app. Two such targets stay undetermined: nothing says which one is the
 * session's. An Android session needs no rule, because its device name shape places it.
 */
export function placeTargets(
  targets: CdpTarget[],
  scope: RunScope,
  facts: DeviceFacts
): PlacedTargets {
  const placed: PlacedTargets = { read: [], otherPlatform: [], undetermined: [] };
  for (const target of targets) {
    const placement = placeTarget(target, scope, facts);
    switch (placement.group) {
      case 'read':
        placed.read.push(target);
        break;
      case 'other-platform':
        placed.otherPlatform.push({ target, platform: placement.platform });
        break;
      case 'undetermined':
        placed.undetermined.push(target);
        break;
    }
  }
  const [only, ...more] = placed.undetermined;
  if (scope.device.kind === 'eas-flag' && scope.platform?.value === 'ios' && only && !more.length) {
    return {
      ...placed,
      read: targets.filter((target) => target === only || placed.read.includes(target)),
      undetermined: [],
    };
  }
  return placed;
}

/**
 * The facts a scope needs to place these targets, asking the device tools only when their answer
 * could change a placement.
 *
 * A scope with no platform reads every target, so it needs no facts at all.
 */
export async function deviceFactsForScopeAsync(
  targets: readonly Pick<CdpTarget, 'appId' | 'deviceName'>[],
  scope: RunScope
): Promise<DeviceFacts> {
  return scope.platform == null ? NO_DEVICE_FACTS : await deviceFactsIfNeededAsync(targets);
}

/**
 * The device facts, but only when the fact-free rules cannot place every target.
 *
 * Two subprocesses are cheap and not free, and Expo Go — the case nearly every one of these
 * commands runs against — is placed by its app id alone. So the tools are spawned exactly when
 * their answer could change the outcome: a development build whose device name and app id say
 * nothing `platformOfTarget` recognises.
 */
export async function deviceFactsIfNeededAsync(
  targets: readonly Pick<CdpTarget, 'appId' | 'deviceName'>[]
): Promise<DeviceFacts> {
  const undetermined = targets.some(
    (target) => platformOfTarget(target, NO_DEVICE_FACTS).platform == null
  );
  return undetermined ? await readDeviceFactsAsync() : NO_DEVICE_FACTS;
}

/**
 * Ask this machine's device tools what is attached.
 *
 * Never throws and never fails a command: a missing `xcrun` or `adb` only costs the strongest of
 * the platform rules, and the other two still answer for Expo Go and for React Native Android.
 */
export async function readDeviceFactsAsync(): Promise<DeviceFacts> {
  const { parseAndroidDevices, runAdbAsync } =
    require('../device/adb') as typeof import('../device/adb');
  const { parseBootedSimulators } =
    require('../device/simulators') as typeof import('../device/simulators');
  const { spawnCaptureAsync } =
    require('../utils/spawnCapture') as typeof import('../utils/spawnCapture');

  const [simctl, adb] = await Promise.all([
    spawnCaptureAsync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']).catch(() => null),
    runAdbAsync(['devices', '-l']).catch(() => null),
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
