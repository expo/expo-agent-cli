// @ref llp/0035-one-device-per-worktree.rfc.md §Android boot
// The Android tool calls the registry reads with: the inventory before the lock, and `get-state`
// for one serial, each one `adb` or `emulator` subprocess; and the instance check a `spawned` pid must pass.

import { adbNotRunnableError, parseAndroidDevices, resolveAdb } from '../device/adb';
import { parseAvds } from '../device/bootDevice';
import { CommandError } from '../utils/errors';
import type { SpawnCaptureResult } from '../utils/spawnCapture';
import { firstLine } from '../utils/text';
import type { AndroidInventory } from './choose';
import { deviceUnavailableError } from './errors';
import { bindingPathFor, readBindingFile } from './registry';
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

/** `adb` ran and exited non-zero; one that could not start is `adbNotRunnableError`. */
function adbFailedError(reason: string): CommandError {
  return new CommandError(
    'ADB_FAILED',
    [
      `"adb" failed, so no Android device was looked at.`,
      `Why: ${reason}`,
      `How: fix the error adb printed, then run this command again.`,
    ].join('\n')
  );
}

/** Skip AVD discovery for a bound USB device; the caller rechecks the binding under the lock. */
export async function readAndroidBindingInventoryAsync(
  projectRoot: string,
  tools: DeviceTools,
  explicit: boolean,
  forceAvds: boolean
) {
  const file = bindingPathFor(projectRoot, 'android', 'local-android');
  const explicitSerial = () => {
    const read = readBindingFile(file);
    const device = read.kind === 'binding' ? read.binding.device : null;
    return device?.backend === 'local-android' && device.origin.kind === 'explicit'
      ? device.serial
      : undefined;
  };
  const reuseSerial = forceAvds ? undefined : explicitSerial();
  const inventory = await readAndroidInventoryAsync(tools, { avds: !explicit, reuseSerial });
  return {
    inventory,
    isCurrent: () =>
      reuseSerial === undefined ||
      !inventory.runningSerials.includes(reuseSerial) ||
      explicitSerial() === reuseSerial,
  };
}

/** The Android inventory, read before the lock. @throws the tool error, or `create-timeout`. */
export async function readAndroidInventoryAsync(
  tools: DeviceTools,
  { avds: listAvds = true, reuseSerial }: { avds?: boolean; reuseSerial?: string } = {}
): Promise<AndroidInventory> {
  const devices = await tools.adb(['devices', '-l'], { timeoutMs: ADB_CALL_TIMEOUT_MS });
  if (devices.spawnError) {
    throw adbNotRunnableError(resolveAdb(), devices.spawnError.message);
  }
  assertAnswered(devices, 'adb devices -l', adbFailedError);
  const runningSerials = parseAndroidDevices(devices.stdout).map((device) => device.deviceId);
  const listedSerials = devices.stdout
    .split('\n')
    .slice(1)
    .flatMap((line) => line.trim().split(/\s+/)[0] || []);
  const unready = devices.stdout
    .split('\n')
    .slice(1)
    .flatMap((line) => {
      const [serial, state] = line.trim().split(/\s+/);
      return serial && state && state !== 'device' ? [{ serial, state }] : [];
    });
  if (!listAvds || (reuseSerial !== undefined && runningSerials.includes(reuseSerial)))
    return { avd: null, runningSerials, listedSerials, unready };
  const avds = await tools.emulatorList(['-list-avds'], { timeoutMs: 60_000 });
  if (avds.spawnError) {
    throw emulatorNotRunnableError(avds.spawnError.message);
  }
  assertAnswered(avds, 'emulator -list-avds', emulatorNotRunnableError);
  return {
    avd: parseAvds(avds.stdout)[0] ?? null,
    runningSerials,
    listedSerials,
    unready,
  };
}

function assertAnswered(
  result: SpawnCaptureResult,
  call: string,
  failed: (reason: string) => CommandError
): void {
  if (result.exitCode == null) {
    throw deviceUnavailableError('create-timeout', { platform: 'android' });
  }
  if (result.exitCode !== 0) {
    throw failed(`"${call}" exited ${result.exitCode}: ${firstLine(result.stderr) || 'no output'}`);
  }
}

/**
 * Why a `spawned` binding's instance is gone, or null while its pid is alive and, where `ps` exists,
 * its arguments name the AVD and the ports. Never the binary name: the `emulator` launcher execs
 * `qemu-system-<arch>`, so the pid stays and the name does not.
 */
export function instanceGone(
  tools: DeviceTools,
  { emulatorPid, avd, port }: { emulatorPid: number; avd: string; port: number }
): string | null {
  if (!tools.isPidAlive(emulatorPid)) {
    return `pid ${emulatorPid} is not running`;
  }
  const command = tools.commandOf(emulatorPid);
  const args = ` ${command} `;
  if (
    command != null &&
    !(args.includes(` -avd ${avd} `) && args.includes(` -ports ${port},${port + 1} `))
  ) {
    return `pid ${emulatorPid} is not the emulator instance of ${avd} on port ${port} any more`;
  }
  return null;
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
    error: adbFailedError(
      `"adb -s ${serial} get-state" exited ${result.exitCode}: ${firstLine(result.stderr) || 'no output'}`
    ),
  };
}
