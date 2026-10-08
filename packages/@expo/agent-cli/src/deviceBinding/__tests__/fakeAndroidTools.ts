// The Android half of `fakeTools`: an `adb` and an `emulator` that keep instance state the way the
// real ones do, so a test reads calls and state rather than mocking one function per call.

import type { SpawnCaptureResult } from '../../utils/spawnCapture';
import type { DeviceTools, EmulatorHandle } from '../types';

export const AVD = 'Pixel_9';

export interface FakeEmulator {
  serial: string;
  /** What `adb` lists and `get-state` answers; `offline` is an instance still booting. */
  state: 'device' | 'offline';
  /** The pid `isPidAlive` answers for. Absent for a device that is not an instance of ours. */
  pid?: number;
  /** The command line `commandOf` answers; defaults to the one the spawn wrote. */
  command?: string;
}

export interface FakeAndroidOptions {
  emulators?: FakeEmulator[];
  avds?: string[];
  /** Every `adb` call fails to spawn. */
  adbSpawnError?: boolean;
  /** Every `get-state` times out. */
  stateTimesOut?: boolean;
  /** The spawned child has no pid. */
  spawnFails?: boolean;
  /** The spawned child exits with this code at once. */
  exitsWith?: number;
  /** `sys.boot_completed` never answers 1. */
  neverBoots?: boolean;
  /** `ps` is not available, as on Windows. */
  noPs?: boolean;
  /** Pids `isPidAlive` answers true for; defaults to every listed instance's pid. */
  alivePids?: number[];
}

export interface FakeAndroid {
  adb: DeviceTools['adb'];
  emulatorList: DeviceTools['emulatorList'];
  spawnEmulator: DeviceTools['spawnEmulator'];
  isPidAlive: DeviceTools['isPidAlive'];
  commandOf: DeviceTools['commandOf'];
  kill: DeviceTools['kill'];
  androidCalls: string[][];
  emulators: FakeEmulator[];
  spawned: string[][];
  killed: number[];
}

export function fakeAndroid(
  {
    emulators = [],
    avds = [AVD],
    adbSpawnError = false,
    stateTimesOut = false,
    spawnFails = false,
    exitsWith,
    neverBoots = false,
    noPs = false,
    alivePids,
  }: FakeAndroidOptions,
  record: (call: string[]) => void
): FakeAndroid {
  const state = emulators.map((emulator) => ({ ...emulator }));
  const androidCalls: string[][] = [];
  const spawned: string[][] = [];
  const killed: number[] = [];
  const alive = new Set(alivePids ?? state.flatMap((e) => (e.pid == null ? [] : [e.pid])));
  let nextPid = 4000;
  const ok = (stdout = ''): SpawnCaptureResult => ({ stdout, stderr: '', exitCode: 0 });

  const adb: DeviceTools['adb'] = async (args) => {
    androidCalls.push(args);
    record(args);
    if (adbSpawnError) {
      return {
        stdout: '',
        stderr: '',
        exitCode: null,
        spawnError: Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' }),
      };
    }
    if (args[0] === 'devices') {
      const lines = state.map((e) => `${e.serial}\t${e.state} model:sdk_gphone64_arm64`);
      return ok(['List of devices attached', ...lines, ''].join('\n'));
    }
    const serial = args[1]!;
    const emulator = state.find((e) => e.serial === serial);
    if (args[2] === 'get-state') {
      if (stateTimesOut) {
        return { stdout: '', stderr: '', exitCode: null };
      }
      if (!emulator) {
        return { stdout: '', stderr: `error: device '${serial}' not found\n`, exitCode: 1 };
      }
      return emulator.state === 'device'
        ? ok('device\n')
        : { stdout: '', stderr: 'error: device offline\n', exitCode: 1 };
    }
    if (args[2] === 'shell' && args[4] === 'sys.boot_completed') {
      if (!emulator) {
        return { stdout: '', stderr: `error: device '${serial}' not found\n`, exitCode: 1 };
      }
      return ok(neverBoots ? '\n' : '1\n');
    }
    return { stdout: '', stderr: `unexpected ${args.join(' ')}\n`, exitCode: 2 };
  };

  const emulatorList: DeviceTools['emulatorList'] = async (args) => {
    record(['emulator', ...args]);
    return ok(`${avds.join('\n')}\n`);
  };

  const spawnEmulator = (args: string[]): EmulatorHandle => {
    record(['emulator', ...args]);
    spawned.push(args);
    if (spawnFails) {
      return { exited: Promise.resolve(null), kill: () => {} };
    }
    const pid = (nextPid += 1);
    const port = Number(args[args.indexOf('-ports') + 1]!.split(',')[0]);
    const serial = `emulator-${port}`;
    if (exitsWith == null) {
      alive.add(pid);
      state.push({
        serial,
        state: 'device',
        pid,
        command: `qemu-system-aarch64 ${args.join(' ')}`,
      });
    }
    return {
      pid,
      exited: exitsWith == null ? new Promise(() => {}) : Promise.resolve(exitsWith),
      kill: () => {
        killed.push(pid);
        alive.delete(pid);
      },
    };
  };

  return {
    adb,
    emulatorList,
    spawnEmulator,
    isPidAlive: (pid) => alive.has(pid),
    commandOf: (pid) =>
      noPs ? null : (state.find((e) => e.pid === pid)?.command ?? (alive.has(pid) ? 'node' : '')),
    kill: (pid) => {
      killed.push(pid);
      alive.delete(pid);
    },
    androidCalls,
    emulators: state,
    spawned,
    killed,
  };
}
