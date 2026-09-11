// @ref llp/0028-installed-app-check.rfc.md §How the file is read
// What reading the installed app answered, and how to pick one answer out of several devices.

/** Name of the file the expo-constants build phase embeds in a debug build. */
export const FINGERPRINT_FILE_NAME = 'app.fingerprint';

export type InstalledAppDevice = {
  name: string;
  /** Simulator UDID, device UDID, or adb serial. */
  identifier: string;
};

export type InstalledFingerprintResult = (
  | { status: 'no-device' }
  | { status: 'app-not-installed'; appId: string; device: InstalledAppDevice }
  | { status: 'no-embedded-fingerprint'; appId: string; device: InstalledAppDevice }
  | { status: 'no-response'; appId: string; device: InstalledAppDevice }
  | { status: 'ok'; hash: string; appId: string; device: InstalledAppDevice }
) & {
  /** Guidance to print with the verdict without changing it, e.g. a phone that was not probed. */
  hint?: string;
};

/**
 * How much a device's answer is worth: a matching app, then any app with a hash, then an app
 * without one, then a definite "not installed", then silence.
 */
export function rankInstalledResult(
  result: InstalledFingerprintResult,
  expectedHash: string
): number {
  switch (result.status) {
    case 'ok':
      return result.hash === expectedHash ? 4 : 3;
    case 'no-embedded-fingerprint':
      return 2;
    case 'app-not-installed':
      return 1;
    case 'no-response':
      return 0;
    default:
      return -1;
  }
}

/** The most informative answer, so a stale device cannot hide a matching install on another. */
export function pickBestResult(
  results: InstalledFingerprintResult[],
  expectedHash: string
): InstalledFingerprintResult {
  let best: InstalledFingerprintResult = { status: 'no-device' };
  for (const result of results) {
    if (result.status === 'ok' && result.hash === expectedHash) {
      return result;
    }
    if (rankInstalledResult(result, expectedHash) > rankInstalledResult(best, expectedHash)) {
      best = result;
    }
  }
  return best;
}

/** Case-insensitive match of `--device` against a device's name or identifier. */
export function matchesDeviceFilter(
  filter: string,
  device: { name: string; identifier: string }
): boolean {
  const wanted = filter.toLowerCase();
  return device.identifier.toLowerCase() === wanted || device.name.toLowerCase() === wanted;
}
