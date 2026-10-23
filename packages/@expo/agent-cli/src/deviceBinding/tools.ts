// @ref llp/0035-one-device-per-worktree.rfc.md §Records
// The platform tools the registry drives, as subprocesses. Injected in tests.

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { stopEasSessionAsync } from '../device/eas';
import { resolveAdb } from '../device/adb';
import { resolveEmulator } from '../device/bootDevice';
import { spawnCaptureAsync } from '../utils/spawnCapture';
import { resolveSpawnTarget, windowsTaskkillCommand } from '../utils/windowsShim';
import type { DeviceTools, EmulatorHandle } from './types';

export function defaultTools(): DeviceTools {
  const adb = resolveAdb();
  const emulator = resolveEmulator(adb);
  return {
    stopCloud: stopEasSessionAsync,
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
 * Detached, with its output in a log file and the handle unreferenced, so the instance outlives
 * this process; a pipe nobody reads would fill up and block the emulator. A Windows `.cmd` starts
 * under `cmd.exe`, so the pid is the shell's and {@link killEmulator} takes its tree.
 */
function spawnEmulator(emulator: string, args: string[]): EmulatorHandle {
  const port = args[args.indexOf('-ports') + 1]?.split(',')[0];
  const log = path.join(os.tmpdir(), `agent-cli-emulator-${port}.log`);
  const output = openLog(log);
  let spawnError: string | null = null;
  const lastOutput = () =>
    spawnError ?? (output === 'ignore' ? null : lastLineOf(log)) ?? 'it printed nothing';
  let child: ReturnType<typeof spawn>;
  try {
    const target = resolveSpawnTarget(emulator, args);
    child = spawn(target.command, target.args, {
      detached: true,
      stdio: ['ignore', output, output],
      shell: target.shell,
    });
  } catch (error: unknown) {
    spawnError = error instanceof Error ? error.message : String(error);
    return { exited: Promise.resolve(null), kill: () => {}, lastOutput };
  } finally {
    if (output !== 'ignore') {
      fs.closeSync(output);
    }
  }
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      spawnError = error.message;
      resolve(null);
    });
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
    lastOutput,
  };
}

/** Truncated at each spawn on its port; without it the output is dropped. */
function openLog(log: string): number | 'ignore' {
  try {
    return fs.openSync(log, 'w');
  } catch {
    return 'ignore';
  }
}

function lastLineOf(log: string): string | null {
  try {
    const lines = fs.readFileSync(log, 'utf8').split(/\r?\n/);
    const last = lines.findLast((line) => line.trim() !== '');
    return last ? `${last.trim()} (full output in ${log})` : null;
  } catch {
    return null;
  }
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
