// @ref llp/0028-installed-app-check.rfc.md §The prebuild marker
// The marker is written by this CLI's `prebuild` passthrough and read back here, so the reader
// tests plant the file the way the writer writes it.
import { vol } from 'memfs';

import type { FingerprintSource } from '../fingerprint';
import {
  formatPrebuildChanges,
  getNativeDirectoryStaleness,
  getPrebuildMarkerPath,
  getPrebuildStaleness,
  readPrebuildMarker,
  recordPrebuildMarkersAsync,
  type PrebuildMarkerEntry,
} from '../prebuildMarker';

const projectRoot = '/project';

/** The file a successful `prebuild` writes, as {@link recordPrebuildMarkersAsync} writes it. */
function plantMarker(
  platform: 'android' | 'ios',
  contents: Record<string, unknown> | string
): void {
  vol.fromJSON({
    [getPrebuildMarkerPath(projectRoot, platform)]:
      typeof contents === 'string' ? contents : JSON.stringify(contents),
  });
}

function markerFile(
  platform: 'android' | 'ios',
  sources: FingerprintSource[],
  fingerprintVersion: string | null = '0.20.0'
): Record<string, unknown> {
  return {
    version: 1,
    platform,
    hash: 'marker-hash',
    sources,
    fingerprintVersion,
    createdAt: '2026-09-09T00:00:00Z',
  };
}

const appConfig = (hash: string): FingerprintSource => ({
  type: 'contents',
  id: 'expoConfig',
  reasons: ['expoConfig'],
  hash,
});
const plugin = (hash: string): FingerprintSource => ({
  type: 'file',
  filePath: 'plugins/withFoo.js',
  reasons: ['expoConfigPlugins'],
  hash,
});
const dependencyPlugin = (hash: string): FingerprintSource => ({
  type: 'dir',
  filePath: 'node_modules/expo-camera/plugin',
  reasons: ['expoConfigPlugins'],
  hash,
});
const nativeModule = (hash: string): FingerprintSource => ({
  type: 'dir',
  filePath: 'node_modules/react-native-mmkv',
  reasons: ['expoAutolinkingIos'],
  hash,
});

function marker(sources: FingerprintSource[], fingerprintVersion = '0.20.0'): PrebuildMarkerEntry {
  return { hash: 'marker-hash', sources, fingerprintVersion, createdAt: '2026-09-08T00:00:00Z' };
}

beforeEach(() => {
  vol.reset();
});

describe(getPrebuildStaleness, () => {
  it(`is fresh when the prebuild-relevant sources are unchanged`, () => {
    expect(
      getPrebuildStaleness({
        marker: marker([appConfig('a'), plugin('p'), nativeModule('n1')]),
        currentSources: [appConfig('a'), plugin('p'), nativeModule('n2')],
        currentFingerprintVersion: '0.20.0',
      })
    ).toEqual({ status: 'fresh', changes: [] });
  });

  it(`is stale and names the project sources that moved, project first`, () => {
    const staleness = getPrebuildStaleness({
      marker: marker([appConfig('a'), plugin('p'), dependencyPlugin('d')]),
      currentSources: [appConfig('b'), dependencyPlugin('e')],
      currentFingerprintVersion: '0.20.0',
    });
    expect(staleness.status).toBe('stale');
    expect(staleness.changes).toEqual([
      { source: 'app config', change: 'changed', scope: 'project' },
      { source: 'plugins/withFoo.js', change: 'removed', scope: 'project' },
      { source: 'node_modules/expo-camera/plugin', change: 'changed', scope: 'dependency' },
    ]);
    expect(formatPrebuildChanges(staleness.changes)).toBe('app config, plugins/withFoo.js');
  });

  it(`is stale on a dependency-only change, with nothing to name`, () => {
    const staleness = getPrebuildStaleness({
      marker: marker([appConfig('a'), dependencyPlugin('d')]),
      currentSources: [appConfig('a'), dependencyPlugin('e')],
      currentFingerprintVersion: '0.20.0',
    });
    expect(staleness.status).toBe('stale');
    expect(formatPrebuildChanges(staleness.changes)).toBe('');
  });

  it(`truncates a long list of project sources`, () => {
    const changes = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'].map((source) => ({
      source,
      change: 'changed' as const,
      scope: 'project' as const,
    }));
    expect(formatPrebuildChanges(changes)).toBe('a.js, b.js, c.js, and 2 more');
  });

  it.each([
    ['there is no marker', null, '0.20.0'],
    ['the marker has no sources', { ...marker([]), sources: null }, '0.20.0'],
    ['the fingerprint version differs', marker([appConfig('a')]), '0.21.0'],
    ['the marker has no fingerprint version', marker([appConfig('a')], ''), '0.20.0'],
  ])(`is unknown when %s`, (_case, entry, version) => {
    expect(
      getPrebuildStaleness({
        marker: entry,
        currentSources: [appConfig('a')],
        currentFingerprintVersion: version,
      })
    ).toEqual({ status: 'unknown', changes: [] });
  });

  it(`is unknown when the current sources are missing`, () => {
    expect(
      getPrebuildStaleness({
        marker: marker([appConfig('a')]),
        currentSources: null,
        currentFingerprintVersion: '0.20.0',
      }).status
    ).toBe('unknown');
  });
});

describe(getNativeDirectoryStaleness, () => {
  const current = { sources: [appConfig('b')], fingerprintVersion: '0.20.0' };

  it(`is not applicable without the native directory`, () => {
    vol.fromJSON({ [`${projectRoot}/package.json`]: '{}' });
    expect(getNativeDirectoryStaleness(projectRoot, 'ios', current)).toEqual({
      status: 'not-applicable',
      changes: [],
    });
  });

  it(`is unknown for a native directory with no marker`, () => {
    vol.fromJSON({ [`${projectRoot}/ios/Podfile`]: '' });
    expect(getNativeDirectoryStaleness(projectRoot, 'ios', current).status).toBe('unknown');
  });

  it(`reads the platform's own marker file`, () => {
    vol.fromJSON({
      [`${projectRoot}/android/build.gradle`]: '',
      [getPrebuildMarkerPath(projectRoot, 'android')]: JSON.stringify(
        markerFile('android', [appConfig('a')])
      ),
    });
    expect(getNativeDirectoryStaleness(projectRoot, 'android', current)).toMatchObject({
      status: 'stale',
      changes: [{ source: 'app config', change: 'changed' }],
    });
  });

  // One marker file per platform, so the other platform's marker cannot answer for this one.
  it(`ignores the other platform's marker`, () => {
    vol.fromJSON({
      [`${projectRoot}/ios/Podfile`]: '',
      [getPrebuildMarkerPath(projectRoot, 'android')]: JSON.stringify(
        markerFile('android', [appConfig('a')])
      ),
    });
    expect(getNativeDirectoryStaleness(projectRoot, 'ios', current).status).toBe('unknown');
  });
});

describe(readPrebuildMarker, () => {
  it(`reads the file expo prebuild wrote`, () => {
    plantMarker('ios', markerFile('ios', [appConfig('a')]));
    expect(readPrebuildMarker(projectRoot, 'ios')).toEqual({
      hash: 'marker-hash',
      sources: [appConfig('a')],
      fingerprintVersion: '0.20.0',
      createdAt: '2026-09-09T00:00:00Z',
    });
  });

  it(`keeps a marker whose fingerprint version is absent, which reads as unknown later`, () => {
    plantMarker('ios', { ...markerFile('ios', [appConfig('a')]), fingerprintVersion: undefined });
    expect(readPrebuildMarker(projectRoot, 'ios')).toMatchObject({ fingerprintVersion: null });
  });

  // The four rejected fields are the writer's own, so both tools agree on what counts as a marker.
  it.each([
    ['the file is missing', null],
    ['the JSON is corrupt', '{not json'],
    ['the schema version is another one', { ...markerFile('ios', []), version: 2 }],
    ['the platform is the other one', { ...markerFile('ios', []), platform: 'android' }],
    ['the hash is not a string', { ...markerFile('ios', []), hash: 42 }],
    ['the sources are not an array', { ...markerFile('ios', []), sources: {} }],
  ])(`answers null when %s`, (_case, contents) => {
    if (contents == null) {
      vol.fromJSON({ [`${projectRoot}/package.json`]: '{}' });
    } else {
      plantMarker('ios', contents as Record<string, unknown> | string);
    }
    expect(readPrebuildMarker(projectRoot, 'ios')).toBeNull();
  });
});

describe('recordPrebuildMarkersAsync', () => {
  const sources: FingerprintSource[] = [appConfig('a')];

  /** A stand-in for the fingerprint CLI, so these tests spawn nothing. */
  function fakeFingerprint(hash: string | null, fingerprintSources = sources) {
    return vi.fn(async (_root: string, options?: { platform?: string }) => ({
      hash: hash === null ? null : `${hash}-${options?.platform}`,
      sources: hash === null ? null : fingerprintSources,
    })) as never;
  }

  function nativeDirs(...platforms: ('ios' | 'android')[]) {
    vol.fromJSON(
      Object.fromEntries(platforms.map((p) => [`${projectRoot}/${p}/.keep`, ''])) as Record<
        string,
        string
      >
    );
  }

  it(`records every platform that has a native directory`, async () => {
    nativeDirs('ios', 'android');

    const recorded = await recordPrebuildMarkersAsync(projectRoot, [], {
      generateFingerprint: fakeFingerprint('h'),
      clearMemo: vi.fn(),
    });

    expect(recorded).toEqual(['ios', 'android']);
    expect(readPrebuildMarker(projectRoot, 'ios')?.hash).toBe('h-ios');
    expect(readPrebuildMarker(projectRoot, 'android')?.hash).toBe('h-android');
  });

  it(`writes a marker its own reader accepts`, async () => {
    nativeDirs('ios');

    await recordPrebuildMarkersAsync(projectRoot, [], {
      generateFingerprint: fakeFingerprint('h'),
      clearMemo: vi.fn(),
    });

    expect(readPrebuildMarker(projectRoot, 'ios')).toMatchObject({
      hash: 'h-ios',
      sources,
    });
  });

  it(`skips a platform with no native directory`, async () => {
    nativeDirs('android');

    const recorded = await recordPrebuildMarkersAsync(projectRoot, [], {
      generateFingerprint: fakeFingerprint('h'),
      clearMemo: vi.fn(),
    });

    expect(recorded).toEqual(['android']);
    expect(readPrebuildMarker(projectRoot, 'ios')).toBeNull();
  });

  it.each([
    ['--platform ios', ['--platform', 'ios']],
    ['--platform=ios', ['--platform=ios']],
    ['-p ios', ['-p', 'ios']],
  ])(`records only the platform %s asked for`, async (_description, args) => {
    nativeDirs('ios', 'android');

    const recorded = await recordPrebuildMarkersAsync(projectRoot, args, {
      generateFingerprint: fakeFingerprint('h'),
      clearMemo: vi.fn(),
    });

    expect(recorded).toEqual(['ios']);
    expect(readPrebuildMarker(projectRoot, 'android')).toBeNull();
  });

  it(`records both platforms for --platform all`, async () => {
    nativeDirs('ios', 'android');

    const recorded = await recordPrebuildMarkersAsync(projectRoot, ['--platform', 'all'], {
      generateFingerprint: fakeFingerprint('h'),
      clearMemo: vi.fn(),
    });

    expect(recorded).toEqual(['ios', 'android']);
  });

  it(`records nothing when the fingerprint could not be computed`, async () => {
    nativeDirs('ios');

    const recorded = await recordPrebuildMarkersAsync(projectRoot, [], {
      generateFingerprint: fakeFingerprint(null),
      clearMemo: vi.fn(),
    });

    expect(recorded).toEqual([]);
    expect(readPrebuildMarker(projectRoot, 'ios')).toBeNull();
  });

  it(`drops any hash measured before prebuild rewrote the directories`, async () => {
    nativeDirs('ios');
    const clearMemo = vi.fn();

    await recordPrebuildMarkersAsync(projectRoot, [], {
      generateFingerprint: fakeFingerprint('h'),
      clearMemo,
    });

    expect(clearMemo).toHaveBeenCalledWith(projectRoot);
  });
});
