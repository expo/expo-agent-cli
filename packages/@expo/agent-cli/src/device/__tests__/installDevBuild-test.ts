// @ref llp/0005-runtime-loop-tools.rfc.md §The gate installs the app, whichever app it is
//
// Putting this project's development build on a device that has not got it. This used to be a
// refusal that named `@expo/agent-cli dev --<platform> --yes` — a correct instruction and a dead
// end for an agent, which cannot take it without leaving the loop the command exists to serve
// [Kudo, 2026-09-04: "smoke should be self-served without running dev first"].
//
// What is worth testing is the argv, because the argv is the whole design: `expo run:<platform>`
// already builds what is missing and installs it, and two flags are what make it usable from
// inside a run that is already under way.

import { androidDeviceNameAsync, installDevBuildAsync } from '../installDevBuild';

/** One `adb` run's result, with the fields the name reader looks at. */
function ranAdb(over: Partial<{ stdout: string; exitCode: number | null; notRunnable: boolean }>) {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    notRunnable: false,
    adb: { bin: 'adb', source: 'PATH' as const, searched: [], fromPathOnly: false },
    ...over,
  };
}

/** A capture result, with the fields a caller reads. */
function captured(over: Partial<{ stdout: string; stderr: string; exitCode: number | null }> = {}) {
  return { stdout: '', stderr: '', exitCode: 0, ...over };
}

describe(installDevBuildAsync, () => {
  it(`builds and installs for ios, on the run's own simulator`, async () => {
    const calls: { command: string; args: string[]; cwd?: string }[] = [];

    const result = await installDevBuildAsync('/project', 'ios', 'SIM-1', {
      spawn: async (command, args, options) => {
        calls.push({ command, args, cwd: options?.cwd });
        return captured();
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        command: 'npx',
        // `--no-bundler`, because this run already has a dev server and a second Metro would be a
        // second answer to "which bundle is the app under test running". `--device`, so the app
        // lands where the rest of the run is looking. Both read off the published binary
        // [observed — `npx expo run:ios --help`, 2026-09-04]. iOS takes the udid directly.
        args: ['expo', 'run:ios', '--no-bundler', '--device', 'SIM-1'],
        // The project it is standing in, because that is the one `expo run:*` reads.
        cwd: '/project',
      },
    ]);
  });

  // @ref ../installDevBuild §androidDeviceNameAsync — the asymmetry that cost a live run: Android's
  // `--device` takes a **name**, and an `adb` serial is answered with `Could not find device with
  // name: emulator-5554` [observed, 2026-09-04].
  it(`names the emulator by its AVD for android, not by its serial`, async () => {
    const calls: string[][] = [];

    const result = await installDevBuildAsync('/project', 'android', 'emulator-5554', {
      spawn: async (command, args) => {
        calls.push([command, ...args]);
        return captured();
      },
      run: async () => ranAdb({ stdout: 'tuft-pixel\nOK\n' }),
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      ['npx', 'expo', 'run:android', '--no-bundler', '--device', 'tuft-pixel'],
    ]);
  });

  // A device that cannot be named gets no `--device` at all, because a wrong one is a refusal and
  // the command picks the attached device itself.
  it(`passes no device for an android device it could not name`, async () => {
    const calls: string[][] = [];

    await installDevBuildAsync('/project', 'android', 'emulator-5554', {
      spawn: async (command, args) => {
        calls.push([command, ...args]);
        return captured();
      },
      run: async () => ranAdb({ notRunnable: true, exitCode: null }),
    });

    expect(calls).toEqual([['npx', 'expo', 'run:android', '--no-bundler']]);
  });

  // Never `@expo/agent-cli dev`: that plans *and starts a dev server*, which is the thing this run
  // has already done. Asking for it from inside the install phase would start a second one.
  it(`never asks for a second dev server`, async () => {
    const calls: string[][] = [];
    await installDevBuildAsync('/project', 'ios', 'SIM-1', {
      spawn: async (command, args) => {
        calls.push([command, ...args]);
        return captured();
      },
    });

    expect(calls.some((argv) => argv.includes('start'))).toBe(false);
    expect(calls.some((argv) => argv.includes('dev'))).toBe(false);
    expect(calls.every((argv) => argv.includes('--no-bundler'))).toBe(true);
  });

  // A native build fails for the project's own reasons — a compiler error, a missing pod — and the
  // CLI's own last line names the file. Quoted rather than replaced.
  it(`quotes what the build said when it failed`, async () => {
    const result = await installDevBuildAsync('/project', 'ios', 'SIM-1', {
      spawn: async () =>
        captured({
          exitCode: 1,
          stderr: "error: Build input file cannot be found: '/project/ios/App/Missing.m'",
        }),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Build input file cannot be found');
    // And the command, so a reader can run it themselves and watch the whole thing.
    expect(result.command).toBe('npx expo run:ios --no-bundler --device SIM-1');
  });

  it(`reports an Expo CLI that could not be started at all`, async () => {
    const result = await installDevBuildAsync('/project', 'ios', 'SIM-1', {
      spawn: async () => ({
        ...captured({ exitCode: null }),
        spawnError: Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' }),
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ENOENT');
  });

  // @ref ../installDevBuild §BUILD_TIMEOUT_MS. The budget of a compile, not of an install: a cold
  // `expo run:ios` is a pod install and a full native build, and a bound that is too short is the
  // worst failure this command has — minutes spent and then a timeout for a build that was fine.
  it(`gives the build a compile-sized budget`, async () => {
    let timeoutMs: number | undefined;
    await installDevBuildAsync('/project', 'ios', 'SIM-1', {
      spawn: async (_command, _args, options) => {
        timeoutMs = options?.timeoutMs;
        return captured();
      },
    });

    expect(timeoutMs).toBe(1_800_000);
  });
});

// @ref ../installDevBuild §androidDeviceNameAsync
//
// The two questions `@expo/cli`'s own device list asks, in the same order
// [reference — `src/start/platforms/android/adb.ts` §getAttachedDevicesAsync]: an emulator is its
// AVD name, a physical device is the `model:` field of `adb devices -l`.
describe(androidDeviceNameAsync, () => {
  it(`asks the emulator console for its AVD name, ignoring the OK acknowledgement`, async () => {
    const calls: string[][] = [];

    const name = await androidDeviceNameAsync('emulator-5554', {
      run: async (args) => {
        calls.push(args);
        return ranAdb({ stdout: 'tuft-pixel\nOK\n' });
      },
    });

    expect(name).toBe('tuft-pixel');
    expect(calls).toEqual([['-s', 'emulator-5554', 'emu', 'avd', 'name']]);
  });

  it(`reads a physical device's model out of the device list`, async () => {
    const name = await androidDeviceNameAsync('R58M1234567', {
      run: async () =>
        ranAdb({
          stdout: [
            'List of devices attached',
            'R58M1234567\tdevice product:a52qxx model:SM_A525F device:a52q transport_id:3',
          ].join('\n'),
        }),
    });

    expect(name).toBe('SM_A525F');
  });

  it(`answers null for a serial the device list does not carry`, async () => {
    const name = await androidDeviceNameAsync('R58M1234567', {
      run: async () => ranAdb({ stdout: 'List of devices attached\n' }),
    });

    expect(name).toBeNull();
  });

  it(`answers null when adb could not be run`, async () => {
    const name = await androidDeviceNameAsync('emulator-5554', {
      run: async () => ranAdb({ notRunnable: true, exitCode: null }),
    });

    expect(name).toBeNull();
  });
});
