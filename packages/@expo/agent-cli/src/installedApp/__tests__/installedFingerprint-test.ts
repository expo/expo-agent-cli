import { vol } from 'memfs';
import path from 'path';

import { fakeDeviceTools, simctlDevices } from '../../device/__tests__/fakeDeviceTools';
import { deviceRegistryDirectory, writeClaim } from '../../deviceClaims';
import {
  claimedReadableDeviceAsync,
  matchesDeviceFilter,
  parseEmbeddedFingerprint,
  pickBestResult,
  rankInstalledResult,
  type InstalledFingerprintResult,
} from '../installedFingerprint';

vi.mock('../../deviceClaims/events', () => ({
  event: vi.fn(),
  debugEvent: Object.assign(vi.fn(), { error: vi.fn((error) => error) }),
}));

const device = { name: 'Pixel 9', identifier: 'emulator-5554' };
const appId = 'com.example.app';

const ok = (hash: string): InstalledFingerprintResult => ({
  status: 'ok',
  hash,
  fingerprintVersion: '0.21.0',
  appId,
  device,
});
const noFile: InstalledFingerprintResult = { status: 'no-embedded-fingerprint', appId, device };
const notInstalled: InstalledFingerprintResult = { status: 'app-not-installed', appId, device };
const silent: InstalledFingerprintResult = { status: 'no-response', appId, device };
const noDevice: InstalledFingerprintResult = { status: 'no-device' };

describe(parseEmbeddedFingerprint, () => {
  // The writer is `createFingerprintFile.js` in expo/expo (#49905). The sources are kept: a
  // mismatch names the input that moved rather than only reporting that something did.
  it(`reads the hash, the version and the sources`, () => {
    const contents = JSON.stringify({
      hash: 'abc123',
      sources: [{ type: 'file', filePath: 'app.json', reasons: ['expoConfig'], hash: 'aaa' }],
      fingerprintVersion: '0.21.0',
    });
    expect(parseEmbeddedFingerprint(contents)).toEqual({
      hash: 'abc123',
      fingerprintVersion: '0.21.0',
      sources: [{ type: 'file', filePath: 'app.json', reasons: ['expoConfig'], hash: 'aaa' }],
    });
  });

  it(`reads a missing or non-string version as null`, () => {
    expect(parseEmbeddedFingerprint('{"hash":"abc"}')).toEqual({
      hash: 'abc',
      fingerprintVersion: null,
      sources: [],
    });
    expect(parseEmbeddedFingerprint('{"hash":"abc","fingerprintVersion":7}')).toEqual({
      hash: 'abc',
      fingerprintVersion: null,
      sources: [],
    });
  });

  it.each([
    ['malformed JSON', 'not json'],
    ['a bare hash, the pre-#49905 format', 'abc123'],
    ['no hash', '{"fingerprintVersion":"0.21.0"}'],
    ['an empty hash', '{"hash":""}'],
    ['a non-object', '[]'],
    ['null', 'null'],
  ])(`returns null for %s`, (_description, contents) => {
    expect(parseEmbeddedFingerprint(contents)).toBeNull();
  });
});

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

// @ref llp/0030-one-device-per-agent.rfc.md §Every verb uses the claim
describe(claimedReadableDeviceAsync, () => {
  const HERE = path.resolve('/work/here');
  const GONE = path.resolve('/work/gone');

  beforeEach(() => vol.mkdirSync(HERE, { recursive: true }));
  afterEach(() => vol.reset());

  it(`reads the simulator a claim would take, and reaps, writes and shuts down nothing`, async () => {
    const tools = fakeDeviceTools((command, args) =>
      command === 'xcrun' && args[1] === 'list'
        ? {
            stdout: simctlDevices([
              { udid: 'SIM-A', name: 'iPhone 17', state: 'Booted' },
              { udid: 'SIM-B', name: 'iPhone 17 Pro', state: 'Booted' },
            ]),
          }
        : {}
    );
    const now = new Date().toISOString();
    // A deleted worktree's claim on a simulator it booted: a claim would reap it and shut it down.
    writeClaim({
      backend: 'local-ios',
      platform: 'ios',
      id: 'SIM-B',
      projectRoot: GONE,
      pid: 1,
      claimedAt: now,
      touchedAt: now,
      created: false,
      booted: true,
    });
    const registry = vol.toJSON(deviceRegistryDirectory());

    const read = await claimedReadableDeviceAsync('ios', HERE);

    expect(read).toEqual({ device: { identifier: 'SIM-A', name: 'iPhone 17' }, adb: null });
    expect(vol.toJSON(deviceRegistryDirectory())).toEqual(registry);
    expect(tools.callsWith('simctl shutdown')).toEqual([]);
  });
});
