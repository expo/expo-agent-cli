import fs from 'fs';
import path from 'path';

import { isExpoRepoPackage } from '../patchAsync';
import {
  assertReproUrl,
  filesOfPatch,
  findPatchFile,
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
  ])('%s', (_name, patch, files) => {
    expect(filesOfPatch(patch)).toEqual(files);
  });
});

describe(findPatchFile, () => {
  // `fs` is memfs in unit tests.
  const root = path.resolve('/project');
  beforeEach(() => {
    fs.mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A project with these files, each holding its own name. */
  function project(
    files: Record<string, string | undefined>,
    pkg: Record<string, unknown> = {}
  ): void {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app', ...pkg }));
    for (const [file, text = ''] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
  }

  // The layouts are the ones each manager wrote on 2026-11-18 for `@fake/scoped-lib`.
  it.each([
    {
      name: 'bun 1.4.4 (scoped name percent-encoded, keyed by spec)',
      files: { 'patches/@fake%2Fscoped-lib@.%2Ffake-scoped-lib-3.0.0.tgz.patch': '' },
      pkg: {
        patchedDependencies: {
          '@fake/scoped-lib@./fake-scoped-lib-3.0.0.tgz':
            'patches/@fake%2Fscoped-lib@.%2Ffake-scoped-lib-3.0.0.tgz.patch',
        },
      },
      expected: 'patches/@fake%2Fscoped-lib@.%2Ffake-scoped-lib-3.0.0.tgz.patch',
    },
    {
      name: 'pnpm 12.2.1 (pnpm-workspace.yaml)',
      files: {
        'patches/@fake__scoped-lib@3.0.0.patch': '',
        'pnpm-workspace.yaml':
          "patchedDependencies:\n  '@fake/scoped-lib@3.0.0': patches/@fake__scoped-lib@3.0.0.patch\n",
      },
      pkg: {},
      expected: 'patches/@fake__scoped-lib@3.0.0.patch',
    },
    {
      name: 'yarn 4.18.1 (a patch: descriptor)',
      files: { '.yarn/patches/@fake-scoped-lib-file-33ce74d7f0.patch': '' },
      pkg: {
        dependencies: {
          '@fake/scoped-lib':
            'patch:@fake/scoped-lib@file%3A./fake-scoped-lib-3.0.0.tgz%23./fake-scoped-lib-3.0.0.tgz%3A%3Ahash=09089c&locator=a%2540workspace%253A.#~/.yarn/patches/@fake-scoped-lib-file-33ce74d7f0.patch',
        },
      },
      expected: '.yarn/patches/@fake-scoped-lib-file-33ce74d7f0.patch',
    },
    {
      name: 'patch-package (scoped name with +)',
      files: { 'patches/@fake+scoped-lib+3.0.0.patch': '' },
      pkg: {},
      expected: 'patches/@fake+scoped-lib+3.0.0.patch',
    },
    {
      name: 'an exact version first, over a range and a spec that is not a version',
      files: { 'patches/exact.patch': '', 'patches/range.patch': '', 'patches/bun.patch': '' },
      pkg: {
        patchedDependencies: {
          '@fake/scoped-lib@^3.0.0': 'patches/range.patch',
          '@fake/scoped-lib@./fake-scoped-lib-3.0.0.tgz': 'patches/bun.patch',
          '@fake/scoped-lib@3.0.0': 'patches/exact.patch',
        },
      },
      expected: 'patches/exact.patch',
    },
    {
      name: 'a range that contains the installed version, over another version',
      files: { 'patches/old.patch': '', 'patches/range.patch': '' },
      pkg: {
        patchedDependencies: {
          '@fake/scoped-lib@2.0.0': 'patches/old.patch',
          '@fake/scoped-lib@^3.0.0': 'patches/range.patch',
        },
      },
      expected: 'patches/range.patch',
    },
    {
      name: "bun's file: key, over another version",
      files: { 'patches/old.patch': '', 'patches/bun.patch': '' },
      pkg: {
        patchedDependencies: {
          '@fake/scoped-lib@2.0.0': 'patches/old.patch',
          '@fake/scoped-lib@./fake-scoped-lib-3.0.0.tgz': 'patches/bun.patch',
        },
      },
      expected: 'patches/bun.patch',
    },
    {
      name: 'a registration, over a leftover patch-package file',
      files: { 'patches/@fake+scoped-lib+3.0.0.patch': '', 'patches/bun.patch': '' },
      pkg: {
        patchedDependencies: {
          '@fake/scoped-lib@./fake-scoped-lib-3.0.0.tgz': 'patches/bun.patch',
        },
      },
      expected: 'patches/bun.patch',
    },
  ])('$name', ({ files, pkg, expected }) => {
    project(files, pkg);
    expect(findPatchFile(root, '@fake/scoped-lib', '3.0.0')).toBe(path.join(root, expected));
  });

  it.each([
    {
      name: 'nothing registered',
      files: { 'patches/@fake+scoped-lib+2.0.0.patch': '' },
      pkg: {},
      code: 'PATCH_NOT_FOUND',
    },
    {
      name: 'only another version registered',
      files: { 'patches/a.patch': '' },
      pkg: { patchedDependencies: { '@fake/scoped-lib@2.0.0': 'patches/a.patch' } },
      code: 'PATCH_NOT_FOUND',
    },
    {
      name: 'two files for the installed version',
      files: {
        'patches/a.patch': '',
        'patches/b.patch': '',
        'pnpm-workspace.yaml':
          "patchedDependencies:\n  '@fake/scoped-lib@3.0.0': patches/b.patch\n",
      },
      pkg: { patchedDependencies: { '@fake/scoped-lib@3.0.0': 'patches/a.patch' } },
      code: 'PATCH_AMBIGUOUS',
    },
  ])('refuses: $name', ({ files, pkg, code }) => {
    project(files, pkg);
    expect(() => findPatchFile(root, '@fake/scoped-lib', '3.0.0')).toThrow(
      expect.objectContaining({ code })
    );
  });
});
