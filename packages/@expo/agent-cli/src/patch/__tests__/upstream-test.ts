import { isExpoRepoPackage } from '../patchAsync';
import {
  assertReproUrl,
  filesOfPatch,
  mapUpstreamFile,
  repositoryDirectory,
  upstreamBase,
} from '../upstream';

describe(isExpoRepoPackage, () => {
  it.each([
    ['https://github.com/expo/expo.git', true],
    ['git+https://github.com/expo/expo.git', true],
    ['git@github.com:expo/expo.git', true],
    ['https://github.com/expo/expo', true],
    ['https://notgithub.com/expo/expo', false],
    ['https://evil.example/github.com/expo/expo', false],
    ['https://github.com/expo/expo-cli', false],
  ])('%s → %s', (url, expected) => {
    expect(isExpoRepoPackage({ repository: { url } })).toBe(expected);
  });
});

describe(assertReproUrl, () => {
  it.each([
    ['https://github.com/someone/expo-image-crash-on-rotate', true],
    ['https://github.com/someone/repro.git', true],
    ['https://github.com/someone/repro/', true],
    ['https://github.com/someone/repro/issues/1', false],
    ['https://github.com/someone/repro/blob/main/App.tsx', false],
    ['repro.md', false],
  ])('%s → %s', (url, accepted) => {
    const run = () => assertReproUrl(url);
    if (accepted) {
      expect(run()).toBe(url);
    } else {
      expect(run).toThrow(expect.objectContaining({ code: 'BAD_ARGS' }));
    }
  });
});

describe(repositoryDirectory, () => {
  const url = 'https://github.com/expo/expo';
  it.each([
    [{ url, directory: 'packages/expo-image' }, 'packages/expo-image'],
    [{ url, directory: 'packages/@expo/config-plugins/' }, 'packages/@expo/config-plugins'],
    [{ url, directory: "packages/x'; id; #" }, null],
    [{ url, directory: 'packages/../../etc' }, null],
    [{ url, directory: '/packages/expo-image' }, null],
    [{ url, directory: 'packages/a b' }, null],
    // No guess from the npm name.
    [{ url }, null],
    [url, null],
  ])('%j → %s', (repository, expected) => {
    const run = () => repositoryDirectory({ repository }, 'pkg');
    if (expected) {
      expect(run()).toBe(expected);
    } else {
      expect(run).toThrow(expect.objectContaining({ code: 'PATCH_BAD_REPOSITORY' }));
    }
  });
});

describe(mapUpstreamFile, () => {
  it.each([
    ['ios/FakeModule.swift', 'packages/x/ios/FakeModule.swift', null],
    ['android/build.gradle', 'packages/x/android/build.gradle', null],
    ['build/index.js', null, 'packages/x/src/index.ts (or .tsx)'],
    ['build/index.d.ts', null, 'packages/x/src/index.ts (or .tsx)'],
    ['plugin/build/index.js', null, 'packages/x/plugin/src/index.ts (or .tsx)'],
  ])('%s → %s, port to %s', (file, target, portTo) => {
    expect(mapUpstreamFile(file, 'packages/x')).toEqual({ file, target, portTo });
  });
});

describe(upstreamBase, () => {
  it.each([
    ['0123456789abcdef0123456789abcdef01234567', '0123456789abcdef0123456789abcdef01234567'],
    ['main; touch pwned', 'main'],
    ['sdk-54', 'main'],
    [undefined, 'main'],
  ])('gitHead %s → %s', (gitHead, expected) => {
    expect(upstreamBase({ gitHead })).toBe(expected);
  });
});

describe(filesOfPatch, () => {
  it.each([
    [
      'git style from the package (bun, pnpm, yarn)',
      'diff --git a/ios/X.swift b/ios/X.swift\n--- a/ios/X.swift\n+++ b/ios/X.swift\n@@ -1 +1 @@\n',
      ['ios/X.swift'],
    ],
    [
      'patch-package, scoped',
      'diff --git a/node_modules/@expo/image/src/a.ts b/node_modules/@expo/image/src/a.ts\n--- a/node_modules/@expo/image/src/a.ts\n+++ b/node_modules/@expo/image/src/a.ts\n',
      ['src/a.ts'],
    ],
    // npm 12.2.3 writes a plain unified diff with a tab after the name, and no `diff --git` line.
    ['npm 12', '--- a/index.js\t\n+++ b/index.js\t\n@@ -15,4 +15,5 @@\n', ['index.js']],
    ['a deleted file', '--- a/old.js\n+++ /dev/null\n', ['old.js']],
    // Hunk lines that look like headers: an added `++ b/fix` and a removed `-- a/old`.
    [
      'header-like lines inside a hunk',
      '--- a/index.js\t\n+++ b/index.js\t\n@@ -1,2 +1,2 @@\n x\n--- a/old\n+++ b/fix\n--- a/other.js\t\n+++ b/other.js\t\n@@ -1 +1,2 @@\n y\n+z\n',
      ['index.js', 'other.js'],
    ],
    // Headers as git 2.54 wrote them with core.quotepath=true (the default).
    [
      'C-quoted paths: non-ASCII, and a quote with a space',
      '--- "a/ios/caf\\303\\251.swift"\n+++ "b/ios/caf\\303\\251.swift"\n--- "a/ios/say \\"hi\\".swift"\t\n+++ "b/ios/say \\"hi\\".swift"\n',
      ['ios/café.swift', 'ios/say "hi".swift'],
    ],
  ])('%s', (_name, patch, files) => {
    expect(filesOfPatch(patch)).toEqual(files);
  });
});
