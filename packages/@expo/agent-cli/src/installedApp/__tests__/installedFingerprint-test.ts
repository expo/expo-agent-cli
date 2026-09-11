import {
  matchesDeviceFilter,
  pickBestResult,
  rankInstalledResult,
  type InstalledFingerprintResult,
} from '../installedFingerprint';

const device = { name: 'Pixel 9', identifier: 'emulator-5554' };
const appId = 'com.example.app';

const ok = (hash: string): InstalledFingerprintResult => ({ status: 'ok', hash, appId, device });
const noFile: InstalledFingerprintResult = { status: 'no-embedded-fingerprint', appId, device };
const notInstalled: InstalledFingerprintResult = { status: 'app-not-installed', appId, device };
const silent: InstalledFingerprintResult = { status: 'no-response', appId, device };
const noDevice: InstalledFingerprintResult = { status: 'no-device' };

describe(rankInstalledResult, () => {
  it(`ranks a matching app above every other answer, and silence above nothing`, () => {
    const ranked = [ok('current'), ok('old'), noFile, notInstalled, silent, noDevice].map((r) =>
      rankInstalledResult(r, 'current')
    );
    expect(ranked).toEqual([4, 3, 2, 1, 0, -1]);
  });
});

describe(pickBestResult, () => {
  it(`returns the matching install, wherever it is in the list`, () => {
    expect(pickBestResult([noFile, ok('old'), ok('current')], 'current')).toEqual(ok('current'));
  });

  it(`keeps the most informative answer when nothing matches`, () => {
    expect(pickBestResult([notInstalled, silent, noFile], 'current')).toEqual(noFile);
    expect(pickBestResult([notInstalled, ok('old')], 'current')).toEqual(ok('old'));
  });

  it(`answers no-device for an empty list`, () => {
    expect(pickBestResult([], 'current')).toEqual(noDevice);
  });
});

describe(matchesDeviceFilter, () => {
  it(`matches the name or the identifier, whatever the case`, () => {
    expect(matchesDeviceFilter('pixel 9', device)).toBe(true);
    expect(matchesDeviceFilter('EMULATOR-5554', device)).toBe(true);
    expect(matchesDeviceFilter('Pixel', device)).toBe(false);
  });
});
