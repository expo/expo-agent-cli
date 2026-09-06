// @ref llp/0004-smart-start-and-project-state.rfc.md §Decision table
// Whether this project's development build is already on the device the run would open it on.
//
// The gap this closes: a fingerprint that matches the recorded build proves the *build* is current
// and says nothing about where it is. `dev` read that as "there is nothing to do but serve", so a
// project whose build was recorded on this machine — and then wiped with the simulator, or never
// installed because the build came from EAS — got a dev server and no app to answer it. The plan
// was right about the build and wrong about the run.
//
// **`unknown` keeps the old plan, and that is the whole of the safety story here.** The two wrong
// answers do not cost the same. A false `missing` spends a minute on an install nobody needed; a
// false `present` leaves a dev server serving nothing, which is the bug above. But `unknown` is not
// a third cost — it is the state this CLI was already in on every run before this module existed,
// so falling back to it can only ever plan what it planned yesterday. That makes every probe below
// free to give up: no device, no app id, a tool that would not run, a platform this host cannot
// ask about. None of them are failures.

import type { NativePlatform } from '../plan/types';
import { readConfiguredAppId } from '../runtime/appId';
import { androidHasAppAsync } from './androidApps';
import { simulatorHasAppAsync } from './installedApps';
import { probeLocalDeviceAsync, type LocalDeviceProbe } from './localDevice';

/** Whether the development build is on the device, as far as this machine can be asked. */
export type AppPresence =
  /** The device was asked and has it. */
  | 'present'
  /** The device was asked and has not got it. The one answer that changes a plan. */
  | 'missing'
  /** Nothing was established, so the plan is the one that was made before this was asked. */
  | 'unknown';

export interface ProbeAppPresenceOptions {
  /** Injected for tests. Defaults to the process-cached probe every other caller shares. */
  probeDeviceAsync?: () => Promise<LocalDeviceProbe>;
  /** Injected for tests. */
  readAppId?: typeof readConfiguredAppId;
  /** Injected for tests. */
  simulatorHasApp?: typeof simulatorHasAppAsync;
  /** Injected for tests. */
  androidHasApp?: typeof androidHasAppAsync;
}

/**
 * Whether the development build of this project is installed on a device this machine has.
 *
 * The device is the one the run would open the app on: the first the local probe found for this
 * platform, which is the same choice `navigate` and `smoke` make. A machine with no device for the
 * platform answers `unknown` rather than `missing` — nothing was asked, and `expo start` boots one
 * itself, so a plan is in no position to claim the app is not on a device that does not exist yet.
 *
 * Never throws. Every failure below is an `unknown`.
 */
export async function probeAppPresenceAsync(
  projectRoot: string,
  platform: NativePlatform,
  {
    probeDeviceAsync = probeLocalDeviceAsync,
    readAppId = readConfiguredAppId,
    simulatorHasApp = simulatorHasAppAsync,
    androidHasApp = androidHasAppAsync,
  }: ProbeAppPresenceOptions = {}
): Promise<AppPresence> {
  try {
    // The app id first, because it is a file read and the device probe is two subprocesses. A
    // project whose config names no `bundleIdentifier` cannot be looked for under any name, and
    // asking a device about the Expo Go id instead would answer about a different app entirely.
    const appId = readAppId(projectRoot, platform);
    if (appId == null) {
      return 'unknown';
    }

    const probe = await probeDeviceAsync();
    const device = probe.devices.find((candidate) => candidate.platform === platform);
    if (device == null) {
      return 'unknown';
    }

    if (platform === 'ios') {
      return (await simulatorHasApp(device.deviceId, appId)) ? 'present' : 'missing';
    }

    // Android's probe is three-valued on purpose (@ref ./androidApps): a device that is offline or
    // a shell that would not run is a lookup that did not happen, not an app that is not there.
    const installed = await androidHasApp(device.deviceId, appId, device.adb ? { adb: device.adb } : {});
    return installed == null ? 'unknown' : installed ? 'present' : 'missing';
  } catch {
    // A probe is not allowed to be the thing that fails `dev`.
    return 'unknown';
  }
}
