// @ref llp/0028-installed-app-check.rfc.md §What the answer is
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
    timeoutMs: 15_000,
    ...overrides,
  };
}

const fingerprint = async () => ({
  hash: 'current-hash',
  sources: [],
  source: 'computed' as const,
});
const readAppId = () => appId;
const fresh = () => ({ status: 'fresh' as const, changes: [] });
const readFingerprintVersion = () => '0.20.0';
const readScheme = () => 'myapp';
const deps = {
  generateFingerprint: fingerprint,
  readAppId,
  readScheme,
  readNativeDirectoryStaleness: fresh,
  readFingerprintVersion,
};
const installed =
  (result: InstalledFingerprintResult): InstalledFingerprintReader =>
  async () =>
    result;

describe(checkInstalledAppAsync, () => {
  it.each<[string, InstalledFingerprintResult, Partial<PlatformCheck>]>([
    [
      'the installed hash matches',
      { status: 'ok', hash: 'current-hash', appId, device },
      {
        status: 'up-to-date',
        reason: 'hash-match',
        commands: [],
        installedHash: 'current-hash'
      },
    ],
    [
      'the installed hash differs',
      { status: 'ok', hash: 'old-hash', appId, device },
      {
        status: 'rebuild-required',
        reason: 'hash-mismatch',
        commands: ['npx expo run:ios'],
        installedHash: 'old-hash'
      },
    ],
    [
      'the app is not installed',
      { status: 'app-not-installed', appId, device },
      {
        status: 'unknown',
        reason: 'app-not-installed',
        commands: ['npx expo run:ios']
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
      prebuildStatus: 'fresh',
      prebuildChanges: [],
    });
    // One platform was checked, so its status is the report's outcome.
    expect(report.outcome).toBe(expected.status);
  });

  // @ref llp/0028-installed-app-check.rfc.md §The prebuild marker
  it(`reports prebuild-stale without waiting for the device, with prebuild first`, async () => {
    const report = await checkInstalledAppAsync(projectRoot, options(), {
      ...deps,
      // The device read starts in parallel and is never awaited for this verdict.
      readInstalled: () => new Promise<never>(() => {}),
      readNativeDirectoryStaleness: (root, platform, current) => {
        expect([root, platform, current]).toEqual([
          projectRoot,
          'ios',
          { sources: [], fingerprintVersion: '0.20.0' },
        ]);
        return {
          status: 'stale',
          changes: [
            { source: 'app config', change: 'changed', scope: 'project' },
            { source: 'node_modules/expo-camera/plugin', change: 'changed', scope: 'dependency' },
          ],
        };
      },
    });
    expect(report.platforms.ios).toMatchObject({
      status: 'rebuild-required',
      reason: 'prebuild-stale',
      commands: ['npx @expo/agent-cli prebuild -p ios', 'npx expo run:ios'],
      recommendation:
        'app config changed after the native directories were generated. Regenerate them, then rebuild.',
      prebuildStatus: 'stale',
      currentHash: 'current-hash',
      device: null
    });
    expect(report.platforms.ios!.prebuildChanges).toHaveLength(2);
    expect(report.outcome).toBe('rebuild-required');
  });

  it(`names no source when only dependencies moved the prebuild`, async () => {
    const report = await checkInstalledAppAsync(projectRoot, options(), {
      ...deps,
      readInstalled: installed({ status: 'ok', hash: 'current-hash', appId, device }),
      readNativeDirectoryStaleness: () => ({
        status: 'stale',
        changes: [{ source: 'node_modules/x/plugin', change: 'changed', scope: 'dependency' }],
      }),
    });
    expect(report.platforms.ios!.recommendation).toBe(
      'The native directories were generated from a different project state. Regenerate them, then rebuild.'
    );
  });

  it(`carries the marker's status alongside the device verdict`, async () => {
    const report = await checkInstalledAppAsync(projectRoot, options(), {
      ...deps,
      readInstalled: installed({ status: 'ok', hash: 'current-hash', appId, device }),
      readNativeDirectoryStaleness: () => ({ status: 'not-applicable', changes: [] }),
    });
    expect(report.platforms.ios).toMatchObject({
      reason: 'hash-match',
      prebuildStatus: 'not-applicable',
    });
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
      readInstalled: installed({ status: 'ok', hash: 'x', appId, device }),
      generateFingerprint: async () => ({ hash: null, sources: null, error: 'no fingerprint CLI' }),
      readAppId,
    });
    expect(report.platforms.ios).toMatchObject({
      reason: 'fingerprint-unavailable',
      recommendation: expect.stringContaining('no fingerprint CLI')
    });
  });

  it(`reports app-id-unknown, and takes a caller-supplied app id over the project`, async () => {
    const seen: string[] = [];
    const unnamed = {
      ...deps,
      readInstalled: (async ({ appId: id }) => {
        seen.push(id);
        return { status: 'ok', hash: 'current-hash', appId: id, device };
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
          return { status: 'ok', hash: 'current-hash', appId, device };
        },
        ...deps,
      }
    );
    expect(report.platforms.android).toMatchObject({
      reason: 'check-failed',
      recommendation: expect.stringContaining('adb went away')
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
      return { status: 'ok', hash: 'current-hash', appId, device };
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
    prebuildStatus: 'unknown',
    prebuildChanges: [],
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
