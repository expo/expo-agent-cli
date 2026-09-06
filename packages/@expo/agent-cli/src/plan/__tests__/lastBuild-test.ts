import fs from 'fs';
import { vol } from 'memfs';

import {
  LAST_BUILD_FILE_NAME,
  readLastBuildRecord,
  recordLastBuildFingerprint,
} from '../lastBuild';

/** One source, in the shape `fingerprint:generate` prints [observed — real capture, 2026-08-24]. */
const source = {
  type: 'dir',
  filePath: 'node_modules/react-native-mmkv',
  reasons: ['rncoreAutolinkingIos'],
  hash: 'aabbcc',
};

const projectRoot = '/project';
const lastBuildFile = `${projectRoot}/.expo/${LAST_BUILD_FILE_NAME}`;

beforeEach(() => {
  vol.reset();
});

// These rows read `readLastBuildRecord` because the hashes-only reader they were written against
// is gone: the plan engine takes the whole record now (llp/0004 §Decision table), and nothing was
// left calling it. The hardening they cover is the record reader's own and outlived the view.
describe(`${readLastBuildRecord.name} — an unreadable record`, () => {
  it(`should return nothing when the project has no record`, () => {
    vol.fromJSON({ '/project/package.json': '{}' });

    expect(readLastBuildRecord(projectRoot)).toEqual({});
  });

  it(`should read the recorded hash of every platform`, () => {
    vol.fromJSON({ [lastBuildFile]: JSON.stringify({ ios: 'hash-ios', android: 'hash-android' }) });

    expect(readLastBuildRecord(projectRoot)).toEqual({
      ios: { hash: 'hash-ios', sources: null },
      android: { hash: 'hash-android', sources: null },
    });
  });

  it(`should ignore a corrupt record instead of failing the command`, () => {
    vol.fromJSON({ [lastBuildFile]: '{ not json' });

    expect(readLastBuildRecord(projectRoot)).toEqual({});
  });

  it(`should ignore a record that is not an object`, () => {
    vol.fromJSON({ [lastBuildFile]: '"hash-ios"' });

    expect(readLastBuildRecord(projectRoot)).toEqual({});
  });

  it(`should ignore unknown platforms and non-string hashes`, () => {
    vol.fromJSON({
      [lastBuildFile]: JSON.stringify({ ios: 'hash-ios', android: 42, windows: 'hash-windows' }),
    });

    expect(readLastBuildRecord(projectRoot)).toEqual({ ios: { hash: 'hash-ios', sources: null } });
  });
});

describe(recordLastBuildFingerprint, () => {
  it(`should create the record in the .expo directory`, () => {
    vol.fromJSON({ '/project/package.json': '{}' });

    recordLastBuildFingerprint(projectRoot, 'ios', 'hash-ios');

    expect(readLastBuildRecord(projectRoot)).toEqual({ ios: { hash: 'hash-ios', sources: null } });
    expect(fs.existsSync(lastBuildFile)).toBe(true);
  });

  it(`should keep the hash recorded for the other platform`, () => {
    vol.fromJSON({ [lastBuildFile]: JSON.stringify({ android: 'hash-android' }) });

    recordLastBuildFingerprint(projectRoot, 'ios', 'hash-ios');

    expect(readLastBuildRecord(projectRoot)).toEqual({
      ios: { hash: 'hash-ios', sources: null },
      android: { hash: 'hash-android', sources: null },
    });
  });

  it(`should replace the hash of the same platform`, () => {
    vol.fromJSON({ [lastBuildFile]: JSON.stringify({ ios: 'old-hash' }) });

    recordLastBuildFingerprint(projectRoot, 'ios', 'new-hash');

    expect(readLastBuildRecord(projectRoot)).toEqual({ ios: { hash: 'new-hash', sources: null } });
  });

  it(`should replace a corrupt record`, () => {
    vol.fromJSON({ [lastBuildFile]: '{ not json' });

    recordLastBuildFingerprint(projectRoot, 'android', 'hash-android');

    expect(readLastBuildRecord(projectRoot)).toEqual({
      android: { hash: 'hash-android', sources: null },
    });
  });

  it(`should never fail the command when the record cannot be written`, () => {
    vol.fromJSON({ '/project/package.json': '{}' });
    const writeFileSync = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    expect(() => recordLastBuildFingerprint(projectRoot, 'ios', 'hash-ios')).not.toThrow();

    writeFileSync.mockRestore();
  });

  it(`should store the sources so a later diff has a base`, () => {
    vol.fromJSON({ '/project/package.json': '{}' });

    recordLastBuildFingerprint(projectRoot, 'ios', { hash: 'hash-ios', sources: [source] });

    expect(readLastBuildRecord(projectRoot)).toEqual({
      ios: { hash: 'hash-ios', sources: [source] },
    });
  });

  it(`should keep a v1 entry of the other platform while writing a v2 one`, () => {
    vol.fromJSON({ [lastBuildFile]: JSON.stringify({ android: 'hash-android' }) });

    recordLastBuildFingerprint(projectRoot, 'ios', { hash: 'hash-ios', sources: [source] });

    expect(readLastBuildRecord(projectRoot)).toEqual({
      ios: { hash: 'hash-ios', sources: [source] },
      android: { hash: 'hash-android', sources: null },
    });
  });
});

describe(readLastBuildRecord, () => {
  it(`should read a v1 bare string as a hash with no sources`, () => {
    vol.fromJSON({ [lastBuildFile]: JSON.stringify({ ios: 'hash-ios' }) });

    expect(readLastBuildRecord(projectRoot)).toEqual({ ios: { hash: 'hash-ios', sources: null } });
  });

  it(`should read a v2 entry whole`, () => {
    vol.fromJSON({
      [lastBuildFile]: JSON.stringify({ ios: { hash: 'hash-ios', sources: [source] } }),
    });

    expect(readLastBuildRecord(projectRoot)).toEqual({
      ios: { hash: 'hash-ios', sources: [source] },
    });
  });

  it(`should read both shapes out of one record`, () => {
    vol.fromJSON({
      [lastBuildFile]: JSON.stringify({
        ios: { hash: 'hash-ios', sources: [source] },
        android: 'hash-android',
      }),
    });

    expect(readLastBuildRecord(projectRoot)).toEqual({
      ios: { hash: 'hash-ios', sources: [source] },
      android: { hash: 'hash-android', sources: null },
    });
  });

  it(`should degrade a v2 entry whose sources are not an array to the v1 answer`, () => {
    vol.fromJSON({
      [lastBuildFile]: JSON.stringify({ ios: { hash: 'hash-ios', sources: 'truncated' } }),
    });

    expect(readLastBuildRecord(projectRoot)).toEqual({ ios: { hash: 'hash-ios', sources: null } });
  });

  it(`should ignore an entry with no usable hash`, () => {
    vol.fromJSON({
      [lastBuildFile]: JSON.stringify({ ios: { sources: [source] }, android: { hash: 42 } }),
    });

    expect(readLastBuildRecord(projectRoot)).toEqual({});
  });

});
