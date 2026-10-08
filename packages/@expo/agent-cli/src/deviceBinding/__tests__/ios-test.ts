// @ref llp/0030-one-device-per-worktree.rfc.md §Choice
// Which runtime and device type a created simulator gets, out of `simctl list runtimes -j`.
import { parseNewestIosRuntime } from '../ios';

const type = (name: string) => ({
  identifier: `com.apple.CoreSimulator.SimDeviceType.${name.replace(/ /g, '-')}`,
  name,
  productFamily: 'iPhone',
});

const runtime = (version: string, names: string[], available = true) => ({
  identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace('.', '-')}`,
  name: `iOS ${version}`,
  version,
  platform: 'iOS',
  isAvailable: available,
  supportedDeviceTypes: names.map(type),
});

const listing = (...runtimes: unknown[]) => JSON.stringify({ runtimes });

describe(parseNewestIosRuntime, () => {
  // iOS 27.1 lists iPhone Duo alone, and no app renders on it [observed — 2026-10-08].
  it(`skips a newer runtime with no mainstream iPhone for an older one that has one`, () => {
    expect(
      parseNewestIosRuntime(
        listing(runtime('26.4', ['iPhone 17 Pro', 'iPhone 17']), runtime('27.1', ['iPhone Duo']))
      )
    ).toEqual({
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
      deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
    });
  });

  it(`takes the Pro over an e model listed first, and the plain model when there is no Pro`, () => {
    expect(
      parseNewestIosRuntime(listing(runtime('26.4', ['iPhone 17e', 'iPhone 17 Pro', 'iPhone 17'])))
    ).toMatchObject({ deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' });
    expect(
      parseNewestIosRuntime(listing(runtime('26.4', ['iPhone 17e', 'iPhone Air', 'iPhone 17'])))
    ).toMatchObject({ deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' });
  });

  it(`falls back to the newest runtime's first iPhone when no runtime has a mainstream one`, () => {
    expect(
      parseNewestIosRuntime(
        listing(runtime('26.4', ['iPhone Air']), runtime('27.1', ['iPhone Duo']))
      )
    ).toEqual({
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-1',
      deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo',
    });
  });

  it(`ignores unavailable runtimes, other platforms, and runtimes with no iPhone`, () => {
    expect(
      parseNewestIosRuntime(
        listing(
          runtime('27.1', ['iPhone 18 Pro'], false),
          { ...runtime('26.4', ['iPhone 17 Pro']), platform: 'watchOS' },
          {
            ...runtime('26.0', []),
            supportedDeviceTypes: [{ ...type('iPad'), productFamily: 'iPad' }],
          },
          runtime('25.0', ['iPhone 16'])
        )
      )
    ).toMatchObject({ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-25-0' });
    expect(parseNewestIosRuntime(listing())).toBeNull();
    expect(parseNewestIosRuntime('not json')).toBeNull();
  });
});
