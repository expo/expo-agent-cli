// @ref llp/0028-installed-app-check.rfc.md §How the file is read
// Which iOS device answers: booted simulators first, a physical device only when it is the clear
// choice. Reading a simulator is a file read; reading a phone launches the app on it.

import { listConnectedIosDevicesAsync, type IosDevice } from '../device/devicectl';
import { readInstalledFingerprintIosDeviceAsync } from './iosDevice';
import {
  listBootedIosSimulatorsAsync,
  readSimulatorsAsync,
  type IosSimulatorReaderDependencies,
} from './iosSimulator';
import { matchesDeviceFilter, type InstalledFingerprintResult } from './installedFingerprint';

export interface IosReaderOptions {
  expectedHash: string | Promise<string>;
  device?: string;
  appId: string;
  scheme: string | null;
  timeoutMs?: number;
  /** Injected for tests. */
  deps?: IosSimulatorReaderDependencies & {
    listConnectedIosDevicesAsync?: typeof listConnectedIosDevicesAsync;
    readInstalledFingerprintIosDeviceAsync?: typeof readInstalledFingerprintIosDeviceAsync;
  };
}

/**
 * The physical-device path runs only when `--device` names a phone that no simulator matches, or
 * when no simulator is booted and exactly one phone is connected. Everywhere else the phone is
 * named in a hint and left alone: probing it launches the app on it.
 */
export async function readInstalledFingerprintIosAsync({
  expectedHash,
  device: deviceFilter,
  appId,
  scheme,
  timeoutMs,
  deps = {},
}: IosReaderOptions): Promise<InstalledFingerprintResult> {
  const {
    listConnectedIosDevicesAsync: listPhones = listConnectedIosDevicesAsync,
    readInstalledFingerprintIosDeviceAsync: readPhones = readInstalledFingerprintIosDeviceAsync,
  } = deps;
  let simulators = await listBootedIosSimulatorsAsync(deps);

  // Enumerating phones costs `devicectl` over a second, so it happens at most once and only
  // when a simulator cannot answer.
  let phones: Promise<IosDevice[]> | undefined;
  const listPhonesOnce = () => (phones ??= listPhones(deps));
  const readPhonesAsync = (devices: IosDevice[]) =>
    readPhones({ expectedHash, device: deviceFilter, appId, devices, scheme, timeoutMs });

  if (deviceFilter) {
    const matching = simulators.filter((simulator) => matchesDeviceFilter(deviceFilter, simulator));
    if (!matching.length) {
      const devices = await listPhonesOnce();
      const matchesPhone = devices.some((device) =>
        matchesDeviceFilter(deviceFilter, { name: device.name, identifier: device.udid })
      );
      return matchesPhone ? readPhonesAsync(devices) : { status: 'no-device' };
    }
    simulators = matching;
  } else if (!simulators.length) {
    const devices = (await listPhonesOnce()).filter((device) => device.reachable);
    if (!devices.length) {
      return { status: 'no-device' };
    }
    if (devices.length > 1) {
      const names = devices.map((device) => device.name).join(', ');
      return {
        status: 'no-device',
        hint: `Several physical iOS devices are connected (${names}). Pick one with --device "<name>"; the check launches the app on it.`,
      };
    }
    return readPhonesAsync(devices);
  }

  const result = await readSimulatorsAsync(simulators, appId, expectedHash, deps);
  const answered = result.status === 'ok' && result.hash === (await expectedHash);
  if (!answered && !deviceFilter) {
    const [phone] = (await listPhonesOnce()).filter((device) => device.reachable);
    if (phone) {
      return {
        ...result,
        hint: `A physical iOS device is also connected (${phone.name}). Check it with --device "${phone.name}"; physical devices are only checked on request, since the check launches the app.`,
      };
    }
  }
  return result;
}
