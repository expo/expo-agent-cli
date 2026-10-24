// @ref llp/0005-runtime-loop-tools.rfc.md §Android
// Which debugger targets one run reads, decided in one place.
//
// Three inputs, kept apart on purpose: the targets the dev server lists, the facts this machine's
// device tools report, and the run's scope, which is the caller's decision. `placeTargets` is the
// one function that combines them, so every runtime read places a target the same way.

import type { NavigatePlatform } from '../navigate/device';
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
  device: { kind: 'any' };
}

/** The scope a command with only a platform flag has: that platform, or every platform. */
export function scopeOfPlatformFlag(platform: NavigatePlatform | null | undefined): RunScope {
  return {
    platform: platform == null ? null : { value: platform, by: 'flag' },
    device: { kind: 'any' },
  };
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

export function placeTarget(
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
