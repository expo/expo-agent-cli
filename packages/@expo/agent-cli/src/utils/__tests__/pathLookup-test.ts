import fs from 'fs';
import { vol } from 'memfs';
import path from 'path';

import { findExecutableOnPath, pathFromEnv } from '../pathLookup';
import { mockPlatform } from './mockPlatform';

/** Build a `PATH` value the way the running platform writes it. */
const pathOf = (...dirs: string[]) => dirs.join(path.delimiter);

afterEach(() => {
  vol.reset();
});

describe(findExecutableOnPath, () => {
  it(`should return the first directory of PATH that holds the executable`, () => {
    vol.fromJSON({ '/usr/local/bin/eas': '#!/bin/sh', '/opt/bin/eas': '#!/bin/sh' });

    expect(findExecutableOnPath('eas', { pathEnv: pathOf('/opt/bin', '/usr/local/bin') })).toBe(
      path.join('/opt/bin', 'eas')
    );
  });

  it(`should skip entries of PATH that do not hold the executable`, () => {
    vol.fromJSON({ '/usr/local/bin/eas': '#!/bin/sh' });

    expect(findExecutableOnPath('eas', { pathEnv: pathOf('/nope', '', '/usr/local/bin') })).toBe(
      path.join('/usr/local/bin', 'eas')
    );
  });

  it(`should return null when nothing on PATH provides the executable`, () => {
    vol.fromJSON({ '/usr/local/bin/expo': '#!/bin/sh' });

    expect(findExecutableOnPath('eas', { pathEnv: pathOf('/usr/local/bin') })).toBeNull();
  });

  it(`should return null for an empty PATH`, () => {
    expect(findExecutableOnPath('eas', { pathEnv: '' })).toBeNull();
  });

  it(`should skip an entry of PATH whose stat throws, and keep looking`, () => {
    // A symlink loop throws ELOOP even with `throwIfNoEntry: false`; one bad entry must not abort the
    // lookup, nor hide a later entry that does hold the executable.
    vol.fromJSON({ '/usr/local/bin/eas': '#!/bin/sh' });
    const realStat = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((
      file: fs.PathLike,
      options?: fs.StatSyncOptions
    ) => {
      if (String(file).startsWith(`${path.sep}loop`)) {
        throw Object.assign(new Error('ELOOP: too many symbolic links encountered'), {
          code: 'ELOOP',
        });
      }
      return realStat(file, options);
    }) as typeof fs.statSync);

    expect(findExecutableOnPath('eas', { pathEnv: pathOf('/loop', '/usr/local/bin') })).toBe(
      path.join('/usr/local/bin', 'eas')
    );
    expect(findExecutableOnPath('eas', { pathEnv: pathOf('/loop') })).toBeNull();
    vi.mocked(fs.statSync).mockRestore();
  });
});

describe('on windows', () => {
  beforeEach(() => {
    mockPlatform('win32');
  });

  it(`should find a tool that exists only as a .bat file`, () => {
    vi.spyOn(fs, 'statSync').mockImplementation((file) => {
      if (String(file) === 'C:\\tools\\foo.bat') {
        return { isFile: () => true } as fs.Stats;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    expect(findExecutableOnPath('foo', { pathEnv: 'C:\\none;C:\\tools' })).toBe(
      'C:\\tools\\foo.bat'
    );
  });

  it(`should read PATH whatever its case, like the child does`, () => {
    expect(pathFromEnv({ path: 'C:\\lower' })).toBe('C:\\lower');
  });

  it(`should pick the key Node keeps when PATH and Path are both set`, () => {
    expect(pathFromEnv({ Path: 'C:\\parent', PATH: 'C:\\child' })).toBe('C:\\child');
  });
});

describe('on posix', () => {
  beforeEach(() => {
    mockPlatform('darwin');
  });

  it(`should read only PATH, because env keys are case-sensitive`, () => {
    expect(pathFromEnv({ Path: '/other' })).toBe('');
  });
});
