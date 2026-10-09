// @ref llp/0005-runtime-loop-tools.rfc.md §The run brings its own environment
// @ref llp/0030-one-device-per-worktree.rfc.md §Entry points
// What a boot needs that is not the boot itself: the budget per platform, and the Android SDK's
// `emulator` and its AVD list. The boots are the device registry's (`src/deviceBinding/`): a
// simulator this worktree created, or an emulator instance it spawned on its own console port.

import fs from 'fs';
import path from 'path';

import type { AdbResolution } from './adb';

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

/** Read the AVD names out of `emulator -list-avds`. */
export function parseAvds(stdout: string): string[] {
  return (
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      // The tool prints its own warnings to stdout on some SDKs, and none of them is an AVD name.
      .filter((line) => line.length > 0 && !line.includes(' '))
  );
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
