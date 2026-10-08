// @ref llp/0005-runtime-loop-tools.rfc.md §The run brings its own environment
// Boot an Android emulator, and shut one down again. The iOS simulator is the worktree's bound
// one, booted by the device registry (`src/deviceBinding/`); Android follows with llp/0032.
//
// The device probes next door (`src/navigate/device.ts`) answer "is there one", which is all every
// command before this needed: a run that found none reported that and stopped. `smoke` now brings
// its own, so somebody has to answer "make one", and this is the module that does — through the
// same platform tools as subprocesses, with no emulator library linked in.
//
// **Only what this module started is ever shut down.** Nothing here decides that; the caller does
// (`src/smoke/phases.ts`). What this module guarantees is the other half of it: `bootAsync` reports
// the id it booted before it waits for anything, so a boot that hangs is still a device its caller
// knows it is holding.
//
// Two live facts are pinned here rather than rediscovered, and each of them cost somebody a run:
//
//  1. **`-ports 5554,5555` on the emulator.** Without it the emulator binds ephemeral ports and
//     `adb devices` never lists it at all — not "offline", *absent* [observed — friction run 6,
//     F62, and again on 2026-08-27]. So the serial is known before the boot rather than after.
//  2. **`sys.boot_completed`, not `adb devices`.** `adb` reports the serial as `offline` for the
//     first seconds and then `device`, and Android itself is up later still. An `adb shell` before
//     that answers `device offline`.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { spawnCaptureAsync } from '../utils/spawnCapture';
import { firstLine } from '../utils/text';
import { resolveAdb, runAdbAsync, type AdbResolution } from './adb';

/** The serial an emulator started with `-ports 5554,5555` is always listed under. */
export const EMULATOR_SERIAL = 'emulator-5554';

/**
 * How long a boot may take, per platform, before it is called a failure.
 *
 * Both are measured rather than chosen. A cold iOS simulator takes roughly a minute; an Android
 * emulator takes several, which is why the live tier waits four. Generous, because the cost of a
 * bound that is too short is a boot failure reported for a device that was coming up fine.
 */
export const BOOT_DEVICE_TIMEOUT_MS: Record<'ios' | 'android', number> = {
  ios: 120_000,
  android: 240_000,
};

/** How often a boot wait re-asks the device whether it is up. */
const BOOT_POLL_MS = 2_000;

/** What one boot amounted to. Never throws: a device that would not come up is a result. */
export interface BootDeviceResult {
  ok: boolean;
  /** The device that came up, or the one that was asked to and did not. */
  deviceId: string | null;
  backend: 'local-android' | null;
  /** The name a person would recognise it by, when the tool reported one. */
  name: string | null;
  /** Why none came up, as one sentence. Null exactly when {@link ok} is true. */
  reason: string | null;
  /**
   * Why this device was chosen, for a report that has to explain itself.
   *
   * Null when none was. One clause, in the terms of the rule that picked it.
   */
  choice: string | null;
}

/** What one shutdown amounted to. Never throws, for the same reason. */
export interface ShutdownDeviceResult {
  ok: boolean;
  reason: string | null;
}

export interface BootDeviceOptions {
  /** How long the boot may take before it is called a failure. */
  timeoutMs: number;
  /**
   * Told the id as soon as there is one, and before the device is touched.
   *
   * The caller registers its cleanup from here, so a boot that is issued and then hangs is still
   * a device somebody is responsible for shutting down.
   */
  onBooting?: (device: { deviceId: string; backend: 'local-android' }) => void;
  /** The clock, so a test can drive the wait without one. */
  now?: () => number;
  /** Injected for the tests: the emulator this host would spawn. */
  adb?: AdbResolution;
}

/** Read the AVD names out of `emulator -list-avds`. */
export function parseAvds(stdout: string): string[] {
  return (
    stdout
      .split('\n')
      .map((line) => line.trim())
      // The tool prints its own warnings to stdout on some SDKs, and none of them is an AVD name.
      .filter((line) => line.length > 0 && !line.includes(' '))
  );
}

/**
 * Boot an emulator, and wait until it will answer.
 *
 * @returns what came up, or why nothing did. Never rejects.
 */
export async function bootDeviceAsync(
  _platform: 'android',
  options: BootDeviceOptions
): Promise<BootDeviceResult> {
  return await bootEmulatorAsync(options);
}

/** Shut down an emulator this process booted. Never rejects. */
export async function shutdownDeviceAsync(
  deviceId: string,
  { adb }: { adb?: AdbResolution } = {}
): Promise<ShutdownDeviceResult> {
  const result = await runAdbAsync(['-s', deviceId, 'emu', 'kill'], {
    adb,
    timeoutMs: 60_000,
  });
  if (result.notRunnable) {
    return {
      ok: false,
      reason: `"adb" could not be run (${result.spawnError?.message ?? 'no reason given'})`,
    };
  }
  return result.exitCode === 0
    ? { ok: true, reason: null }
    : {
        ok: false,
        reason: `"${result.adb.bin} -s ${deviceId} emu kill" exited ${result.exitCode}: ${firstLine(result.stderr) || 'no output'}`,
      };
}

/** Pick an AVD, spawn the emulator detached, and poll `sys.boot_completed`. */
async function bootEmulatorAsync({
  timeoutMs,
  onBooting,
  now = Date.now,
  adb: given,
}: BootDeviceOptions): Promise<BootDeviceResult> {
  const none = (reason: string): BootDeviceResult => ({
    ok: false,
    deviceId: null,
    backend: null,
    name: null,
    reason,
    choice: null,
  });

  const adb = given ?? resolveAdb();
  const emulator = resolveEmulator(adb);
  const listed = await spawnCaptureAsync(emulator, ['-list-avds'], { timeoutMs: 60_000 });
  if (listed.spawnError) {
    return none(
      `could not run "${emulator}", so no emulator could be started: ${listed.spawnError.message}. Install the Android SDK's emulator package, or set ANDROID_HOME`
    );
  }
  const avd = parseAvds(listed.stdout)[0];
  if (avd == null) {
    return none(
      `this machine has no Android virtual device to start. Create one in Android Studio's Device Manager, then run this command again`
    );
  }

  // @ref ./bootDevice — `-ports 5554,5555`, without which `adb` never lists the emulator at all.
  // The serial is therefore known before the boot, which is what lets the cleanup be registered
  // here rather than after a wait that may never finish.
  onBooting?.({ deviceId: EMULATOR_SERIAL, backend: 'local-android' });

  let spawnFailure: string | null = null;
  try {
    const child = spawn(emulator, ['-avd', avd, '-ports', '5554,5555', '-no-snapshot-save'], {
      detached: true,
      // The emulator's own output is not this run's report, and a pipe nobody reads fills up and
      // blocks it. It logs to the Android SDK's own files either way.
      stdio: 'ignore',
    });
    child.on('error', (error: Error) => {
      spawnFailure = error.message;
    });
    child.unref();
  } catch (error: unknown) {
    return none(
      `"${emulator} -avd ${avd}" could not be started: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const choice = 'it is the only Android virtual device this machine has';
  const deadline = now() + timeoutMs;
  for (;;) {
    if (spawnFailure != null) {
      return {
        ok: false,
        deviceId: EMULATOR_SERIAL,
        backend: 'local-android',
        name: avd,
        reason: `"${emulator} -avd ${avd}" could not be started: ${spawnFailure}`,
        choice,
      };
    }
    const probe = await runAdbAsync(
      ['-s', EMULATOR_SERIAL, 'shell', 'getprop', 'sys.boot_completed'],
      { adb, timeoutMs: 30_000 }
    );
    if (probe.exitCode === 0 && probe.stdout.trim() === '1') {
      return {
        ok: true,
        deviceId: EMULATOR_SERIAL,
        backend: 'local-android',
        name: avd,
        reason: null,
        choice,
      };
    }
    if (now() >= deadline) {
      return {
        ok: false,
        deviceId: EMULATOR_SERIAL,
        backend: 'local-android',
        name: avd,
        reason: `the emulator ${avd} did not finish booting within ${timeoutMs}ms — "${adb.bin} -s ${EMULATOR_SERIAL} shell getprop sys.boot_completed" never answered 1`,
        choice,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, BOOT_POLL_MS));
  }
}

/**
 * The `emulator` binary to spawn.
 *
 * Beside the resolved `adb` when the SDK holds one, because that is the copy belonging to the SDK
 * every other Android call in this CLI uses — a bare `emulator` on `PATH` can be a different SDK's,
 * and an AVD created in one is not listed by the other.
 */
export function resolveEmulator(
  adb: AdbResolution,
  { exists = fs.existsSync }: { exists?: (candidate: string) => boolean } = {}
): string {
  const executable = process.platform === 'win32' ? 'emulator.exe' : 'emulator';
  const beside = path.join(path.dirname(path.dirname(adb.bin)), 'emulator', executable);
  return exists(beside) ? beside : executable;
}
