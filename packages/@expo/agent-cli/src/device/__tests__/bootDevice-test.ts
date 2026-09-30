// @ref llp/0005-runtime-loop-tools.rfc.md §The run brings its own environment
// @ref llp/0028-one-device-per-agent.rfc.md §Android boot
// The parsers and the order the claim ranks simulators in, and the emulator boot argv. Pinned here
// with no Xcode and no Android SDK involved.

import path from 'path';

import {
  bootEmulatorAsync,
  emulatorPort,
  emulatorSerial,
  findFreeEmulatorPortAsync,
  parseAvds,
  parseSimulators,
  compareSimulators,
  resolveEmulator,
  type SimulatorEntry,
} from '../bootDevice';
import { fakeDeviceTools } from './fakeDeviceTools';

/** A `simctl list devices -j` payload, in the shape the real tool prints. */
function listing(devices: Record<string, unknown[]>): string {
  return JSON.stringify({ devices });
}

function simulator(overrides: Partial<SimulatorEntry> = {}): SimulatorEntry {
  return {
    udid: 'SIM-1',
    name: 'iPhone 17 Pro',
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    version: [26, 5],
    state: 'Shutdown',
    isAvailable: true,
    lastBootedAt: 0,
    ...overrides,
  };
}

describe(parseSimulators, () => {
  it(`reads the devices of every iOS runtime`, () => {
    const parsed = parseSimulators(
      listing({
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
          { udid: 'A', name: 'iPhone 17 Pro', state: 'Shutdown' },
        ],
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
          { udid: 'B', name: 'iPhone 15', state: 'Booted' },
        ],
      })
    );

    expect(parsed).toEqual([
      expect.objectContaining({ udid: 'A', version: [26, 5], isAvailable: true }),
      expect.objectContaining({ udid: 'B', version: [18, 0], state: 'Booted' }),
    ]);
  });

  // A device that has never been booted has no apps on it, and `simctl` says so by omitting the
  // key rather than by any value — so the absence has to read as "never", not as "unknown".
  it(`reads lastBootedAt, and zero for a device that has never been booted`, () => {
    const parsed = parseSimulators(
      listing({
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
          { udid: 'A', name: 'iPhone 17 Pro', lastBootedAt: '2026-08-26T04:50:48Z' },
          { udid: 'B', name: 'iPhone Air' },
        ],
      })
    );

    expect(parsed.map((entry) => entry.lastBootedAt)).toEqual([
      Date.parse('2026-08-26T04:50:48Z'),
      0,
    ]);
  });

  // A booted watchOS simulator cannot run this project's app, and a minute spent booting one is a
  // minute followed by a failure in every phase after it.
  it(`reads no runtime that is not iOS`, () => {
    expect(
      parseSimulators(
        listing({
          'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: 'W', name: 'Apple Watch' }],
          'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [{ udid: 'T', name: 'Apple TV' }],
        })
      )
    ).toEqual([]);
  });

  // `simctl` omits `isAvailable` for the ordinary case and sets it false for a device whose runtime
  // has been removed. Reading the absence as "unavailable" would find no simulator on a healthy Mac.
  it(`treats a missing isAvailable as available, and false as not`, () => {
    const parsed = parseSimulators(
      listing({
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
          { udid: 'A', name: 'iPhone 17 Pro' },
          { udid: 'B', name: 'iPhone 15', isAvailable: false },
        ],
      })
    );

    expect(parsed.map((entry) => entry.isAvailable)).toEqual([true, false]);
  });

  it(`answers nothing for output that is not the JSON this asked for`, () => {
    expect(parseSimulators('xcrun: error: unable to find utility "simctl"')).toEqual([]);
    expect(parseSimulators('')).toEqual([]);
  });
});

describe(compareSimulators, () => {
  const first = (simulators: SimulatorEntry[]) => [...simulators].sort(compareSimulators)[0]?.udid;

  // The rule, and it is about **installed apps** rather than about recency. Expo Go and a
  // development build both live on one device, so a simulator nobody has booted is a device the
  // `app` phase could never have answered against — and this machine lists ten of them beside the
  // one in use.
  it(`puts the simulator this developer last used before a newer one nobody has`, () => {
    expect(
      first([
        simulator({ udid: 'FRESH', name: 'iPhone 17 Pro Max', version: [26, 5], lastBootedAt: 0 }),
        simulator({
          udid: 'IN-USE',
          name: 'iPhone 17 Pro',
          version: [26, 5],
          lastBootedAt: Date.parse('2026-08-26T04:50:48Z'),
        }),
      ])
    ).toBe('IN-USE');
  });

  it(`puts an iPhone on the newest runtime first`, () => {
    expect(
      first([
        simulator({ udid: 'OLD-PHONE', name: 'iPhone 15', version: [18, 0] }),
        simulator({ udid: 'NEW-PAD', name: 'iPad Pro 13-inch', version: [26, 5] }),
        simulator({ udid: 'NEW-PHONE', name: 'iPhone 17 Pro', version: [26, 5] }),
      ])
    ).toBe('NEW-PHONE');
  });
});

describe(parseAvds, () => {
  it(`reads one name per line`, () => {
    expect(parseAvds('Pixel_7_API_35\ntuft-pixel\n')).toEqual(['Pixel_7_API_35', 'tuft-pixel']);
  });

  // Some SDK versions print their own advice to stdout beside the names. Every line of it has a
  // space in it and no AVD name does, which is what tells them apart without a version check.
  it(`reads none of the advice the tool prints beside them`, () => {
    expect(
      parseAvds(
        [
          'INFO    | Storing crashdata in: /tmp/foo',
          'tuft-pixel',
          '',
          'The following AVDs have an unknown device type:',
        ].join('\n')
      )
    ).toEqual(['tuft-pixel']);
  });
});

// The copy belonging to the SDK the rest of this CLI uses. Two Android SDKs on one machine is
// common, and an AVD created in one is not listed by the other — so a bare `emulator` from `PATH`
// would report "no virtual device" on a machine with one.
describe(resolveEmulator, () => {
  const adb = {
    bin: '/Users/dev/Library/Android/sdk/platform-tools/adb',
    source: 'ANDROID_HOME' as const,
    searched: [],
    fromPathOnly: false,
  };

  it(`takes the emulator beside the resolved adb when the SDK has one`, () => {
    const executable = process.platform === 'win32' ? 'emulator.exe' : 'emulator';
    expect(resolveEmulator(adb, { exists: () => true })).toBe(
      path.join('/Users/dev/Library/Android/sdk', 'emulator', executable)
    );
  });

  it(`falls back to the bare name, so PATH can still supply one`, () => {
    expect(resolveEmulator(adb, { exists: () => false })).toBe(
      process.platform === 'win32' ? 'emulator.exe' : 'emulator'
    );
  });
});

// @ref llp/0028-one-device-per-agent.rfc.md §Android boot
describe(findFreeEmulatorPortAsync, () => {
  it(`takes the first even port whose adb port is free too`, async () => {
    const taken = new Set([5554, 5557]);
    expect(await findFreeEmulatorPortAsync({ isFree: async (port) => !taken.has(port) })).toBe(
      5558
    );
  });

  it(`skips the ports the caller names`, async () => {
    expect(
      await findFreeEmulatorPortAsync({ isFree: async () => true, skip: (port) => port === 5554 })
    ).toBe(5556);
  });

  it(`answers null when all sixteen are taken`, async () => {
    expect(await findFreeEmulatorPortAsync({ isFree: async () => false })).toBeNull();
  });
});

describe(emulatorPort, () => {
  it(`reads the console port out of an emulator serial, and nothing else`, () => {
    expect(emulatorPort(emulatorSerial(5560))).toBe(5560);
    expect(emulatorPort('R58M123ABC')).toBeNull();
  });
});

describe(bootEmulatorAsync, () => {
  const adb = { bin: 'adb', source: 'PATH' as const, searched: [], fromPathOnly: true };

  it(`starts the AVD on the ports it was given, and waits on that serial`, async () => {
    const tools = fakeDeviceTools((_command, args) =>
      args.includes('sys.boot_completed') ? { stdout: '1\n' } : {}
    );
    const result = await bootEmulatorAsync(
      { avd: 'Pixel_8', port: 5558, readOnly: false },
      { timeoutMs: 1_000, adb }
    );
    expect(result).toMatchObject({ ok: true, deviceId: 'emulator-5558', name: 'Pixel_8' });
    expect(tools.callsWith('-avd ')).toEqual([
      'emulator -avd Pixel_8 -ports 5558,5559 -no-snapshot-save',
    ]);
    expect(tools.callsWith('getprop')).toEqual([
      'adb -s emulator-5558 shell getprop sys.boot_completed',
    ]);
  });

  it(`fails at once, with the exit code, when the emulator exits before it boots`, async () => {
    fakeDeviceTools((command) => (command === 'emulator' ? { exitCode: 1 } : {}));
    const started = Date.now();

    const result = await bootEmulatorAsync(
      { avd: 'Pixel_8', port: 5556, readOnly: true },
      { timeoutMs: 600_000, adb }
    );

    expect(result).toMatchObject({ ok: false, deviceId: 'emulator-5556' });
    expect(result.reason).toContain('exited with code 1');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it(`keeps waiting when the emulator launcher exits 0`, async () => {
    let probes = 0;
    fakeDeviceTools((command, args) => {
      if (command === 'emulator') {
        return { exitCode: 0 };
      }
      if (args.includes('sys.boot_completed')) {
        probes += 1;
        return { stdout: '1\n' };
      }
      return {};
    });

    const result = await bootEmulatorAsync(
      { avd: 'Pixel_8', port: 5556, readOnly: false },
      { timeoutMs: 1_000, adb }
    );

    expect(result).toMatchObject({ ok: true });
    expect(probes).toBe(1);
  });

  it(`starts a second instance of a running AVD read-only`, async () => {
    const tools = fakeDeviceTools((_command, args) =>
      args.includes('sys.boot_completed') ? { stdout: '1\n' } : {}
    );
    await bootEmulatorAsync(
      { avd: 'Pixel_8', port: 5556, readOnly: true },
      { timeoutMs: 1_000, adb }
    );
    expect(tools.callsWith('-avd ')).toEqual([
      'emulator -avd Pixel_8 -ports 5556,5557 -no-snapshot-save -read-only',
    ]);
  });
});
