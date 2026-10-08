// @ref llp/0005-runtime-loop-tools.rfc.md §How the file is read
// The fingerprint embedded in the app installed on a booted iOS simulator.

import fs from 'fs';
import path from 'path';

import { SIMCTL_TIMEOUT_MS } from '../device/simulators';
import { spawnCaptureAsync } from '../utils/spawnCapture';
import {
  FINGERPRINT_FILE_NAME,
  parseEmbeddedFingerprint,
  pickBestResult,
  type InstalledAppDevice,
  type InstalledFingerprintResult,
} from './installedFingerprint';

export interface IosSimulatorReaderDependencies {
  /** Injected for tests. */
  spawnCaptureAsync?: typeof spawnCaptureAsync;
  readFile?: (filePath: string) => string;
}

/** The two places the resource bundle lives: static linking, and `use_frameworks!`. */
export function fingerprintCandidatePaths(containerPath: string): string[] {
  return [
    path.join(containerPath, 'EXConstants.bundle', FINGERPRINT_FILE_NAME),
    path.join(
      containerPath,
      'Frameworks',
      'EXConstants.framework',
      'EXConstants.bundle',
      FINGERPRINT_FILE_NAME
    ),
  ];
}

/**
 * Read the app on each simulator and keep the most informative answer. One simulator that cannot
 * be read (mid-shutdown, say) does not hide the others; it only fails when none could be read.
 */
export async function readSimulatorsAsync(
  simulators: InstalledAppDevice[],
  appId: string,
  expectedHash: string,
  {
    spawnCaptureAsync: spawnCapture = spawnCaptureAsync,
    readFile = (filePath) => fs.readFileSync(filePath, 'utf8'),
  }: IosSimulatorReaderDependencies = {}
): Promise<InstalledFingerprintResult> {
  const settled = await Promise.allSettled(
    simulators.map((simulator) => readSimulatorAsync(simulator, appId, { spawnCapture, readFile }))
  );
  const results: InstalledFingerprintResult[] = [];
  let lastError: unknown = null;
  for (const entry of settled) {
    if (entry.status === 'fulfilled') {
      results.push(entry.value);
    } else {
      lastError = entry.reason;
    }
  }
  if (!results.length) {
    throw lastError;
  }
  return pickBestResult(results, expectedHash);
}

async function readSimulatorAsync(
  device: InstalledAppDevice,
  appId: string,
  {
    spawnCapture,
    readFile,
  }: {
    spawnCapture: typeof spawnCaptureAsync;
    readFile: (filePath: string) => string;
  }
): Promise<InstalledFingerprintResult> {
  const container = await spawnCapture(
    'xcrun',
    ['simctl', 'get_app_container', device.identifier, appId],
    { timeoutMs: SIMCTL_TIMEOUT_MS }
  );
  if (container.spawnError) {
    throw container.spawnError;
  }
  // `get_app_container` exits non-zero for an app the simulator has not got.
  const containerPath = container.exitCode === 0 ? container.stdout.trim() : '';
  if (!containerPath) {
    return { status: 'app-not-installed', appId, device };
  }

  for (const candidate of fingerprintCandidatePaths(containerPath)) {
    try {
      const embedded = parseEmbeddedFingerprint(readFile(candidate));
      if (embedded) {
        return { status: 'ok', ...embedded, appId, device };
      }
    } catch {
      // The next candidate may hold it.
    }
  }
  return { status: 'no-embedded-fingerprint', appId, device };
}
