// @ref llp/0004-smart-start-and-project-state.rfc.md §Installed-app fingerprint check
import { CommandError } from '../../utils/errors';
import type { InstalledFingerprintResult } from '../installedFingerprint';
import {
  aggregateOutcome,
  checkInstalledAppAsync,
  type InstalledFingerprintReader,
  type PlatformCheck,
} from '../installedAppAsync';
import type { InstalledAppOptions } from '../options';

const projectRoot = '/app';
const device = { name: 'iPhone 17', identifier: 'UDID-1' };
const appId = 'dev.expo.app';

function options(overrides: Partial<InstalledAppOptions> = {}): InstalledAppOptions {
  return {
    platforms: ['ios'],
    device: null,
    appId: null,
    fingerprintCache: undefined,
    ...overrides,
  };
}

const fingerprint = async () => ({
  hash: 'current-hash',
  sources: [],
  source: 'computed' as const,
});
const readAppId = () => appId;
const deps = {
  generateFingerprint: fingerprint,
  readAppId,
  readFingerprintVersion: () => '0.20.0',
  readEmbedSupport: () => ({ supported: true, version: '58.0.5' }),
};
const installed =
  (result: InstalledFingerprintResult): InstalledFingerprintReader =>
  async () =>
    result;

describe(checkInstalledAppAsync, () => {
  // The device read has side effects — on a phone it launches the app — so a read whose answer
  // would be discarded must never start.
  it(`does not start the device read when the project fingerprint is unavailable`, async () => {
    let started = false;
    await checkInstalledAppAsync(projectRoot, options(), {
      ...deps,
      generateFingerprint: async () => ({ hash: null, sources: null, error: 'fingerprint failed' }),
      readInstalled: () => {
        started = true;
        return new Promise<never>(() => {});
      },
    });

    expect(started).toBe(false);
  });

  // An SDK before 58.0.5: no build embeds the file, so the project is not hashed and no device is
  // read — a rebuild could not change the answer, so `commands` must not suggest one.
  it(`reports embed-unsupported without hashing the project or reading a device`, async () => {
    let hashed = false;
    let read = false;
    const report = await checkInstalledAppAsync(projectRoot, options(), {
      ...deps,
      readEmbedSupport: () => ({ supported: false, version: '57.0.19' }),
      generateFingerprint: async () => {
        hashed = true;
        return { hash: 'current-hash', sources: [] };
      },
      readInstalled: () => {
        read = true;
        return new Promise<never>(() => {});
      },
    });

    expect(hashed).toBe(false);
    expect(read).toBe(false);
    expect(report.platforms.ios).toMatchObject({
      status: 'unknown',
      reason: 'embed-unsupported',
      commands: [],
      device: null,
      recommendation: expect.stringContaining('expo-constants 57.0.19 does not embed'),
    });
    expect(report.outcome).toBe('unknown');
  });

  it.each<[string, InstalledFingerprintResult, Partial<PlatformCheck>]>([
    [
      'the installed hash matches',
      { status: 'ok', hash: 'current-hash', fingerprintVersion: '0.20.0', appId, device },
      {
        status: 'up-to-date',
        reason: 'hash-match',
        commands: [],
        installedHash: 'current-hash',
      },
    ],
    [
      'the installed hash differs',
      { status: 'ok', hash: 'old-hash', fingerprintVersion: '0.20.0', appId, device },
      {
        status: 'rebuild-required',
        reason: 'hash-mismatch',
        commands: ['npx expo run:ios'],
        installedHash: 'old-hash',
      },
    ],
    [
      'the app is not installed',
      { status: 'app-not-installed', appId, device },
      {
        status: 'unknown',
        reason: 'app-not-installed',
        commands: ['npx expo run:ios'],
      },
    ],
    [
      'the app has no embedded fingerprint',
      { status: 'no-embedded-fingerprint', appId, device },
      { status: 'unknown', reason: 'no-embedded-fingerprint' },
    ],
    [
      'no device is reachable',
      { status: 'no-device' },
      { status: 'unknown', reason: 'no-device', device: null },
    ],
    [
      'the app did not answer',
      { status: 'no-response', appId, device },
      { status: 'unknown', reason: 'no-response' },
    ],
  ])(`reports %s`, async (_case, result, expected) => {
    const report = await checkInstalledAppAsync(projectRoot, options(), {
      readInstalled: installed(result),
      ...deps,
    });
    expect(report.platforms.ios).toMatchObject({
      ...expected,
      currentHash: 'current-hash',
      fingerprintSource: 'computed',
    });
    // One platform was checked, so its status is the report's outcome.
    expect(report.outcome).toBe(expected.status);
  });

  // The embedded fingerprint carries the sources behind its hash, so a mismatch can say which
  // input moved. Dependency sources are left out: they point at code the developer did not write.
  it(`names the project source that moved when the installed app carries its sources`, async () => {
    const report = await checkInstalledAppAsync(projectRoot, options(), {
      ...deps,
      generateFingerprint: async () => ({
        hash: 'current-hash',
        sources: [
          { type: 'contents', id: 'expoConfig', hash: 'cfg-new', reasons: ['expoConfig'] },
          { type: 'file', filePath: '../../packages/expo', hash: 'dep-new', reasons: ['bareRn'] },
        ],
        source: 'computed' as const,
      }),
      readInstalled: installed({
        status: 'ok',
        hash: 'old-hash',
        fingerprintVersion: '0.20.0',
        sources: [
          { type: 'contents', id: 'expoConfig', hash: 'cfg-old', reasons: ['expoConfig'] },
          { type: 'file', filePath: '../../packages/expo', hash: 'dep-old', reasons: ['bareRn'] },
        ],
        appId,
        device,
      }),
    });

    expect(report.platforms.ios!.recommendation).toContain('the app config');
    expect(report.platforms.ios!.recommendation).not.toContain('packages/expo');
  });

  // A phone answers over the wire and sends no sources, so the generic wording has to survive.
  it(`falls back to the generic wording when the installed app reports no sources`, async () => {
    const report = await checkInstalledAppAsync(projectRoot, options(), {
      ...deps,
      readInstalled: installed({
        status: 'ok',
        hash: 'old-hash',
        fingerprintVersion: '0.20.0',
        appId,
        device,
      }),
    });

    expect(report.platforms.ios!.recommendation).toBe(
      'Native inputs changed since the installed app was built. Rebuild the app.'
    );
  });

  // An equal hash is positive evidence whatever produced it: a version difference can only
  // explain hashes that differ, never hashes that agree.
  it(`still matches on an equal hash when the fingerprint versions differ`, async () => {
    const report = await checkInstalledAppAsync(projectRoot, options(), {
      ...deps,
      readInstalled: installed({
        status: 'ok',
        hash: 'current-hash',
        fingerprintVersion: '0.19.0',
        appId,
        device,
      }),
    });

    expect(report.platforms.ios).toMatchObject({ status: 'up-to-date', reason: 'hash-match' });
  });

  it(`refuses to compare hashes from different fingerprint versions`, async () => {
    const report = await checkInstalledAppAsync(projectRoot, options(), {
      ...deps,
      readInstalled: installed({
        status: 'ok',
        hash: 'old-hash',
        fingerprintVersion: '0.19.0',
        appId,
        device,
      }),
    });

    expect(report.platforms.ios).toMatchObject({
      status: 'unknown',
      reason: 'fingerprint-version-mismatch',
      recommendation: expect.stringContaining('0.19.0'),
    });
    // Not a staleness verdict, and `commands` is what an agent runs: it must not contradict that.
    expect(report.platforms.ios?.recommendation).toMatch(/may well be current/);
    expect(report.platforms.ios!.commands).toEqual([]);
  });

  // A build made before the version was embedded reports null. That is "cannot tell", not
  // "different" — the hash comparison still runs.
  it(`still compares hashes when the app reports no version`, async () => {
    const report = await checkInstalledAppAsync(projectRoot, options(), {
      ...deps,
      readInstalled: installed({
        status: 'ok',
        hash: 'current-hash',
        fingerprintVersion: null,
        appId,
        device,
      }),
    });

    expect(report.platforms.ios).toMatchObject({ reason: 'hash-match' });
  });

  it(`appends the reader's hint to the recommendation`, async () => {
    const report = await checkInstalledAppAsync(projectRoot, options(), {
      readInstalled: installed({ status: 'no-device', hint: 'Pick one with --device.' }),
      ...deps,
    });
    expect(report.platforms.ios!.recommendation).toMatch(/Pick one with --device\.$/);
  });

  it(`reports fingerprint-unavailable when the project cannot be hashed`, async () => {
    const report = await checkInstalledAppAsync(projectRoot, options(), {
      ...deps,
      readInstalled: installed({
        status: 'ok',
        hash: 'x',
        fingerprintVersion: '0.20.0',
        appId,
        device,
      }),
      generateFingerprint: async () => ({ hash: null, sources: null, error: 'no fingerprint CLI' }),
      readAppId,
    });
    expect(report.platforms.ios).toMatchObject({
      reason: 'fingerprint-unavailable',
      recommendation: expect.stringContaining('no fingerprint CLI'),
    });
  });

  it(`reports app-id-unknown, and takes a caller-supplied app id over the project`, async () => {
    const seen: string[] = [];
    const unnamed = {
      ...deps,
      readInstalled: (async ({ appId: id }) => {
        seen.push(id);
        return {
          status: 'ok',
          hash: 'current-hash',
          fingerprintVersion: '0.20.0',
          appId: id,
          device,
        };
      }) as InstalledFingerprintReader,
      readAppId: () => null,
    };
    const unknown = await checkInstalledAppAsync(projectRoot, options(), unnamed);
    expect(unknown.platforms.ios).toMatchObject({ reason: 'app-id-unknown' });
    expect(unknown.platforms.ios!.recommendation).toContain('no ios.bundleIdentifier');

    const named = await checkInstalledAppAsync(
      projectRoot,
      options({ appId: 'com.flag' }),
      unnamed
    );
    expect(named.platforms.ios).toMatchObject({ reason: 'hash-match' });
    expect(seen).toEqual(['com.flag']);
  });

  it(`answers check-failed for a reader that threw, and keeps the other platform's verdict`, async () => {
    const report = await checkInstalledAppAsync(
      projectRoot,
      options({ platforms: ['android', 'ios'] }),
      {
        readInstalled: async ({ platform }) => {
          if (platform === 'android') {
            throw new Error('adb went away');
          }
          return {
            status: 'ok',
            hash: 'current-hash',
            fingerprintVersion: '0.20.0',
            appId,
            device,
          };
        },
        ...deps,
      }
    );
    expect(report.platforms.android).toMatchObject({
      reason: 'check-failed',
      recommendation: expect.stringContaining('adb went away'),
    });
    expect(report.platforms.ios).toMatchObject({ reason: 'hash-match' });
    expect(report).toMatchObject({ outcome: 'unknown' });
  });

  it(`answers no-device for a missing device tool instead of failing the report`, async () => {
    // The check reads every platform this machine might reach, so a tool that cannot run is one
    // platform without a device. `status` must still print the rest of its report.
    const readInstalled: InstalledFingerprintReader = async ({ platform }) => {
      if (platform === 'android') {
        throw new CommandError('ADB_NOT_RUNNABLE', 'no adb');
      }
      return { status: 'ok', hash: 'current-hash', fingerprintVersion: '0.20.0', appId, device };
    };

    const report = await checkInstalledAppAsync(
      projectRoot,
      options({ platforms: ['android', 'ios'] }),
      { readInstalled, ...deps }
    );

    expect(report.platforms.android).toMatchObject({
      reason: 'no-device',
      recommendation: 'no adb',
    });
    expect(report.outcome).toBe('up-to-date');
  });
});

describe(aggregateOutcome, () => {
  const check = (
    reason: PlatformCheck['reason'],
    status: PlatformCheck['status']
  ): PlatformCheck => ({
    status,
    reason,
    recommendation: '',
    commands: [],
    device: null,
    installedHash: null,
    currentHash: null,
    fingerprintSource: null,
  });

  it(`takes the strongest verdict: rebuild-required before unknown before up-to-date`, () => {
    expect(
      aggregateOutcome([
        check('hash-match', 'up-to-date'),
        check('hash-mismatch', 'rebuild-required'),
      ])
    ).toBe('rebuild-required');
    expect(
      aggregateOutcome([check('hash-match', 'up-to-date'), check('app-not-installed', 'unknown')])
    ).toBe('unknown');
    expect(aggregateOutcome([check('hash-match', 'up-to-date')])).toBe('up-to-date');
  });

  // A device that was found and did not answer is not "no device": it weighs like any unknown.
  it(`keeps a no-response platform in the outcome`, () => {
    expect(
      aggregateOutcome([check('hash-match', 'up-to-date'), check('no-response', 'unknown')])
    ).toBe('unknown');
  });

  it(`ignores an unreachable platform while another answered`, () => {
    expect(
      aggregateOutcome([check('hash-match', 'up-to-date'), check('no-device', 'unknown')])
    ).toBe('up-to-date');
  });

  it(`answers unknown when nothing was reachable`, () => {
    expect(
      aggregateOutcome([check('no-device', 'unknown'), check('app-id-unknown', 'unknown')])
    ).toBe('unknown');
  });
});
