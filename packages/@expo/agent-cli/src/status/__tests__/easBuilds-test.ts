// @ref llp/0011-impact-and-freshness.rfc.md §The build-cache lookup
//
// The design decision is "the cache is free and exact, the network is opt-in", and only two of
// these tests are about the answer: the rest pin the *cost*, which is the thing a report promising
// to be instant cannot get wrong quietly.

import fs from 'fs';
import { vol } from 'memfs';

import { lookUpCachedBuildAsync } from '../../impact/buildCache';
import { generateFingerprintAsync } from '../../project/fingerprint';
import { resolveEasCli } from '../../utils/easCli';
import {
  EAS_BUILDS_FILE_NAME,
  EAS_NONE_CACHE_TTL_MS,
  readEasBuildsRecord,
  readEasBuildsStatusAsync,
  writeEasBuildsEntry,
} from '../easBuilds';
import type { AuthStatus, PlatformBuild } from '../types';

vi.mock('../../impact/buildCache', async () => ({
  lookUpCachedBuildAsync: vi.fn(),
  // The real one: it is a pure function of the resolved CLI, and the deadline's reason is the thing
  // under test in one of these cases.
  runnerDownloadNote: (await vi.importActual('../../impact/buildCache')).runnerDownloadNote,
}));
vi.mock('../../project/fingerprint', () => ({ generateFingerprintAsync: vi.fn() }));
vi.mock('../../utils/easCli', async () => ({
  ...(await vi.importActual('../../utils/easCli')),
  resolveEasCli: vi.fn(),
}));

const projectRoot = '/project';
const recordFile = `${projectRoot}/.expo/${EAS_BUILDS_FILE_NAME}`;

/** The whole-project hash `status` computes for freshness — the cache key. */
const PROJECT_HASH = '031f6b0cf531347325945ec1a8b2986964d6d55f';
/** The iOS hash of the same working tree, which is the one an EAS build carries. */
const IOS_HASH = '8ce1acfbc22138726c1525aeb99d577a812de3cf';

const BUILD = {
  id: '21d7d434-6495-4e74-b8c7-68ecd0dff489',
  status: 'FINISHED',
  platform: 'IOS',
  buildProfile: 'simulator',
  createdAt: '2026-08-19T17:37:12.674Z',
  buildUrl: 'https://expo.dev/artifacts/eas/abc.tar.gz',
};

const signedIn: AuthStatus = { loggedIn: true, user: 'alice', source: 'eas whoami' };

function writeCache(entry: Record<string, unknown>): void {
  vol.fromJSON({ [recordFile]: JSON.stringify({ ios: entry }) });
}

function iosOf(platforms: PlatformBuild[]): PlatformBuild {
  return platforms.find((platform) => platform.platform === 'ios')!;
}

beforeEach(() => {
  vol.reset();
  vi.mocked(resolveEasCli).mockReturnValue({
    command: 'npx',
    prefixArgs: ['--yes', 'eas-cli@latest'],
    source: 'npx --yes eas-cli@latest',
    runner: 'npx',
    pinned: false,
  });
  vi.mocked(generateFingerprintAsync).mockResolvedValue({ hash: IOS_HASH, sources: [] });
  vi.mocked(lookUpCachedBuildAsync).mockResolvedValue({ state: 'none' });
});

describe(readEasBuildsStatusAsync, () => {
  it(`should ask EAS about both platforms when nothing is remembered, and say it did`, async () => {
    const status = await readEasBuildsStatusAsync(projectRoot, {
      auth: signedIn,
      projectHash: PROJECT_HASH,
    });

    expect(status.askedEas).toBe(true);
    expect(status.platforms.map((platform) => platform.state)).toEqual(['none', 'none']);
    expect(lookUpCachedBuildAsync).toHaveBeenCalledTimes(2);
  });

  // The whole point of keying the cache on the hash `status` already has: a hit is exact and free.
  it(`should answer found from the record, asking EAS nothing about that platform`, async () => {
    writeCache({ projectHash: PROJECT_HASH, fingerprintHash: IOS_HASH, build: BUILD });

    const status = await readEasBuildsStatusAsync(projectRoot, {
      auth: signedIn,
      projectHash: PROJECT_HASH,
    });

    expect(iosOf(status.platforms)).toMatchObject({
      state: 'found',
      source: 'cache',
      buildId: BUILD.id,
      buildProfile: 'simulator',
      createdAt: BUILD.createdAt,
      fingerprintHash: IOS_HASH,
    });
    // Android has no entry and is asked; iOS, which has one, is not.
    expect(generateFingerprintAsync).not.toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({ platform: 'ios' })
    );
    expect(lookUpCachedBuildAsync).toHaveBeenCalledTimes(1);
  });

  it(`should say EAS was not asked when every platform was answered from the record`, async () => {
    vol.fromJSON({
      [recordFile]: JSON.stringify({
        ios: { projectHash: PROJECT_HASH, fingerprintHash: IOS_HASH, build: BUILD },
        android: {
          projectHash: PROJECT_HASH,
          fingerprintHash: 'android-hash',
          build: { ...BUILD, id: 'android-build', platform: 'ANDROID' },
        },
      }),
    });

    const status = await readEasBuildsStatusAsync(projectRoot, {
      auth: signedIn,
      projectHash: PROJECT_HASH,
    });

    expect(status.askedEas).toBe(false);
    expect(lookUpCachedBuildAsync).not.toHaveBeenCalled();
  });

  it(`should ask again over a remembered answer taken under a different project fingerprint`, async () => {
    writeCache({ projectHash: 'some-older-hash', fingerprintHash: IOS_HASH, build: BUILD });

    const status = await readEasBuildsStatusAsync(projectRoot, {
      auth: signedIn,
      projectHash: PROJECT_HASH,
    });

    expect(iosOf(status.platforms)).toMatchObject({ state: 'none', source: 'eas' });
  });

  it(`should ask, and remember nothing, when this project has no fingerprint of its own`, async () => {
    writeCache({ projectHash: PROJECT_HASH, fingerprintHash: IOS_HASH, build: BUILD });
    vi.mocked(lookUpCachedBuildAsync).mockResolvedValue({ state: 'found', build: BUILD });

    const status = await readEasBuildsStatusAsync(projectRoot, {
      auth: signedIn,
      projectHash: null,
    });

    // Nothing establishes that the entry belongs to what is on disk now, so it is not an answer —
    // and nothing can key a new one, so the answer EAS gave is reported and not written.
    expect(iosOf(status.platforms)).toMatchObject({ state: 'found', source: 'eas' });
    expect(readEasBuildsRecord(projectRoot).ios?.projectHash).toBe(PROJECT_HASH);
  });

  // The auth section already answered this. A second probe would spend a second to be told the
  // same thing, which is exactly the cost this design exists to avoid.
  it(`should not ask EAS on a signed-out machine`, async () => {
    const status = await readEasBuildsStatusAsync(projectRoot, {
      auth: { loggedIn: false, user: null, source: 'eas whoami' },
      projectHash: PROJECT_HASH,
    });

    expect(iosOf(status.platforms).state).toBe('unknown');
    expect(iosOf(status.platforms).reason).toContain('not signed in');
    expect(lookUpCachedBuildAsync).not.toHaveBeenCalled();
  });

  it(`should ask EAS when the auth answer is itself unknown`, async () => {
    await readEasBuildsStatusAsync(projectRoot, {
      auth: { loggedIn: null, user: null, source: null },
      projectHash: PROJECT_HASH,
    });

    expect(lookUpCachedBuildAsync).toHaveBeenCalled();
  });

  // The reason the lookup needs a fingerprint run of its own: the hash `status` has covers both
  // @ref llp/0023-fingerprint-caching.rfc.md §Every consumer can turn it off
  // This section pays for two of the three fingerprints a `status` computes, so a caller
  // who refused the cache has to be refused it here too — or the flag would only apply to a third
  // of the cost it is about.
  it(`should pass a refused cache through to both platforms`, async () => {
    await readEasBuildsStatusAsync(projectRoot, {
      auth: signedIn,
      projectHash: PROJECT_HASH,
      fingerprintCache: false,
    });

    expect(generateFingerprintAsync).toHaveBeenCalledWith(projectRoot, {
      platform: 'ios',
      cache: false,
    });
    expect(generateFingerprintAsync).toHaveBeenCalledWith(projectRoot, {
      platform: 'android',
      cache: false,
    });
  });

  // platforms, and an EAS build carries a per-platform one.
  it(`should look the per-platform fingerprint up, not the project one`, async () => {
    await readEasBuildsStatusAsync(projectRoot, {
      auth: signedIn,
      projectHash: PROJECT_HASH,
    });

    expect(generateFingerprintAsync).toHaveBeenCalledWith(projectRoot, {
      platform: 'ios',
      cache: undefined,
    });
    expect(lookUpCachedBuildAsync).toHaveBeenCalledWith(
      {
        command: 'npx',
        prefixArgs: ['--yes', 'eas-cli@latest'],
        source: 'npx --yes eas-cli@latest',
        runner: 'npx',
        pinned: false,
      },
      projectRoot,
      'ios',
      IOS_HASH,
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
  });

  it(`should report a hit and record it against the project fingerprint`, async () => {
    vi.mocked(lookUpCachedBuildAsync).mockResolvedValue({ state: 'found', build: BUILD });

    const status = await readEasBuildsStatusAsync(projectRoot, {
      auth: signedIn,
      projectHash: PROJECT_HASH,
    });

    expect(iosOf(status.platforms)).toMatchObject({
      state: 'found',
      source: 'eas',
      buildId: BUILD.id,
    });
    expect(readEasBuildsRecord(projectRoot).ios).toMatchObject({
      projectHash: PROJECT_HASH,
      fingerprintHash: IOS_HASH,
      build: { id: BUILD.id },
    });
  });

  // A "none" goes out of date on the timeline of the workflow it belongs to: a build started now
  // finishes in fifteen minutes, and a remembered "there is none" would be wrong exactly then. So
  // it is written with the time it was true, and believed for a bounded while.
  it(`should record a none with the time it was true`, async () => {
    const status = await readEasBuildsStatusAsync(projectRoot, {
      auth: signedIn,
      projectHash: PROJECT_HASH,
    });

    expect(iosOf(status.platforms)).toMatchObject({
      state: 'none',
      source: 'eas',
      checkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      ageMs: null,
    });
    expect(readEasBuildsRecord(projectRoot).ios).toMatchObject({
      projectHash: PROJECT_HASH,
      fingerprintHash: IOS_HASH,
      build: null,
      checkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it(`should answer a remembered none from the record, with its age, and spawn nothing`, async () => {
    const checkedAt = new Date(Date.now() - 60_000).toISOString();
    writeCache({ projectHash: PROJECT_HASH, fingerprintHash: IOS_HASH, build: null, checkedAt });

    const status = await readEasBuildsStatusAsync(projectRoot, {
      auth: signedIn,
      projectHash: PROJECT_HASH,
    });

    expect(iosOf(status.platforms)).toMatchObject({
      state: 'none',
      source: 'cache',
      fingerprintHash: IOS_HASH,
      checkedAt,
    });
    expect(iosOf(status.platforms).ageMs).toBeGreaterThanOrEqual(60_000);
    // Android has no entry and is looked up; iOS, which has one, spawns nothing.
    expect(generateFingerprintAsync).not.toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({ platform: 'ios' })
    );
    expect(lookUpCachedBuildAsync).toHaveBeenCalledTimes(1);
    expect(lookUpCachedBuildAsync).toHaveBeenCalledWith(
      expect.anything(),
      projectRoot,
      'android',
      expect.anything(),
      expect.anything()
    );
  });

  it(`should ask EAS again once a remembered none is older than its bound`, async () => {
    const checkedAt = new Date(Date.now() - EAS_NONE_CACHE_TTL_MS - 1000).toISOString();
    writeCache({ projectHash: PROJECT_HASH, fingerprintHash: IOS_HASH, build: null, checkedAt });

    const status = await readEasBuildsStatusAsync(projectRoot, {
      auth: signedIn,
      projectHash: PROJECT_HASH,
    });

    expect(iosOf(status.platforms)).toMatchObject({ state: 'none', source: 'eas' });
    expect(lookUpCachedBuildAsync).toHaveBeenCalled();
  });

  // @ref llp/0023-fingerprint-caching.rfc.md §Every consumer can turn it off
  // The flag is about what the caller will accept: a caller who refused the fingerprint record
  // wants a measurement, and a remembered EAS answer is not one.
  it(`should not read the record at all when the cache is refused`, async () => {
    writeCache({ projectHash: PROJECT_HASH, fingerprintHash: IOS_HASH, build: BUILD });

    const status = await readEasBuildsStatusAsync(projectRoot, {
      auth: signedIn,
      projectHash: PROJECT_HASH,
      fingerprintCache: false,
    });

    expect(lookUpCachedBuildAsync).toHaveBeenCalled();
    expect(iosOf(status.platforms).source).toBe('eas');
  });

  // The refusal `eas build:list` prints for an unlinked project, read off the static config for
  // free. The sentence names the fix, with the account the auth section knew.
  it(`should answer unknown, and ask nobody, for a project whose static config names no EAS project`, async () => {
    const status = await readEasBuildsStatusAsync(projectRoot, {
      auth: signedIn,
      projectHash: PROJECT_HASH,
      easProject: { projectId: null, source: 'app.json', dynamic: false },
    });

    expect(iosOf(status.platforms).state).toBe('unknown');
    expect(iosOf(status.platforms).reason).toContain('not linked to an EAS project');
    expect(iosOf(status.platforms).reason).toContain('app.json names no extra.eas.projectId');
    expect(iosOf(status.platforms).reason).toContain('init --account alice --non-interactive');
    expect(generateFingerprintAsync).not.toHaveBeenCalled();
    expect(lookUpCachedBuildAsync).not.toHaveBeenCalled();
  });

  it(`should still answer a remembered build for a project the static config calls unlinked`, async () => {
    writeCache({ projectHash: PROJECT_HASH, fingerprintHash: IOS_HASH, build: BUILD });

    const status = await readEasBuildsStatusAsync(projectRoot, {
      auth: signedIn,
      projectHash: PROJECT_HASH,
      easProject: { projectId: null, source: 'app.json', dynamic: false },
    });

    expect(iosOf(status.platforms)).toMatchObject({ state: 'found', source: 'cache' });
  });

  // "Not seen" is not "not there": a dynamic config may name the id from the environment, and this
  // CLI does not evaluate it (llp/0001 §Constraints item 5).
  it.each([
    [
      'a dynamic config beside a static one that names none',
      { projectId: null, source: 'app.json', dynamic: true },
    ],
    ['a static config that names one', { projectId: 'proj-1', source: 'app.json', dynamic: false }],
    ['no app config at all beside a dynamic one', { projectId: null, source: null, dynamic: true }],
  ])(`should ask EAS for %s`, async (_name, easProject) => {
    await readEasBuildsStatusAsync(projectRoot, {
      auth: signedIn,
      projectHash: PROJECT_HASH,
      easProject,
    });

    expect(lookUpCachedBuildAsync).toHaveBeenCalled();
  });

  it(`should pass the lookup's own reason through as the unknown`, async () => {
    vi.mocked(lookUpCachedBuildAsync).mockResolvedValue({
      state: 'unknown',
      reason: 'EAS project not configured.',
    });

    const status = await readEasBuildsStatusAsync(projectRoot, {
      auth: signedIn,
      projectHash: PROJECT_HASH,
    });

    expect(iosOf(status.platforms)).toMatchObject({
      state: 'unknown',
      reason: 'EAS project not configured.',
      fingerprintHash: IOS_HASH,
    });
    expect(fs.existsSync(recordFile)).toBe(false);
  });

  it(`should answer unknown, and ask nobody, when the platform cannot be fingerprinted`, async () => {
    vi.mocked(generateFingerprintAsync).mockResolvedValue({
      hash: null,
      sources: null,
      error: 'no fingerprint CLI',
    });

    const status = await readEasBuildsStatusAsync(projectRoot, {
      auth: signedIn,
      projectHash: PROJECT_HASH,
    });

    expect(iosOf(status.platforms)).toMatchObject({
      state: 'unknown',
      reason: 'no fingerprint CLI',
    });
    expect(lookUpCachedBuildAsync).not.toHaveBeenCalled();
  });

  // The deadline is the section's own, above the one the lookup is given, so a fingerprint run
  // that never returns costs a line rather than the report.
  it(`should answer unknown when the whole lookup runs past its deadline`, async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(generateFingerprintAsync).mockReturnValue(new Promise(() => {}));

      const pending = readEasBuildsStatusAsync(projectRoot, {
        auth: signedIn,
        projectHash: PROJECT_HASH,
        timeoutMs: 5000,
      });
      await vi.advanceTimersByTimeAsync(5000);
      const status = await pending;

      expect(iosOf(status.platforms)).toMatchObject({
        state: 'unknown',
        reason: expect.stringContaining('the lookup did not finish within 5000ms'),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe(readEasBuildsRecord, () => {
  it(`should read nothing when the project has no record`, () => {
    vol.fromJSON({ '/project/package.json': '{}' });

    expect(readEasBuildsRecord(projectRoot)).toEqual({});
  });

  it.each([
    ['unparsable JSON', '{ not json'],
    ['an array', '[]'],
    ['an entry with no project hash', JSON.stringify({ ios: { fingerprintHash: 'a', build: {} } })],
    ['an entry with no fingerprint hash', JSON.stringify({ ios: { projectHash: 'a', build: {} } })],
    [
      'an entry whose build has no id',
      JSON.stringify({ ios: { projectHash: 'a', fingerprintHash: 'b', build: { status: 'X' } } }),
    ],
    // A none with no time is a none with no bound.
    [
      'a none that does not say when it was true',
      JSON.stringify({ ios: { projectHash: 'a', fingerprintHash: 'b', build: null } }),
    ],
    [
      'a none whose time is not one',
      JSON.stringify({
        ios: { projectHash: 'a', fingerprintHash: 'b', build: null, checkedAt: 'yesterday' },
      }),
    ],
  ])(`should drop %s rather than trusting it`, (_name, contents) => {
    vol.fromJSON({ [recordFile]: contents });

    expect(readEasBuildsRecord(projectRoot).ios).toBeUndefined();
  });

  it(`should read a none that says when it was true`, () => {
    const checkedAt = '2026-08-27T10:00:00.000Z';
    vol.fromJSON({
      [recordFile]: JSON.stringify({
        ios: { projectHash: 'a', fingerprintHash: 'b', build: null, checkedAt },
      }),
    });

    expect(readEasBuildsRecord(projectRoot).ios).toEqual({
      projectHash: 'a',
      fingerprintHash: 'b',
      build: null,
      checkedAt,
    });
  });
});

describe(writeEasBuildsEntry, () => {
  it(`should keep the other platform's entry`, () => {
    writeCache({ projectHash: PROJECT_HASH, fingerprintHash: IOS_HASH, build: BUILD });

    writeEasBuildsEntry(projectRoot, 'android', {
      projectHash: PROJECT_HASH,
      fingerprintHash: 'android-hash',
      build: { ...BUILD, id: 'android-build', platform: 'ANDROID' },
    });

    const record = readEasBuildsRecord(projectRoot);
    expect(record.ios?.build?.id).toBe(BUILD.id);
    expect(record.android?.build?.id).toBe('android-build');
  });

  it(`should write nothing when there is no project hash to key the entry on`, () => {
    writeEasBuildsEntry(projectRoot, 'ios', {
      projectHash: null,
      fingerprintHash: IOS_HASH,
      build: BUILD,
    });

    expect(fs.existsSync(recordFile)).toBe(false);
  });

  it(`should not fail the caller when the record cannot be written`, () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('EROFS');
    });

    expect(() =>
      writeEasBuildsEntry(projectRoot, 'ios', {
        projectHash: PROJECT_HASH,
        fingerprintHash: IOS_HASH,
        build: BUILD,
      })
    ).not.toThrow();
  });
});
