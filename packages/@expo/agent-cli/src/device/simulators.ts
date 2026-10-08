// @ref llp/0005-runtime-loop-tools.rfc.md §The device that can open the app
// What `xcrun simctl list devices -j` says about the iOS simulators on this machine.

import type { IosSimulatorReaderDependencies } from '../installedApp/iosSimulator';
import type { InstalledAppDevice } from '../installedApp/installedFingerprint';
import { CommandError } from '../utils/errors';
import { spawnCaptureAsync } from '../utils/spawnCapture';

export const SIMCTL_TIMEOUT_MS = 30_000;

/** One simulator, as `simctl list devices -j` describes it. */
export interface SimulatorEntry {
  udid: string;
  name: string;
  /** The runtime identifier it is listed under, e.g. `com.apple.CoreSimulator.SimRuntime.iOS-26-0`. */
  runtime: string;
  /** iOS version as a comparable tuple, from the runtime identifier. */
  version: number[];
  state: string;
  isAvailable: boolean;
  /**
   * When this device was last booted, as epoch milliseconds. Zero for one that never has been.
   *
   * The field that decides the choice, and it is not about recency for its own sake. **Apps are
   * installed per device**, so a simulator nobody has ever booted has no Expo Go on it and no
   * development build either — a run that booted one would spend a minute and then fail at the
   * `app` phase against a device that could never have answered.
   */
  lastBootedAt: number;
}

/**
 * Read the bootable iOS simulators out of `simctl list devices -j`.
 *
 * Only iOS runtimes: a watchOS or tvOS simulator cannot run this project's app, and booting one
 * would be a minute spent on a device every phase after it would then fail against.
 *
 * Exported because it is the half of the iOS path that can be wrong without any simulator being
 * involved, and pinning it needs no Xcode.
 */
export function parseSimulators(stdout: string): SimulatorEntry[] {
  let parsed: {
    devices?: Record<
      string,
      {
        udid?: string;
        name?: string;
        state?: string;
        isAvailable?: boolean;
        lastBootedAt?: string;
      }[]
    >;
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  const simulators: SimulatorEntry[] = [];
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    const version = runtime.match(/\.iOS-([\d-]+)$/)?.[1];
    if (version == null || !Array.isArray(devices)) {
      continue;
    }
    for (const device of devices) {
      if (device?.udid) {
        simulators.push({
          udid: device.udid,
          name: device.name ?? '',
          runtime,
          version: version.split('-').map(Number),
          state: device.state ?? 'Unknown',
          // Absent means available: `simctl` omits the key for the ordinary case and sets it false
          // for a device whose runtime is gone.
          isAvailable: device.isAvailable !== false,
          // `simctl` omits the key entirely for a device that has never been booted, which is
          // exactly the device this must not choose.
          lastBootedAt: Date.parse(device.lastBootedAt ?? '') || 0,
        });
      }
    }
  }
  return simulators;
}

/** Every booted iOS simulator in `simctl list devices booted -j`, in the order `simctl` lists them. */
export function parseBootedIosSimulators(stdout: string): { udid: string; name: string }[] {
  let parsed: { devices?: Record<string, { udid?: string; name?: string }[]> };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  const simulators: { udid: string; name: string }[] = [];
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    if (!runtime.includes('.iOS-') || !Array.isArray(devices)) {
      continue;
    }
    for (const device of devices) {
      if (device?.udid) {
        simulators.push({ udid: device.udid, name: device.name ?? '' });
      }
    }
  }
  return simulators;
}

/**
 * The booted iOS simulators, as devices.
 *
 * @throws `XCRUN_NOT_RUNNABLE` when `xcrun` itself could not run.
 */
export async function listBootedIosSimulatorsAsync({
  spawnCaptureAsync: spawnCapture = spawnCaptureAsync,
}: IosSimulatorReaderDependencies = {}): Promise<InstalledAppDevice[]> {
  const listed = await spawnCapture('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], {
    timeoutMs: SIMCTL_TIMEOUT_MS,
  });
  if (listed.spawnError) {
    throw new CommandError(
      'XCRUN_NOT_RUNNABLE',
      [
        `Could not run "xcrun simctl", so no iOS simulator was looked at.`,
        `Why: ${listed.spawnError.message}`,
        `How: install Xcode and its command line tools, which provide "xcrun simctl", then run this command again.`,
      ].join('\n')
    );
  }
  if (listed.exitCode !== 0) {
    throw new Error(
      `"xcrun simctl list devices booted" failed: ${listed.stderr.trim() || `exit code ${listed.exitCode}`}`
    );
  }
  return parseBootedIosSimulators(listed.stdout).map(({ udid, name }) => ({
    identifier: udid,
    name: name || udid,
  }));
}
