// @ref llp/0005-runtime-loop-tools.rfc.md §How the file is read
// What reading the installed app answered, and how to pick one answer out of several devices.

import type { FingerprintSource } from '../project/fingerprint';

/** Name of the file the expo-constants build phase embeds in a debug build. */
export const FINGERPRINT_FILE_NAME = 'app.fingerprint';

/** What that file holds: the hash, the sources behind it, and the `@expo/fingerprint` that produced it. */
export interface EmbeddedFingerprint {
  hash: string;
  /** Null when the build could not read it. Then the two hashes cannot be told apart. */
  fingerprintVersion: string | null;
  /**
   * The sources the hash was computed from, so a mismatch can name the input that moved rather
   * than only report that something did. Absent from a device that answered over the wire: they
   * do not fit the response, so a caller has to treat "no sources" as "cannot name it".
   */
  sources?: FingerprintSource[];
}

/**
 * Read the embedded file. Null when it is absent, empty, or not the shape this expects.
 *
 * Written by `createFingerprintFile.js` in expo/expo. Nothing pins these key names across the two
 * repositories, so a rename there surfaces here as a build with no embedded fingerprint.
 */
export function parseEmbeddedFingerprint(contents: string): EmbeddedFingerprint | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const { hash, fingerprintVersion, sources } = parsed as Record<string, unknown>;
  if (typeof hash !== 'string' || !hash) {
    return null;
  }
  return {
    hash,
    fingerprintVersion: typeof fingerprintVersion === 'string' ? fingerprintVersion : null,
    sources: Array.isArray(sources) ? (sources as FingerprintSource[]) : [],
  };
}

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
  | ({ status: 'ok'; appId: string; device: InstalledAppDevice } & EmbeddedFingerprint)
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
