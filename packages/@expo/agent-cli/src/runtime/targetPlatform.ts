// @ref llp/0005-runtime-loop-tools.rfc.md §Android
// Which platform one debugger target is running on.
//
// `--android` used to scope the *device* commands and nothing else: the deep link went to the
// emulator, and every reading command then took whatever `/json/list` happened to name first. With
// an iOS simulator and an Android emulator both attached to one dev server, `smoke --android`
// opened the app on the emulator and earned its `passed` from the **iOS** runtime
// [observed — friction run 6 (Android), 2026-08-24]. A verdict about Android that an iOS runtime
// answered is worse than no verdict.
//
// **The dev server does not label the platform.** Two live targets, captured side by side on one
// dev server [observed — 2026-08-25, notesapp on SDK 57, port 8250]:
//
// ```json
// { "appId": "host.exp.Exponent", "deviceName": "iPhone 17 Pro",
//   "title": "host.exp.Exponent (iPhone 17 Pro)", "description": "React Native Bridgeless [C++ connection]" }
// { "appId": "host.exp.exponent", "deviceName": "sdk_gphone64_arm64 - 15 - API 35",
//   "title": "host.exp.exponent (Google sdk_gphone64_arm64)", "description": "React Native Bridgeless [C++ connection]" }
// ```
//
// `type`, `description` and the `reactNative` block are identical. What differs is `deviceName`,
// and `appId` by one capital letter. So the platform is *inferred*, in this order, strongest first:
//
//  1. **The device name is one this machine's device tools just named.** A booted simulator is
//     called `iPhone 17 Pro` by `simctl`, and an attached emulator is `model:sdk_gphone64_arm64` in
//     `adb devices -l`. This is evidence rather than a pattern: the name came from the same device
//     the command is about to drive.
//  2. **The device name has React Native Android's shape.** `AndroidInfoHelpers.getFriendlyDeviceName`
//     builds `<Build.MODEL> - <release> - API <sdk>`, which is where the ` - 15 - API 35` above
//     comes from. Nothing on iOS produces it.
//  3. **The app id is Expo Go's, and the two platforms spell it differently.** `host.exp.Exponent`
//     is the iOS bundle id and `host.exp.exponent` the Android package. A one-capital difference is
//     thin evidence, which is why it is last — and it only ever fires for Expo Go.
//
// When none of them fires the answer is `null`, and `null` is never quietly folded into either
// platform: a caller that cannot tell says so.

import type { NavigatePlatform } from '../navigate/device';
import type { CdpTarget } from './cdpClient';
import type { DeviceFacts } from './runScope';

/** Expo Go's application id, which differs between the platforms by one capital letter. */
const EXPO_GO_IOS_APP_ID = 'host.exp.Exponent';
const EXPO_GO_ANDROID_APP_ID = 'host.exp.exponent';

/**
 * React Native Android's device name: `<model> - <release> - API <sdk>`
 * [`AndroidInfoHelpers.getFriendlyDeviceName`].
 */
const ANDROID_FRIENDLY_DEVICE_NAME = / - .+ - API \d+$/;

export interface TargetPlatformVerdict {
  /** The platform this target runs on, or null when nothing decided it. */
  platform: NavigatePlatform | null;
  /** One clause naming what decided it, for a report that has to justify a verdict. */
  evidence: string;
}

/**
 * Work out which platform one debugger target is running on.
 *
 * @param facts what this machine's device tools reported, or nothing when they were not asked. The
 * last two rules need no facts at all, so a machine with no `adb` still tells an Expo Go Android
 * target apart from an iOS one.
 */
export function platformOfTarget(
  target: Pick<CdpTarget, 'appId' | 'deviceName'>,
  facts?: DeviceFacts
): TargetPlatformVerdict {
  const deviceName = typeof target.deviceName === 'string' ? target.deviceName : '';

  if (deviceName && facts?.booted.some((simulator) => simulator.name === deviceName)) {
    return {
      platform: 'ios',
      evidence: `its device name "${deviceName}" is a booted iOS simulator`,
    };
  }

  const model = facts?.androidModels.find(
    (candidate) => candidate === deviceName || deviceName.startsWith(`${candidate} - `)
  );
  if (model) {
    return {
      platform: 'android',
      evidence: `its device name "${deviceName}" is the model of the attached Android device "${model}"`,
    };
  }

  if (ANDROID_FRIENDLY_DEVICE_NAME.test(deviceName)) {
    return {
      platform: 'android',
      evidence: `its device name "${deviceName}" has React Native Android's "<model> - <release> - API <sdk>" shape`,
    };
  }

  if (target.appId === EXPO_GO_IOS_APP_ID) {
    return {
      platform: 'ios',
      evidence: `its app id is Expo Go's iOS bundle id (${EXPO_GO_IOS_APP_ID})`,
    };
  }
  if (target.appId === EXPO_GO_ANDROID_APP_ID) {
    return {
      platform: 'android',
      evidence: `its app id is Expo Go's Android package (${EXPO_GO_ANDROID_APP_ID})`,
    };
  }

  return {
    platform: null,
    evidence: `nothing in the target names a platform: app id "${target.appId ?? ''}", device name "${deviceName}"`,
  };
}

/**
 * The platforms a set of targets is running on, and whether any of them could not be read.
 *
 * What a command with **no** platform flag uses to find out what it is looking at — which is how
 * `runtime:reload` stopped checking an iOS bundle for an Android-only app (F53).
 */
export function platformsOfTargets(
  targets: CdpTarget[],
  facts?: DeviceFacts
): { platforms: NavigatePlatform[]; undetermined: number } {
  const platforms: NavigatePlatform[] = [];
  let undetermined = 0;
  for (const target of targets) {
    const { platform } = platformOfTarget(target, facts);
    if (platform == null) {
      undetermined += 1;
    } else if (!platforms.includes(platform)) {
      platforms.push(platform);
    }
  }
  return { platforms, undetermined };
}
