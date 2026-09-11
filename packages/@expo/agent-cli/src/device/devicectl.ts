// @ref llp/0028-installed-app-check.rfc.md §How the file is read
// Physical Apple devices through `xcrun devicectl`: which ones are connected, launch an app with a
// payload URL, open a URL. Only what the iOS device reader of the installed-app check needs.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { spawnCaptureAsync } from '../utils/spawnCapture';

/** How long `devicectl` gets to answer. Listing devices takes it over a second. */
const DEVICECTL_TIMEOUT_MS = 60_000;

/** One connected physical iOS device, with the two facts that decide whether it can be probed. */
export interface IosDevice {
  udid: string;
  name: string;
  developerModeEnabled: boolean;
  /** Paired and with a usable tunnel. An unplugged or unpaired device cannot be launched on. */
  reachable: boolean;
}

export interface DevicectlOptions {
  /** Injected for tests. */
  spawnCaptureAsync?: typeof spawnCaptureAsync;
}

/** The fields this reads out of `devicectl list devices --json-output`. */
interface DevicectlListJson {
  result?: {
    devices?: {
      hardwareProperties?: { udid?: string; platform?: string; reality?: string };
      deviceProperties?: { name?: string; developerModeStatus?: string };
      connectionProperties?: { pairingState?: string; tunnelState?: string };
    }[];
  };
}

/** Read the device list out of the JSON `devicectl` writes. Exported for the test over a fixture. */
export function parseDevicectlList(json: unknown): IosDevice[] {
  const devices = (json as DevicectlListJson)?.result?.devices;
  if (!Array.isArray(devices)) {
    return [];
  }
  const found: IosDevice[] = [];
  for (const device of devices) {
    const hardware = device?.hardwareProperties;
    if (!hardware?.udid || hardware.platform !== 'iOS' || hardware.reality === 'simulated') {
      continue;
    }
    const connection = device.connectionProperties;
    found.push({
      udid: hardware.udid,
      name: device.deviceProperties?.name || hardware.udid,
      developerModeEnabled: device.deviceProperties?.developerModeStatus === 'enabled',
      reachable: connection?.pairingState === 'paired' && connection?.tunnelState !== 'unavailable',
    });
  }
  return found;
}

/**
 * The physical iOS devices this Mac knows about.
 *
 * Never throws. A `devicectl` that cannot run answers an empty list: an old Xcode must not break
 * the simulator path, which never needs it.
 */
export async function listConnectedIosDevicesAsync({
  spawnCaptureAsync: spawnCapture = spawnCaptureAsync,
}: DevicectlOptions = {}): Promise<IosDevice[]> {
  await fs.promises.mkdir(os.tmpdir(), { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-cli-devicectl-'));
  const outputPath = path.join(directory, 'devices.json');
  try {
    // `--json-output` is the only structured output `devicectl` has; stdout is prose.
    const result = await spawnCapture(
      'xcrun',
      ['devicectl', 'list', 'devices', '--json-output', outputPath, '--timeout', '5'],
      { timeoutMs: DEVICECTL_TIMEOUT_MS }
    );
    if (result.spawnError || result.exitCode !== 0) {
      return [];
    }
    return parseDevicectlList(JSON.parse(await fs.promises.readFile(outputPath, 'utf8')));
  } catch {
    return [];
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/** Launch an app on a device and hand it a URL during launch. Throws with `devicectl`'s stderr. */
export async function launchAppWithPayloadUrlAsync(
  udid: string,
  bundleId: string,
  payloadUrl: string,
  { spawnCaptureAsync: spawnCapture = spawnCaptureAsync }: DevicectlOptions = {}
): Promise<void> {
  await runDevicectlAsync(
    ['device', 'process', 'launch', '--payload-url', payloadUrl, '--device', udid, bundleId],
    spawnCapture
  );
}

/** Open a URL on a device, through the app registered for its scheme. */
export async function openUrlWithDevicectlAsync(
  udid: string,
  url: string,
  { spawnCaptureAsync: spawnCapture = spawnCaptureAsync }: DevicectlOptions = {}
): Promise<void> {
  await runDevicectlAsync(['device', 'process', 'openURL', '--device', udid, url], spawnCapture);
}

async function runDevicectlAsync(
  args: string[],
  spawnCapture: typeof spawnCaptureAsync
): Promise<void> {
  const result = await spawnCapture('xcrun', ['devicectl', ...args], {
    timeoutMs: DEVICECTL_TIMEOUT_MS,
  });
  if (result.spawnError) {
    throw result.spawnError;
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `"xcrun devicectl ${args.slice(0, 3).join(' ')}" failed: ${
        result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
      }`
    );
  }
}

/**
 * What a `devicectl` launch failure means, from its message.
 *
 * Verified on Xcode 27: a missing app fails with "The requested application <bundle id> is not
 * installed." A locked phone fails with `BSErrorCodeDescription = Locked` and "the device was
 * not, or could not be, unlocked" [observed 2026-09-08, iPhone 16]. Launching a running app
 * succeeds there, so `already-running` covers older toolchains.
 */
export function classifyDevicectlLaunchError(
  error: unknown
): 'app-not-installed' | 'device-locked' | 'already-running' | 'unknown' {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes('is not installed') || message.includes('could not be found')) {
    return 'app-not-installed';
  }
  if (
    message.includes('could not be, unlocked') ||
    /bserrorcodedescription = locked/.test(message)
  ) {
    return 'device-locked';
  }
  if (message.includes('already running')) {
    return 'already-running';
  }
  return 'unknown';
}
