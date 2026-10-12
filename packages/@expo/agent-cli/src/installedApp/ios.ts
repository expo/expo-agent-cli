// @ref llp/0005-runtime-loop-tools.rfc.md §How the file is read
// @ref llp/0030-one-device-per-worktree.rfc.md §Readers
// Which iOS device answers: the simulator this worktree bound, a booted simulator `--device`
// names, or a physical device only when `--device` names it. Reading a simulator is a file read;
// reading a phone launches the app on it.

import { listConnectedIosDevicesAsync, type IosDevice } from '../device/devicectl';
import { listBootedIosSimulatorsAsync } from '../device/simulators';
import { findBoundDeviceAsync } from '../deviceBinding';
import { CommandError } from '../utils/errors';
import { readInstalledFingerprintIosDeviceAsync } from './iosDevice';
import { readSimulatorsAsync, type IosSimulatorReaderDependencies } from './iosSimulator';
import {
  matchesDeviceFilter,
  type InstalledAppDevice,
  type InstalledFingerprintResult,
} from './installedFingerprint';

export interface IosReaderOptions {
  projectRoot: string;
  expectedHash: string;
  device?: string;
  appId: string;
  scheme: string | null;
  timeoutMs?: number;
  /** Injected for tests. */
  deps?: IosSimulatorReaderDependencies & {
    listConnectedIosDevicesAsync?: typeof listConnectedIosDevicesAsync;
    readInstalledFingerprintIosDeviceAsync?: typeof readInstalledFingerprintIosDeviceAsync;
    findBoundSimulatorAsync?: typeof findBoundSimulatorAsync;
  };
}

/**
 * The bound simulator, without extending its lease, because `status` never writes.
 *
 * @returns the simulator, or the How line of the registry's refusal.
 */
async function findBoundSimulatorAsync(
  projectRoot: string
): Promise<{ simulator: InstalledAppDevice | null; hint: string | null }> {
  try {
    const found = await findBoundDeviceAsync(projectRoot, { platform: 'ios', extend: false });
    if (found.device?.backend === 'local-ios') {
      return {
        simulator: { identifier: found.device.udid, name: found.device.name || found.device.udid },
        hint: null,
      };
    }
    return { simulator: null, hint: lastLine(found.refusal?.message) };
  } catch (error: unknown) {
    if (error instanceof CommandError) {
      return { simulator: null, hint: lastLine(error.message) };
    }
    throw error;
  }
}

function lastLine(text: string | undefined): string | null {
  return text?.trim().split('\n').at(-1) ?? null;
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
    findBoundSimulatorAsync: findBound = findBoundSimulatorAsync,
  } = deps;

  // Enumerating phones costs `devicectl` over a second, so it happens at most once and only
  // when a simulator cannot answer.
  let phones: Promise<IosDevice[]> | undefined;
  const listPhonesOnce = () => (phones ??= listPhones(deps));
  const readPhonesAsync = (devices: IosDevice[]) =>
    readPhones({ expectedHash, device: deviceFilter, appId, devices, scheme, timeoutMs });

  let simulators: InstalledAppDevice[];
  if (deviceFilter) {
    // `--device` lists to filter and binds nothing (llp/0030 Contract 3).
    const booted = await listBootedIosSimulatorsAsync(deps);
    simulators = booted.filter((simulator) => matchesDeviceFilter(deviceFilter, simulator));
    if (!simulators.length) {
      const devices = await listPhonesOnce();
      const matchesPhone = devices.some((device) =>
        matchesDeviceFilter(deviceFilter, { name: device.name, identifier: device.udid })
      );
      return matchesPhone ? readPhonesAsync(devices) : { status: 'no-device' };
    }
  } else {
    const bound = await findBound(projectRoot);
    if (bound.simulator == null) {
      // A phone is never probed unasked, even when it is the only iOS device this machine has.
      const devices = (await listPhonesOnce()).filter((device) => device.reachable);
      const names = devices.map((device) => device.name).join(', ');
      const phoneHint = devices.length
        ? `${devices.length > 1 ? `Physical iOS devices are connected (${names})` : `A physical iOS device is connected (${names})`}; check one with --device "<name>", which launches the app on it.`
        : null;
      const hint = [bound.hint, phoneHint].filter(Boolean).join(' ');
      return hint ? { status: 'no-device', hint } : { status: 'no-device' };
    }
    simulators = [bound.simulator];
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
