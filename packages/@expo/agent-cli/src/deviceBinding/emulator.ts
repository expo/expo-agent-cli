// @ref llp/0032-android-instance.plan.md §Android boot
// The Android tool calls the registry reads with: the inventory before the lock, and `get-state`
// for one serial, each one `adb` or `emulator` subprocess.

import { adbNotRunnableError, parseAndroidDevices, resolveAdb } from '../device/adb';
import { parseAvds } from '../device/bootDevice';
import { CommandError } from '../utils/errors';
import type { SpawnCaptureResult } from '../utils/spawnCapture';
import { firstLine } from '../utils/text';
import type { AndroidInventory } from './choose';
import { deviceUnavailableError } from './errors';
import type { DeviceTools } from './types';

/** The budget of every `adb` call that is not a boot wait. */
export const ADB_CALL_TIMEOUT_MS = 20_000;

/** Whether this host has an Android SDK to run instances with; `emulator` is found beside `adb`. */
export function androidToolsResolve(): boolean {
  return !resolveAdb().fromPathOnly;
}

export function emulatorNotRunnableError(reason: string): CommandError {
  return new CommandError(
    'EMULATOR_NOT_RUNNABLE',
    [
      `Could not run the Android "emulator", so no instance was started.`,
      `Why: ${reason}`,
      `How: install the Android SDK's emulator package, or set ANDROID_HOME to the SDK that has it, then run this command again.`,
    ].join('\n')
  );
}

/** The Android inventory, read before the lock. @throws the tool error, or `create-timeout`. */
export async function readAndroidInventoryAsync(tools: DeviceTools): Promise<AndroidInventory> {
  const devices = await tools.adb(['devices', '-l'], { timeoutMs: ADB_CALL_TIMEOUT_MS });
  if (devices.spawnError) {
    throw adbNotRunnableError(resolveAdb(), devices.spawnError.message);
  }
  assertAnswered(devices, 'adb devices -l');
  const avds = await tools.emulatorList(['-list-avds'], { timeoutMs: 60_000 });
  if (avds.spawnError) {
    throw emulatorNotRunnableError(avds.spawnError.message);
  }
  assertAnswered(avds, 'emulator -list-avds');
  return {
    avd: parseAvds(avds.stdout)[0] ?? null,
    runningSerials: parseAndroidDevices(devices.stdout).map((device) => device.deviceId),
  };
}

function assertAnswered(result: SpawnCaptureResult, call: string): void {
  if (result.exitCode == null) {
    throw deviceUnavailableError('create-timeout', { platform: 'android' });
  }
  if (result.exitCode !== 0) {
    throw emulatorNotRunnableError(
      `"${call}" exited ${result.exitCode}: ${firstLine(result.stderr) || 'no output'}`
    );
  }
}

/** What one `adb get-state` says about one serial. */
export type EmulatorListing =
  | { kind: 'listed'; state: string }
  | { kind: 'missing' }
  | { kind: 'tool'; error: CommandError }
  | { kind: 'timeout' };

export async function getEmulatorStateAsync(
  tools: DeviceTools,
  serial: string,
  { timeoutMs = ADB_CALL_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<EmulatorListing> {
  const result = await tools.adb(['-s', serial, 'get-state'], { timeoutMs });
  if (result.spawnError) {
    return { kind: 'tool', error: adbNotRunnableError(resolveAdb(), result.spawnError.message) };
  }
  if (result.exitCode == null) {
    return { kind: 'timeout' };
  }
  if (result.exitCode === 0) {
    return { kind: 'listed', state: result.stdout.trim() };
  }
  if (/not found/i.test(result.stderr)) {
    return { kind: 'missing' };
  }
  // An instance that is booting is listed `offline`, which `get-state` reports as an error.
  if (/device (offline|unauthorized|still authorizing)/i.test(result.stderr)) {
    return { kind: 'listed', state: 'offline' };
  }
  return {
    kind: 'tool',
    error: emulatorNotRunnableError(
      `"adb -s ${serial} get-state" exited ${result.exitCode}: ${firstLine(result.stderr) || 'no output'}`
    ),
  };
}
