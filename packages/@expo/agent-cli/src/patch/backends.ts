// @ref llp/0037-patch-command.rfc.md §Package-manager backends
// One backend per package manager. Each takes the edits an agent already made in
// `node_modules/<pkg>` and saves them with that package manager's own patch feature, so the patch
// file, its name and its registration are the ones the package manager applies on the next install.
//
// Observed on macOS, 2026-11-17:
// - bun 1.4.4: `bun patch --commit node_modules/<pkg>` works with no `bun patch <pkg>` before it, and
//   answers an unedited package with "No changes detected" and exit 0.
// - pnpm 12.2.1: `pnpm patch-commit node_modules/<pkg>` refuses ("is not a valid patch directory"),
//   so the backend makes pnpm's own edit directory and copies the edits into it.
// - patch-package 8.0.1 cannot make a patch for a package it cannot download again (a `file:`
//   tarball): it reinstalls `<name>@<version>` from the registry. So the npm backend writes the patch
//   itself, in patch-package's format, and patch-package only applies it at `postinstall`.
// - yarn 4.18.1 follows pnpm's shape: `yarn patch <pkg>` prints an edit folder, `yarn patch-commit -s`
//   saves it to `.yarn/patches/` and rewrites the dependency to a `patch:` spec.
// - yarn 1.22.22 has no patch feature, so it takes the npm path; its clean copy comes from the
//   `resolved` field of `yarn.lock`.

import fs from 'fs';
import os from 'os';
import path from 'path';

import type { DetectedPackageManager } from '../utils/packageManager';
import { CommandError } from '../utils/errors';
import { findExecutableOnPath } from '../utils/pathLookup';
import { spawnSubprocessAsync } from '../utils/subprocess';
import { applyTreeDiff, diffTrees, isEmptyDiff, type TreeDiff } from './tree';

export interface PatchTarget {
  projectRoot: string;
  packageManager: DetectedPackageManager;
  packageName: string;
  version: string;
  /** The installed package the agent edited, i.e. `node_modules/<pkg>` (symlinks not resolved). */
  packageDir: string;
}

export type BackendResult =
  | { status: 'no-edits' }
  | {
      status: 'saved';
      /** The patch file the package manager will apply, absolute. */
      patchFile: string;
      /** Files of the package the patch changes, relative to the package root. */
      files: string[];
    }
  | {
      status: 'needs-consent';
      /** What this run would change in the project besides the patch file. */
      projectChanges: string[];
      files: string[];
    };

export interface BackendOptions {
  /** The caller passed `--yes`. Only the npm backend asks for it. */
  yes: boolean;
}

export async function savePatchAsync(
  target: PatchTarget,
  options: BackendOptions
): Promise<BackendResult> {
  switch (target.packageManager.name) {
    case 'bun':
      return saveWithBunAsync(target);
    case 'pnpm':
      return saveWithEditDirAsync(target, 'pnpm');
    case 'yarn-berry':
      return saveWithEditDirAsync(target, 'yarn');
    case 'npm':
    case 'yarn-classic':
      return saveWithPatchPackageFormatAsync(target, options);
  }
}

// ---- bun ----

async function saveWithBunAsync(target: PatchTarget): Promise<BackendResult> {
  const root = target.packageManager.root;
  const before = snapshotPatchDirs(root);
  const relative = toPosix(path.relative(root, target.packageDir));
  const result = await runToolAsync('bun', ['patch', '--commit', relative], root);
  if (/No changes detected/i.test(`${result.stdout}\n${result.stderr}`)) {
    return { status: 'no-edits' };
  }
  const patchFile = findWrittenPatch(root, before);
  return { status: 'saved', patchFile, files: filesOfPatch(fs.readFileSync(patchFile, 'utf8')) };
}

// ---- pnpm, yarn berry ----

async function saveWithEditDirAsync(
  target: PatchTarget,
  tool: 'pnpm' | 'yarn'
): Promise<BackendResult> {
  const root = target.packageManager.root;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-patch-'));
  try {
    let editDir: string;
    if (tool === 'pnpm') {
      editDir = path.join(scratch, 'edit');
      await runToolAsync(
        'pnpm',
        ['patch', `${target.packageName}@${target.version}`, '--edit-dir', editDir],
        root
      );
    } else {
      const result = await runToolAsync('yarn', ['patch', target.packageName], root);
      editDir = parseYarnEditDir(`${result.stdout}\n${result.stderr}`);
    }

    // The edit directory is a clean copy: comparing against it is what finds the agent's edits.
    const diff = diffTrees(editDir, target.packageDir);
    if (isEmptyDiff(diff)) {
      return { status: 'no-edits' };
    }
    applyTreeDiff(diff, target.packageDir, editDir);

    const before = snapshotPatchDirs(root);
    if (tool === 'pnpm') {
      await runToolAsync('pnpm', ['patch-commit', editDir], root);
    } else {
      await runToolAsync('yarn', ['patch-commit', '-s', editDir], root);
    }
    return { status: 'saved', patchFile: findWrittenPatch(root, before), files: filesOfDiff(diff) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** The folder `yarn patch` prints, e.g. "➤ YN0000: You can now edit the following folder: /tmp/…". */
export function parseYarnEditDir(output: string): string {
  const match = /edit the following folder:\s*(\S+)/i.exec(output);
  if (!match) {
    throw new CommandError(
      'PATCH_TOOL_OUTPUT',
      `yarn patch did not print the folder to edit, so the patch cannot be saved.\nWhat it printed:\n${output.trim()}`
    );
  }
  return match[1]!;
}

// ---- npm, yarn classic: patch-package's format ----

/** The `postinstall` that applies the patches, and the package that provides it. */
export const PATCH_PACKAGE_SCRIPT = 'patch-package';
export const PATCH_PACKAGE_RANGE = '^8.0.0';

async function saveWithPatchPackageFormatAsync(
  target: PatchTarget,
  { yes }: BackendOptions
): Promise<BackendResult> {
  const root = target.packageManager.root;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-patch-'));
  try {
    const cleanDir = await fetchCleanCopyAsync(target, scratch);
    const diff = diffTrees(cleanDir, target.packageDir);
    if (isEmptyDiff(diff)) {
      return { status: 'no-edits' };
    }
    const files = filesOfDiff(diff);

    const projectChanges = patchPackageSetupChanges(root);
    if (projectChanges.length && !yes) {
      return { status: 'needs-consent', projectChanges, files };
    }

    const patchText = await unifiedDiffAsync(cleanDir, target.packageDir, diff, target.packageName);
    const patchFile = path.join(
      root,
      'patches',
      patchPackageFileName(target.packageName, target.version)
    );
    fs.mkdirSync(path.dirname(patchFile), { recursive: true });
    fs.writeFileSync(patchFile, patchText);
    applyPatchPackageSetup(root);
    return { status: 'saved', patchFile, files };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** patch-package's file name: `@scope+name+1.2.3.patch`. */
export function patchPackageFileName(packageName: string, version: string): string {
  return `${packageName.replace(/\//g, '+')}+${version}.patch`;
}

/**
 * Download the same version of the package again, unpacked, and return its root.
 *
 * The spec is what the lockfile says was installed, when it says so — a `file:` tarball or a git
 * URL has no registry version to ask for — and `<name>@<version>` otherwise.
 */
async function fetchCleanCopyAsync(target: PatchTarget, scratch: string): Promise<string> {
  const root = target.packageManager.root;
  const spec =
    (target.packageManager.name === 'yarn-classic'
      ? resolvedSpecFromYarnLock(
          fs.readFileSync(path.join(root, 'yarn.lock'), 'utf8'),
          target.packageName,
          target.version
        )
      : resolvedSpecFromNpmLock(root, target.packageDir)) ??
    `${target.packageName}@${target.version}`;
  const result = await runToolAsync(
    'npm',
    ['pack', spec, '--json', '--pack-destination', scratch],
    root
  );
  const tarball = path.join(scratch, parsePackFilename(result.stdout));
  const unpacked = path.join(scratch, 'clean');
  fs.mkdirSync(unpacked);
  await runToolAsync('tar', ['-xzf', tarball, '-C', unpacked], scratch);
  return path.join(unpacked, 'package');
}

function resolvedSpecFromNpmLock(root: string, packageDir: string): string | null {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const key = toPosix(path.relative(root, packageDir));
    const resolved: unknown = lock.packages?.[key]?.resolved;
    if (typeof resolved !== 'string') {
      return null;
    }
    // A `file:` spec in the lockfile is relative to the lockfile's directory, which is the cwd.
    return resolved;
  } catch {
    return null;
  }
}

/**
 * The `resolved` of a yarn classic lockfile entry for `<name>` at `<version>`, without its `#hash`.
 *
 * An entry is a header line of one or more specs (`"name@^1.0.0", name@~1.0.1:`) and indented
 * fields under it.
 */
export function resolvedSpecFromYarnLock(
  lockfile: string,
  packageName: string,
  version: string
): string | null {
  for (const block of lockfile.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
    const header = lines[0];
    if (!header || /^\s/.test(header)) {
      continue;
    }
    const names = header
      .replace(/:$/, '')
      .split(/,\s*/)
      .map((spec) => spec.replace(/^"|"$/g, ''))
      .map((spec) => spec.slice(0, spec.indexOf('@', 1)));
    const field = (key: string) =>
      lines
        .map((line) => new RegExp(`^\\s+${key}\\s+"?([^"\\s]+)"?$`).exec(line)?.[1])
        .find(Boolean);
    if (names.includes(packageName) && field('version') === version) {
      const resolved = field('resolved');
      return resolved ? resolved.replace(/#.*$/, '') : null;
    }
  }
  return null;
}

function parsePackFilename(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout.slice(stdout.indexOf('[')));
    const filename: unknown = parsed[0]?.filename;
    if (typeof filename === 'string') {
      // npm names a scoped tarball `scope-name-1.0.0.tgz`, and reports `@scope/name-1.0.0.tgz`.
      return filename.replace(/^@/, '').replace(/\//g, '-');
    }
  } catch {}
  throw new CommandError(
    'PATCH_TOOL_OUTPUT',
    `npm pack did not report the tarball it wrote, so there is no clean copy to compare the edits with.\nWhat it printed:\n${stdout.trim()}`
  );
}

/**
 * The patch, as patch-package writes it: a git diff whose paths start at `node_modules/<pkg>/`.
 *
 * `git diff --no-index` over two copies of only the edited files, so the header paths are the
 * copies' paths and are rewritten to the package's.
 */
async function unifiedDiffAsync(
  cleanDir: string,
  editedDir: string,
  diff: TreeDiff,
  packageName: string
): Promise<string> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-patch-diff-'));
  try {
    const a = path.join(work, 'a');
    const b = path.join(work, 'b');
    for (const file of [...diff.changed, ...diff.removed]) {
      copyInto(cleanDir, a, file);
    }
    for (const file of [...diff.changed, ...diff.added]) {
      copyInto(editedDir, b, file);
    }
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    const result = await spawnSubprocessAsync(
      requireTool('git'),
      [
        'diff',
        '--no-index',
        '--no-color',
        '--no-ext-diff',
        '--src-prefix=',
        '--dst-prefix=',
        'a',
        'b',
      ],
      { cwd: work, output: 'capture' }
    );
    // `git diff --no-index` exits 1 when the trees differ, which is the expected case.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw toolFailure('git', ['diff', '--no-index'], result);
    }
    const prefix = `node_modules/${packageName}/`;
    return result.stdout
      .replace(/^diff --git a\/(\S+) b\/(\S+)$/gm, `diff --git a/${prefix}$1 b/${prefix}$2`)
      .replace(/^--- a\//gm, `--- a/${prefix}`)
      .replace(/^\+\+\+ b\//gm, `+++ b/${prefix}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function copyInto(fromRoot: string, toRoot: string, file: string): void {
  const target = path.join(toRoot, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(fromRoot, file), target);
}

/** What `package.json` still needs for patch-package to apply the patches on install. */
export function patchPackageSetupChanges(root: string): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const changes: string[] = [];
  const postinstall: unknown = pkg.scripts?.postinstall;
  if (typeof postinstall !== 'string' || !postinstall.includes(PATCH_PACKAGE_SCRIPT)) {
    changes.push(
      typeof postinstall === 'string' && postinstall
        ? `scripts.postinstall: "${postinstall}" → "${postinstall} && ${PATCH_PACKAGE_SCRIPT}"`
        : `scripts.postinstall: "${PATCH_PACKAGE_SCRIPT}"`
    );
  }
  if (!pkg.devDependencies?.['patch-package'] && !pkg.dependencies?.['patch-package']) {
    changes.push(
      `devDependencies.patch-package: "${PATCH_PACKAGE_RANGE}" (install it before the next fresh install)`
    );
  }
  return changes;
}

function applyPatchPackageSetup(root: string): void {
  const file = path.join(root, 'package.json');
  const text = fs.readFileSync(file, 'utf8');
  const pkg = JSON.parse(text);
  const postinstall: unknown = pkg.scripts?.postinstall;
  if (typeof postinstall !== 'string' || !postinstall.includes(PATCH_PACKAGE_SCRIPT)) {
    pkg.scripts ??= {};
    pkg.scripts.postinstall =
      typeof postinstall === 'string' && postinstall
        ? `${postinstall} && ${PATCH_PACKAGE_SCRIPT}`
        : PATCH_PACKAGE_SCRIPT;
  }
  if (!pkg.devDependencies?.['patch-package'] && !pkg.dependencies?.['patch-package']) {
    pkg.devDependencies ??= {};
    pkg.devDependencies['patch-package'] = PATCH_PACKAGE_RANGE;
  }
  const indent = /^[ \t]+/m.exec(text)?.[0] ?? '  ';
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, indent)}\n`);
}

// ---- shared ----

/** The directories package managers write patch files to, relative to their root. */
const PATCH_DIRS = ['patches', path.join('.yarn', 'patches')];

type Snapshot = Map<string, string>;

function snapshotPatchDirs(root: string): Snapshot {
  const snapshot: Snapshot = new Map();
  for (const dir of PATCH_DIRS) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) {
      continue;
    }
    for (const name of fs.readdirSync(full)) {
      const file = path.join(full, name);
      const stat = fs.statSync(file);
      if (stat.isFile()) {
        snapshot.set(file, `${stat.size}:${stat.mtimeMs}`);
      }
    }
  }
  return snapshot;
}

/** The patch file the package manager just wrote or rewrote. */
function findWrittenPatch(root: string, before: Snapshot): string {
  const after = snapshotPatchDirs(root);
  for (const [file, stamp] of after) {
    if (before.get(file) !== stamp) {
      return file;
    }
  }
  throw new CommandError(
    'PATCH_NOT_WRITTEN',
    `The package manager reported success, but no patch file appeared in ${PATCH_DIRS.join(
      ' or '
    )}.`
  );
}

/** The files a git-style patch changes, relative to the package root. */
export function filesOfPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const match of patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) {
    files.add(match[2]!.replace(/^node_modules\/(?:@[^/]+\/)?[^/]+\//, ''));
  }
  return [...files].sort();
}

function filesOfDiff(diff: TreeDiff): string[] {
  return [...diff.changed, ...diff.added, ...diff.removed].sort();
}

function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}

function requireTool(name: string): string {
  const found = findExecutableOnPath(name);
  if (!found) {
    throw new CommandError(
      'PATCH_TOOL_MISSING',
      `${name} is not on PATH, and this project's patches are made with it.`
    );
  }
  return found;
}

async function runToolAsync(name: string, args: string[], cwd: string) {
  const result = await spawnSubprocessAsync(requireTool(name), args, { cwd, output: 'capture' });
  if (result.exitCode !== 0) {
    throw toolFailure(name, args, result);
  }
  return result;
}

function toolFailure(
  name: string,
  args: string[],
  result: { exitCode: number | null; stdout: string; stderr: string }
): CommandError {
  const error = new CommandError(
    'PATCH_TOOL_FAILED',
    [
      `"${name} ${args.join(' ')}" exited with ${result.exitCode}, so the patch was not saved.`,
      `${result.stderr}\n${result.stdout}`.trim(),
    ].join('\n')
  );
  error.data = { tool: name, exitCode: result.exitCode };
  return error;
}
