import { describeSource, diffSources, formatChangedSources } from '../sourceDiff';

describe(diffSources, () => {
  it('uses package versions and contents override keys as source identities', () => {
    expect(
      diffSources(
        [{ type: 'package', name: 'pkg', version: '1', hash: 'a' }],
        [{ type: 'package', name: 'pkg', version: '2', hash: 'b' }]
      ).map((item) => item.change)
    ).toEqual(['removed', 'added']);
    expect(
      diffSources(
        [{ type: 'contents', id: 'old', overrideHashKey: 'stable', hash: 'a' }],
        [{ type: 'contents', id: 'new', overrideHashKey: 'stable', hash: 'a' }]
      )
    ).toEqual([]);
  });
});

describe(describeSource, () => {
  it.each(['node_modules/pkg/a', 'node_modules\\pkg\\a', '../pkg/a', '..\\pkg\\a'])(
    'recognizes dependency path %s',
    (filePath) => {
      expect(describeSource({ type: 'file', filePath }).scope).toBe('dependency');
    }
  );
  it('excludes React Native contents and names common project inputs', () => {
    expect(describeSource({ type: 'contents', id: 'package:react-native' }).scope).toBe(
      'dependency'
    );
    expect(describeSource({ type: 'contents', id: 'expoAutolinkingConfig:ios' }).source).toBe(
      'Expo autolinking configuration'
    );
    expect(describeSource({ type: 'contents', id: 'packageJson:scripts' }).source).toBe(
      'package.json scripts'
    );
  });
});

it('limits project source names after filtering dependencies', () => {
  const changes = diffSources(
    [],
    [
      { type: 'contents', id: 'package:react-native', hash: '1' },
      ...['a', 'b', 'c', 'd'].map((filePath) => ({ type: 'file', filePath, hash: '1' })),
    ]
  );
  expect(formatChangedSources(changes, 2)).toBe('a, b, and 2 more');
  expect(formatChangedSources(changes.slice(0, 1))).toBe('');
});
