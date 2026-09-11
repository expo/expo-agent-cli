// @ref llp/0028-installed-app-check.rfc.md §How the file is read
// The fingerprint embedded in the app installed on an Android device or emulator.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { adbNotRunnableError, runAdbAsync, runAdbRawAsync } from '../device/adb';
import { androidPackagePathsAsync } from '../device/androidApps';
import { androidDeviceNameAsync } from '../device/installDevBuild';
import { parseAndroidDevices } from '../navigate/device';
import {
  EOCD_MAX_LENGTH,
  LOCAL_HEADER_MAX_LENGTH,
  findCentralDirectoryEntry,
  parseEndOfCentralDirectory,
  readLocalZipEntry,
  readZipEntry,
} from '../utils/zipEntry';
import { debugEvent } from './events';
import {
  FINGERPRINT_FILE_NAME,
  matchesDeviceFilter,
  rankInstalledResult,
  type InstalledAppDevice,
  type InstalledFingerprintResult,
} from './installedFingerprint';

/** Block size of the ranged `dd` reads. `dd` seeks, so the cost is the bytes read. */
const RANGE_BLOCK_SIZE = 65536;

const ADB_TIMEOUT_MS = 30_000;

export interface AndroidReaderOptions {
  expectedHash: string | Promise<string>;
  device?: string;
  appId: string;
  /** Injected for tests. */
  runAdbAsync?: typeof runAdbAsync;
  runAdbRawAsync?: typeof runAdbRawAsync;
  androidDeviceNameAsync?: typeof androidDeviceNameAsync;
}

/**
 * Read the fingerprint out of the app on every authorized Android device. The most informative
 * device wins. The file is a zip entry inside the APK, read through ranged `dd` reads over
 * `adb exec-out`, with a whole-APK pull as the fallback when the device lacks the tools.
 *
 * `expectedHash` may be a promise: the device read overlaps with the fingerprint computation, and
 * the hash is only awaited at comparison time.
 *
 * @throws the `adb` tool error when `adb` itself could not run.
 */
export async function readInstalledFingerprintAndroidAsync({
  expectedHash,
  device: deviceFilter,
  appId,
  runAdbAsync: run = runAdbAsync,
  runAdbRawAsync: runRaw = runAdbRawAsync,
  androidDeviceNameAsync: deviceName = androidDeviceNameAsync,
}: AndroidReaderOptions): Promise<InstalledFingerprintResult> {
  const listed = await run(['devices', '-l'], { timeoutMs: ADB_TIMEOUT_MS });
  if (listed.notRunnable) {
    throw adbNotRunnableError(
      listed.adb,
      listed.spawnError?.message ?? 'the process did not start'
    );
  }
  if (listed.exitCode !== 0) {
    throw new Error(
      `"adb devices -l" failed: ${listed.stderr.trim() || `exit code ${listed.exitCode}`}`
    );
  }

  let devices: InstalledAppDevice[] = await Promise.all(
    parseAndroidDevices(listed.stdout).map(async ({ deviceId, model }) => ({
      identifier: deviceId,
      name: (await deviceName(deviceId, { run })) ?? model ?? deviceId,
    }))
  );
  if (deviceFilter) {
    devices = devices.filter((device) => matchesDeviceFilter(deviceFilter, device));
  }
  if (!devices.length) {
    return { status: 'no-device' };
  }

  let best: InstalledFingerprintResult | null = null;
  let lastError: Error | null = null;
  for (const device of devices) {
    let result: InstalledFingerprintResult;
    try {
      result = await readDeviceAsync(device, appId, { run, runRaw, adb: listed.adb });
    } catch (error) {
      // One unreachable device must not hide the evidence of the others.
      debugEvent('device_read_failed', {
        device: device.name,
        error: debugEvent.error(error as Error),
      });
      lastError = error as Error;
      continue;
    }
    const hash = await expectedHash;
    if (result.status === 'ok' && result.hash === hash) {
      return result;
    }
    if (!best || rankInstalledResult(result, hash) > rankInstalledResult(best, hash)) {
      best = result;
    }
  }
  if (!best) {
    throw lastError ?? new Error('No readable Android device was found.');
  }
  return best;
}

type AdbRunners = {
  run: typeof runAdbAsync;
  runRaw: typeof runAdbRawAsync;
  adb: Awaited<ReturnType<typeof runAdbAsync>>['adb'];
};

async function readDeviceAsync(
  device: InstalledAppDevice,
  appId: string,
  runners: AdbRunners
): Promise<InstalledFingerprintResult> {
  const apkPaths = await androidPackagePathsAsync(device.identifier, appId, {
    adb: runners.adb,
    runAdbAsync: runners.run,
  });
  if (apkPaths == null) {
    throw new Error(`Could not list the packages on ${device.name}.`);
  }
  const apkPath = apkPaths.find((entry) => entry.endsWith('/base.apk')) ?? apkPaths[0];
  if (!apkPath) {
    return { status: 'app-not-installed', appId, device };
  }

  let hash: string | null;
  try {
    hash = await readFingerprintRangedAsync(device, apkPath, runners);
  } catch (error) {
    debugEvent('ranged_read_failed', {
      device: device.name,
      error: debugEvent.error(error as Error),
    });
    hash = await readFingerprintByPullingAsync(device, apkPath, runners);
  }
  if (!hash) {
    return { status: 'no-embedded-fingerprint', appId, device };
  }
  return { status: 'ok', hash, appId, device };
}

/** The zip tail, the central directory, and the one entry: a few hundred KB of the APK. */
async function readFingerprintRangedAsync(
  device: InstalledAppDevice,
  apkPath: string,
  runners: AdbRunners
): Promise<string | null> {
  const sizeResult = await runners.run(
    ['-s', device.identifier, 'shell', 'stat', '-c', '%s', quoteForDeviceShell(apkPath)],
    { adb: runners.adb, timeoutMs: ADB_TIMEOUT_MS }
  );
  const size = parseInt(sizeResult.stdout.trim(), 10);
  if (sizeResult.exitCode !== 0 || !Number.isFinite(size) || size <= 0) {
    throw new Error(
      `Could not determine the APK size (stat returned: ${sizeResult.stdout.trim()})`
    );
  }

  const tailLength = Math.min(size, EOCD_MAX_LENGTH);
  const tailStart = size - tailLength;
  const tail = await readRangeAsync(device, apkPath, tailStart, tailLength, runners);
  const directory = parseEndOfCentralDirectory(tail);

  const centralDirectory =
    directory.offset >= tailStart
      ? tail.subarray(directory.offset - tailStart, directory.offset - tailStart + directory.size)
      : await readRangeAsync(device, apkPath, directory.offset, directory.size, runners);
  const location = findCentralDirectoryEntry(
    centralDirectory,
    directory.entryCount,
    `assets/${FINGERPRINT_FILE_NAME}`
  );
  if (!location) {
    return null;
  }

  const windowLength = Math.min(
    LOCAL_HEADER_MAX_LENGTH + location.compressedSize,
    size - location.localHeaderOffset
  );
  const local = await readRangeAsync(
    device,
    apkPath,
    location.localHeaderOffset,
    windowLength,
    runners
  );
  return readLocalZipEntry(local, location).toString('utf8').trim() || null;
}

async function readRangeAsync(
  device: InstalledAppDevice,
  filePath: string,
  offset: number,
  length: number,
  runners: AdbRunners
): Promise<Buffer> {
  const skip = Math.floor(offset / RANGE_BLOCK_SIZE);
  const start = offset % RANGE_BLOCK_SIZE;
  const count = Math.ceil((start + length) / RANGE_BLOCK_SIZE);
  // One argument on purpose. With one argument `exec-out` runs it through the device shell, so the
  // quoting and the stderr redirect work; as separate tokens dd's summary corrupts the stream.
  const result = await runners.runRaw(
    [
      '-s',
      device.identifier,
      'exec-out',
      `dd if=${quoteForDeviceShell(filePath)} bs=${RANGE_BLOCK_SIZE} skip=${skip} count=${count} 2>/dev/null`,
    ],
    { adb: runners.adb, timeoutMs: ADB_TIMEOUT_MS }
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Ranged read of ${filePath} failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`
    );
  }
  if (result.stdout.length < start + length) {
    throw new Error(
      `Short read from ${filePath}: expected ${length} bytes at offset ${offset}, got ${result.stdout.length - start}`
    );
  }
  return result.stdout.subarray(start, start + length);
}

async function readFingerprintByPullingAsync(
  device: InstalledAppDevice,
  apkPath: string,
  runners: AdbRunners
): Promise<string | null> {
  await fs.promises.mkdir(os.tmpdir(), { recursive: true });
  const temporaryDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'agent-cli-installed-app-')
  );
  try {
    const localApkPath = path.join(temporaryDir, 'app.apk');
    const pulled = await runners.run(['-s', device.identifier, 'pull', apkPath, localApkPath], {
      adb: runners.adb,
      timeoutMs: 5 * 60_000,
    });
    if (pulled.exitCode !== 0) {
      throw new Error(
        `"adb pull" failed: ${pulled.stderr.trim() || `exit code ${pulled.exitCode}`}`
      );
    }
    const entry = readZipEntry(
      await fs.promises.readFile(localApkPath),
      `assets/${FINGERPRINT_FILE_NAME}`
    );
    return entry?.toString('utf8').trim() || null;
  } finally {
    await fs.promises.rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Single-quote a path for the device shell. An APK path never holds a quote, but the guard is cheap. */
function quoteForDeviceShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
