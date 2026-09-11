// @ref llp/0028-installed-app-check.rfc.md §How the file is read
// The fingerprint embedded in the app installed on a physical iOS device. `devicectl` exposes no
// app container, so the app is launched with a trigger URL and posts the fingerprint back.

import crypto from 'crypto';

import {
  classifyDevicectlLaunchError,
  launchAppWithPayloadUrlAsync,
  openUrlWithDevicectlAsync,
  type IosDevice,
} from '../device/devicectl';
import * as Log from '../log';
import { startFingerprintCallbackServerAsync } from './fingerprintCallbackServer';
import { buildFingerprintCheckUrl } from './fingerprintCheckProtocol';
import {
  matchesDeviceFilter,
  pickBestResult,
  type InstalledAppDevice,
  type InstalledFingerprintResult,
} from './installedFingerprint';

export interface IosDeviceReaderDependencies {
  launchAppWithPayloadUrlAsync?: typeof launchAppWithPayloadUrlAsync;
  openUrlWithDevicectlAsync?: typeof openUrlWithDevicectlAsync;
  startFingerprintCallbackServerAsync?: typeof startFingerprintCallbackServerAsync;
}

export interface IosDeviceReaderOptions {
  expectedHash: string | Promise<string>;
  /** `--device`: only the phone matching this name or UDID. */
  device?: string;
  appId: string;
  /** The connected devices, enumerated by the caller so `devicectl` runs once. */
  devices: IosDevice[];
  /** The project's URL scheme, for the `openURL` fallback. Null when it declares none. */
  scheme: string | null;
  timeoutMs?: number;
  /** Injected for tests. */
  deps?: IosDeviceReaderDependencies;
}

/**
 * Probe connected iOS devices one at a time, and stop at the first one whose app matches.
 *
 * Only reachable devices are probed. A matched device with Developer Mode off is `no-device` with
 * a hint that says so, because "no device matched" would send the reader to plug in a phone that
 * is already there.
 */
export async function readInstalledFingerprintIosDeviceAsync({
  expectedHash,
  device: deviceFilter,
  appId,
  devices,
  scheme,
  timeoutMs,
  deps = {},
}: IosDeviceReaderOptions): Promise<InstalledFingerprintResult> {
  let candidates = devices.filter((device) => device.reachable);
  if (deviceFilter) {
    candidates = candidates.filter((device) =>
      matchesDeviceFilter(deviceFilter, { name: device.name, identifier: device.udid })
    );
  }
  const usable = candidates.filter((device) => device.developerModeEnabled);
  if (!usable.length) {
    const [blocked] = candidates;
    if (blocked) {
      return {
        status: 'no-device',
        hint: `${blocked.name} is connected, but Developer Mode is off, so the app cannot be launched on it. Enable it in Settings → Privacy & Security → Developer Mode, then retry.`,
      };
    }
    return { status: 'no-device' };
  }

  const results: InstalledFingerprintResult[] = [];
  for (const candidate of usable) {
    const device = { name: candidate.name, identifier: candidate.udid };
    // stderr, so a `--json` run keeps stdout for the one object.
    Log.warn(`Checking ${device.name}. This launches the app on the device.`);
    const result = await probeDeviceAsync(device, appId, scheme, timeoutMs, deps);
    if (result.status === 'ok' && result.hash === (await expectedHash)) {
      return result;
    }
    results.push(result);
  }
  return pickBestResult(results, await expectedHash);
}

async function probeDeviceAsync(
  device: InstalledAppDevice,
  appId: string,
  scheme: string | null,
  timeoutMs: number | undefined,
  {
    launchAppWithPayloadUrlAsync: launch = launchAppWithPayloadUrlAsync,
    openUrlWithDevicectlAsync: openUrl = openUrlWithDevicectlAsync,
    startFingerprintCallbackServerAsync: startServer = startFingerprintCallbackServerAsync,
  }: IosDeviceReaderDependencies
): Promise<InstalledFingerprintResult> {
  const nonce = crypto.randomUUID();
  const server = await startServer({ nonce, timeoutMs });
  try {
    const url = buildFingerprintCheckUrl(scheme, nonce, server.callbackUrl);
    try {
      await launch(device.identifier, appId, url);
    } catch (error) {
      const kind = classifyDevicectlLaunchError(error);
      if (kind === 'app-not-installed') {
        return { status: 'app-not-installed', appId, device };
      }
      if (kind === 'device-locked') {
        return {
          status: 'no-response',
          appId,
          device,
          hint: `${device.name} is locked, so the app could not be launched. Unlock it, then run this command again.`,
        };
      }
      // Any other launch failure falls back to `openURL`, which reaches a running app. The wording
      // of older toolchains is unknown, so the fallback must not depend on recognising it. `openURL`
      // routes by scheme, so a project without one has no way to reach the app.
      if (!scheme) {
        return { status: 'no-response', appId, device };
      }
      try {
        await openUrl(device.identifier, url);
      } catch {
        // The launch error names the failure; the openURL one is downstream of it.
        throw error;
      }
    }

    const response = await server.result;
    if (!response) {
      return { status: 'no-response', appId, device };
    }
    if (response.fingerprint === null) {
      return { status: 'no-embedded-fingerprint', appId, device };
    }
    return { status: 'ok', hash: response.fingerprint, appId, device };
  } finally {
    server.close();
  }
}
