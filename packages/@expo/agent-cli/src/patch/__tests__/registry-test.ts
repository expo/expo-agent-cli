import fs from 'fs';
import path from 'path';

import { findPatchFile } from '../registry';

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

  it('reads the descriptor yarn 4.18.1 writes to the workspace package, with `~` as the root', () => {
    project({ '.yarn/patches/x.patch': '' });
    const projectRoot = path.join(root, 'apps', 'mobile');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@fake/scoped-lib':
            'patch:@fake/scoped-lib@file%3A./x.tgz%23./x.tgz%3A%3Ahash=c156c7&locator=mobile%2540workspace%253Aapps%252Fmobile#~/.yarn/patches/x.patch',
        },
      })
    );

    expect(findPatchFile(root, '@fake/scoped-lib', '3.0.0', projectRoot)).toBe(
      path.join(root, '.yarn/patches/x.patch')
    );
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
      // pnpm 12.2.1 reads it as a prerelease and fails the install with ERR_PNPM_UNUSED_PATCH.
      name: 'a hyphen key with no spaces, which is a version and not a range',
      files: { 'patches/a.patch': '' },
      pkg: { patchedDependencies: { '@fake/scoped-lib@2.2.0-3.1.0': 'patches/a.patch' } },
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
