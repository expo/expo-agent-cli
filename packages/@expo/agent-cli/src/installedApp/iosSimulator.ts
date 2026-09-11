// @ref llp/0028-installed-app-check.rfc.md §How the file is read
// The fingerprint embedded in the app installed on a booted iOS simulator.

import fs from 'fs';
import path from 'path';

import { parseBootedIosSimulators } from '../navigate/device';
import { CommandError } from '../utils/errors';
import { spawnCaptureAsync } from '../utils/spawnCapture';
import {
  FINGERPRINT_FILE_NAME,
  matchesDeviceFilter,
  pickBestResult,
  type InstalledAppDevice,
  type InstalledFingerprintResult,
} from './installedFingerprint';

const SIMCTL_TIMEOUT_MS = 30_000;

export interface IosSimulatorReaderDependencies {
  /** Injected for tests. */
  spawnCaptureAsync?: typeof spawnCaptureAsync;
  readFile?: (filePath: string) => string;
}

export interface IosSimulatorReaderOptions extends IosSimulatorReaderDependencies {
  expectedHash: string | Promise<string>;
  device?: string;
  appId: string;
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

/**
 * Read the app on each simulator and keep the most informative answer. One simulator that cannot
 * be read (mid-shutdown, say) does not hide the others; it only fails when none could be read.
 */
export async function readSimulatorsAsync(
  simulators: InstalledAppDevice[],
  appId: string,
  expectedHash: string | Promise<string>,
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
  return pickBestResult(results, await expectedHash);
}

/** Read the fingerprint out of the app on every booted iOS simulator, or the one `--device` names. */
export async function readInstalledFingerprintIosSimulatorAsync({
  expectedHash,
  device: deviceFilter,
  appId,
  ...deps
}: IosSimulatorReaderOptions): Promise<InstalledFingerprintResult> {
  let simulators = await listBootedIosSimulatorsAsync(deps);
  if (deviceFilter) {
    simulators = simulators.filter((simulator) => matchesDeviceFilter(deviceFilter, simulator));
  }
  if (!simulators.length) {
    return { status: 'no-device' };
  }
  return readSimulatorsAsync(simulators, appId, expectedHash, deps);
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
      const hash = readFile(candidate).trim();
      if (hash) {
        return { status: 'ok', hash, appId, device };
      }
    } catch {
      // The next candidate may hold it.
    }
  }
  return { status: 'no-embedded-fingerprint', appId, device };
}
