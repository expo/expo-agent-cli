// @ref llp/0005-runtime-loop-tools.rfc.md §The run brings its own environment
// The two choices this module makes before it touches anything: which simulator to boot, and which
// AVD to start. Both are pure functions of a tool's output, and both can be wrong in a way that
// costs a minute of a real run and then fails against the device it picked — so they are pinned
// here, with no Xcode and no Android SDK involved.

import path from 'path';

import { EMULATOR_SERIAL, parseAvds, resolveEmulator } from '../bootDevice';
import { parseSimulators } from '../simulators';

/** A `simctl list devices -j` payload, in the shape the real tool prints. */
function listing(devices: Record<string, unknown[]>): string {
  return JSON.stringify({ devices });
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

// @ref src/device/bootDevice.ts — friction run 6, F62. An emulator started without
// `-ports 5554,5555` binds ephemeral ports and `adb devices` never lists it *at all*. The serial
// is therefore knowable before the boot, which is the only reason the cleanup can be registered
// before the device is touched.
describe('the serial an emulator this CLI starts is always on', () => {
  it(`is the one the -ports argument pins`, () => {
    expect(EMULATOR_SERIAL).toBe('emulator-5554');
  });
});
