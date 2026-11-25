import fs from 'fs';
import path from 'path';

import { filesOfPatchAsync } from '../upstream';

// Real git reads real files: memfs cannot hold them.
vi.unmock('fs');
vi.unmock('node:fs');
vi.unmock('child_process');
vi.unmock('node:child_process');

const os = await vi.importActual<typeof import('os')>('os');

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-upstream-files-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe(filesOfPatchAsync, () => {
  it.each([
    [
      'git style from the package (bun, pnpm, yarn)',
      'diff --git a/ios/X.swift b/ios/X.swift\n--- a/ios/X.swift\n+++ b/ios/X.swift\n@@ -1 +1 @@\n-a\n+b\n',
      ['ios/X.swift'],
    ],
    [
      'patch-package, scoped',
      'diff --git a/node_modules/@expo/image/src/a.ts b/node_modules/@expo/image/src/a.ts\n--- a/node_modules/@expo/image/src/a.ts\n+++ b/node_modules/@expo/image/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n',
      ['src/a.ts'],
    ],
    // npm 12.2.3 writes a plain unified diff with a tab after the name, and no `diff --git` line.
    ['npm 12', '--- a/index.js\t\n+++ b/index.js\t\n@@ -1,2 +1,3 @@\n x\n y\n+z\n', ['index.js']],
    ['a deleted file', '--- a/old.js\t\n+++ /dev/null\t\n@@ -1 +0,0 @@\n-x\n', ['old.js']],
    [
      'a renamed file',
      'diff --git a/old.js b/new.js\nsimilarity index 100%\nrename from old.js\nrename to new.js\n',
      ['new.js'],
    ],
    // Hunk lines that look like headers: an added `++ b/fix` and a removed `-- a/old`.
    [
      'header-like lines inside a hunk',
      '--- a/index.js\t\n+++ b/index.js\t\n@@ -1,2 +1,2 @@\n x\n--- a/old\n+++ b/fix\n--- a/other.js\t\n+++ b/other.js\t\n@@ -1 +1,2 @@\n y\n+z\n',
      ['index.js', 'other.js'],
    ],
    // git writes a non-ASCII path in C quotes with core.quotepath=true (the default).
    [
      'a C-quoted path',
      'diff --git "a/ios/caf\\303\\251.swift" "b/ios/caf\\303\\251.swift"\n--- "a/ios/caf\\303\\251.swift"\n+++ "b/ios/caf\\303\\251.swift"\n@@ -1 +1 @@\n-a\n+b\n',
      ['ios/café.swift'],
    ],
  ])('%s', async (_name, patch, files) => {
    const patchFile = path.join(dir, 'x.patch');
    fs.writeFileSync(patchFile, patch);
    await expect(filesOfPatchAsync(patchFile)).resolves.toEqual(files);
  });
});
