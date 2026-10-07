// @ref llp/0030-one-device-per-agent.rfc.md §Every verb uses the claim
// @ref llp/0005-runtime-loop-tools.rfc.md §How the file is read
// Which iOS device answers: the simulator this worktree claims first, a physical device only when
// `--device` names it. Reading a simulator is a file read; reading a phone launches the app on it.

import { listConnectedIosDevicesAsync, type IosDevice } from '../device/devicectl';
import { readInstalledFingerprintIosDeviceAsync } from './iosDevice';
import {
  listBootedIosSimulatorsAsync,
  readSimulatorsAsync,
  type IosSimulatorReaderDependencies,
} from './iosSimulator';
import {
  claimedReadableDeviceAsync,
  matchesDeviceFilter,
  type InstalledFingerprintResult,
  type PeekDeviceAsync,
} from './installedFingerprint';

export interface IosReaderOptions {
  /** The worktree whose claimed simulator is read when `--device` names none. */
  projectRoot: string;
  expectedHash: string;
  device?: string;
  appId: string;
  scheme: string | null;
  timeoutMs?: number;
  /** Injected for tests. */
  deps?: IosSimulatorReaderDependencies & {
    resolveClaimedDeviceAsync?: PeekDeviceAsync;
    listConnectedIosDevicesAsync?: typeof listConnectedIosDevicesAsync;
    readInstalledFingerprintIosDeviceAsync?: typeof readInstalledFingerprintIosDeviceAsync;
  };
}

/**
 * The physical-device path runs only when `--device` names a phone that no simulator matches.
 * Everywhere else the phone is named in a hint and left alone, because probing it launches the app
 * on it and `status` starts nothing it was not asked to start. Naming the phone is the consent.
 */
export async function readInstalledFingerprintIosAsync({
  projectRoot,
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
  // `--device` is a filter over every booted simulator; without it, the claimed one is read.
  let simulators = deviceFilter
    ? await listBootedIosSimulatorsAsync(deps)
    : await claimedReadableDeviceAsync('ios', projectRoot, deps.resolveClaimedDeviceAsync).then(
        (claimed) => (claimed ? [claimed.device] : [])
      );

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
    // A phone is never probed unasked, even when it is the only iOS device this machine has.
    const devices = (await listPhonesOnce()).filter((device) => device.reachable);
    if (!devices.length) {
      return { status: 'no-device' };
    }
    const names = devices.map((device) => device.name).join(', ');
    return {
      status: 'no-device',
      hint: `${devices.length > 1 ? `Physical iOS devices are connected (${names})` : `A physical iOS device is connected (${names})`}; check one with --device "<name>", which launches the app on it.`,
    };
  }

  const result = await readSimulatorsAsync(simulators, appId, expectedHash, deps);
  const answered = result.status === 'ok' && result.hash === expectedHash;
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
