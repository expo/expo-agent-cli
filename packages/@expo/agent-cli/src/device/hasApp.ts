// @ref llp/0005-runtime-loop-tools.rfc.md §The gate installs the app, whichever app it is
// Whether one device has one app, across the two platforms and their different failure shapes.
//
// Extracted from `smoke` when the plan engine grew the same question (llp/0004 §A current build is
// not an installed app). The comment that came with it still holds: a platform switch copied into
// each caller is a switch that drifts, and it had already drifted once — the install decision asked
// Android for *Expo Go's* application id whatever the project's app was.
//
// Three-valued on purpose. `null` is "could not look", and it must never collapse into `false`:
// the callers of `false` install something, and a failed lookup is not a licence to spend minutes
// doing that.

import type { DeviceBackend } from '../navigate/device';
import { androidHasAppAsync } from './androidApps';
import { simulatorDiskExistsAsync, simulatorHasAppAsync } from './installedApps';

/**
 * Whether the device has the app, or `null` when nothing could be read.
 *
 * @param backend which platform tool can answer for this device. A cloud session's device is not
 *   this machine's, so nothing here can read it (llp/0005 §Cloud simulator) — that is `null` too.
 */
export async function hasAppOnDeviceAsync(
  deviceId: string,
  backend: DeviceBackend | null,
  appId: string
): Promise<boolean | null> {
  if (backend === 'local-android') {
    return await androidHasAppAsync(deviceId, appId);
  }
  if (backend !== 'local-ios') {
    return null;
  }
  // @ref ./installedApps §simulatorDiskExistsAsync — asked **before** the app is looked
  // for, because "no apps" and "could not look" are the same answer from that read.
  return (await simulatorDiskExistsAsync(deviceId))
    ? await simulatorHasAppAsync(deviceId, appId)
    : null;
}
