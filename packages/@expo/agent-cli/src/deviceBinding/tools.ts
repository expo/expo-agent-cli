// @ref llp/0035-one-device-per-worktree.rfc.md §Records
// The platform tools the registry drives, as subprocesses. Injected in tests.

import { spawn, spawnSync } from 'child_process';

import { resolveAdb } from '../device/adb';
import { resolveEmulator } from '../device/bootDevice';
import { spawnCaptureAsync } from '../utils/spawnCapture';
import { resolveSpawnTarget, windowsTaskkillCommand } from '../utils/windowsShim';
import type { DeviceTools, EmulatorHandle } from './types';

export function defaultTools(): DeviceTools {
  const adb = resolveAdb();
  const emulator = resolveEmulator(adb);
  return {
    simctl: (args, options) => spawnCaptureAsync('xcrun', ['simctl', ...args], options),
    adb: (args, options) => spawnCaptureAsync(adb.bin, args, options),
    emulatorList: (args, options) => spawnCaptureAsync(emulator, args, options),
    spawnEmulator: (args) => spawnEmulator(emulator, args),
    now: () => new Date(),
    isPidAlive,
    commandOf,
    kill: killEmulator,
  };
}

/**
 * Detached, with its output dropped and the handle unreferenced, so the instance outlives this
 * process; a pipe nobody reads would fill up and block the emulator. A Windows `.cmd` starts under
 * `cmd.exe`, so the pid is the shell's and {@link killEmulator} takes its tree.
 */
function spawnEmulator(emulator: string, args: string[]): EmulatorHandle {
  let child: ReturnType<typeof spawn>;
  try {
    const target = resolveSpawnTarget(emulator, args);
    child = spawn(target.command, target.args, {
      detached: true,
      stdio: 'ignore',
      shell: target.shell,
    });
  } catch {
    return { exited: Promise.resolve(null), kill: () => {} };
  }
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('exit', (code) => resolve(code));
  });
  child.unref();
  return {
    pid: child.pid,
    exited,
    kill: () => {
      try {
        if (child.pid != null) {
          killEmulator(child.pid);
        }
      } catch {
        // Already gone.
      }
    },
  };
}

/** On Windows `/T` also ends what the pid started: the emulator under a `.cmd` shim's `cmd.exe`. */
export function killEmulator(pid: number): void {
  if (process.platform !== 'win32') {
    process.kill(pid, 'SIGTERM');
    return;
  }
  const result = spawnSync(windowsTaskkillCommand(), ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`taskkill /PID ${pid} exited with ${result.status}`);
  }
}

/** `EPERM` is a process this user may not signal, which is a process that is there. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

/** Null where `ps` does not exist (Windows, or a host without it); '' for a pid it does not list. */
export function commandOf(pid: number): string | null {
  if (process.platform === 'win32') {
    return null;
  }
  try {
    const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    if (result?.error) {
      return null;
    }
    return result?.status === 0 ? (result.stdout ?? '').trim() : '';
  } catch {
    return null;
  }
}
