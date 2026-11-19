// @ref llp/0037-patch-command.rfc.md §Package-manager backends
// One backend per package manager. Each takes the edits an agent already made in
// `node_modules/<pkg>` and saves them with that package manager's own patch feature, so the patch
// file, its name and its registration are the ones the package manager applies on the next install.
//
// Observed on macOS, 2026-11-17:
// - bun 1.4.4: `bun patch <pkg>` replaces `node_modules/<pkg>` with a clean copy (2026-11-18), so the
//   backend copies the edits aside first, as it does for pnpm. bun 1.3.14 crashes
//   (segmentation fault) on `bun patch --commit` for a package installed from a `file:` tarball,
//   also after `bun patch <pkg>`; for a registry package it works (2026-11-18).
// - pnpm 12.2.1: `pnpm patch-commit node_modules/<pkg>` refuses ("is not a valid patch directory"),
//   so the backend makes pnpm's own edit directory and copies the edits into it.
// - patch-package 8.0.1 cannot make a patch for a package it cannot download again (a `file:`
//   tarball): it reinstalls `<name>@<version>` from the registry. So the npm backend writes the patch
//   itself, in patch-package's format, and patch-package only applies it at `postinstall`.
// - yarn 4.18.1 follows pnpm's shape: `yarn patch <pkg> --json` reports an edit folder as a native
//   path (its text output colors the path, so it is not parsed), `yarn patch-commit -s`
//   saves it to `.yarn/patches/` and rewrites the dependency to a `patch:` spec.
// - yarn 1.22.22 has no patch feature, so it takes the npm path; its clean copy comes from the
//   `resolved` field of `yarn.lock`.
// - npm 12.2.3 has `npm patch add <pkg> --edit-dir` and `npm patch commit <dir>`, the same shape as
//   pnpm, and records `patchedDependencies` in package.json (2026-11-18). It refuses a package that is
//   not from the registry (EPATCHNONREGISTRY). npm 11 has no `patch` command.

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
      return (await hasNpmPatchAsync(target.packageManager.root)) &&
        !usesPatchPackage(target.packageManager.root)
        ? saveWithEditDirAsync(target, 'npm')
        : saveWithPatchPackageFormatAsync(target, options);
    case 'yarn-classic':
      return saveWithPatchPackageFormatAsync(target, options);
  }
}

// ---- bun ----

/**
 * `bun patch --commit` records every difference between `node_modules/<pkg>` and bun's cache, so it
 * runs on a clean copy that holds only the agent's edits: the edited package is copied aside, `bun
 * patch <pkg>` replaces `node_modules/<pkg>` with a clean, unlinked copy (it also drops the edits,
 * observed with bun 1.4.4), and only the files that differ are copied back.
 */
async function saveWithBunAsync(target: PatchTarget): Promise<BackendResult> {
  const root = target.packageManager.root;
  const relative = toPosix(path.relative(root, target.packageDir));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-patch-'));
  try {
    const edited = path.join(scratch, 'edited');
    fs.cpSync(target.packageDir, edited, { recursive: true, dereference: false });
    await runBunAsync(['patch', relative], root);

    const diff = diffTrees(target.packageDir, edited);
    if (isEmptyDiff(diff)) {
      return { status: 'no-edits' };
    }
    applyTreeDiff(diff, edited, target.packageDir);

    const before = snapshotPatchDirs(root);
    await runBunAsync(['patch', '--commit', relative], root);
    return { status: 'saved', patchFile: findWrittenPatch(root, before), files: filesOfDiff(diff) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function runBunAsync(args: string[], root: string) {
  return runToolAsync('bun', args, root).catch((error: unknown) => {
    throw bunCrashHint(error) ?? error;
  });
}

/** A clearer error when bun itself crashed, which is a bun bug and not a problem with the edits. */
function bunCrashHint(error: unknown): CommandError | null {
  if (!(error instanceof CommandError) || !/Bun has crashed/.test(error.message)) {
    return null;
  }
  const hint = new CommandError(
    'PATCH_TOOL_FAILED',
    [
      'bun crashed in "bun patch --commit", so the patch was not saved. This is a bug in bun, not in your edits.',
      'bun 1.3.14 crashes like this for a package installed from a file: tarball; bun 1.4.4 does not.',
      'How: upgrade bun ("bun upgrade"), then run this again.',
      '',
      error.message,
    ].join('\n')
  );
  hint.data = error.data;
  return hint;
}

// ---- pnpm, yarn berry, npm 12 ----

/** npm 12 has `npm patch`; npm 11 answers `npm patch --help` with "Unknown command" and exit 1. */
async function hasNpmPatchAsync(root: string): Promise<boolean> {
  const result = await spawnSubprocessAsync(requireTool('npm'), ['patch', '--help'], {
    cwd: root,
    output: 'capture',
  });
  return result.exitCode === 0;
}

/**
 * The project already applies patches with patch-package. A second patch system would apply its
 * patches as well, so the project stays on patch-package.
 */
function usesPatchPackage(root: string): boolean {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return (
    String(pkg.scripts?.postinstall ?? '').includes(PATCH_PACKAGE_SCRIPT) ||
    !!pkg.devDependencies?.['patch-package'] ||
    !!pkg.dependencies?.['patch-package']
  );
}

async function saveWithEditDirAsync(
  target: PatchTarget,
  tool: 'pnpm' | 'yarn' | 'npm'
): Promise<BackendResult> {
  const root = target.packageManager.root;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-patch-'));
  try {
    let editDir: string;
    if (tool === 'pnpm' || tool === 'npm') {
      editDir = path.join(scratch, 'edit');
      await runToolAsync(
        tool,
        [
          'patch',
          ...(tool === 'npm' ? ['add'] : []),
          `${target.packageName}@${target.version}`,
          '--edit-dir',
          editDir,
        ],
        root
      );
    } else {
      const result = await runToolAsync('yarn', ['patch', target.packageName, '--json'], root);
      editDir = parseYarnEditDir(result.stdout);
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
    } else if (tool === 'npm') {
      await runToolAsync('npm', ['patch', 'commit', editDir], root);
    } else {
      await runToolAsync('yarn', ['patch-commit', '-s', editDir], root);
    }
    return { status: 'saved', patchFile: findWrittenPatch(root, before), files: filesOfDiff(diff) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** The folder in the JSON line of `yarn patch --json`: `{"locator": "…", "path": "/tmp/xfs-…/user"}`. */
export function parseYarnEditDir(stdout: string): string {
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.path === 'string') {
        return parsed.path;
      }
    } catch {}
  }
  throw new CommandError(
    'PATCH_TOOL_OUTPUT',
    `yarn patch did not report the folder to edit, so the patch cannot be saved.\nWhat it printed:\n${stdout.trim()}`
  );
}

// ---- npm, yarn classic: patch-package's format ----

/**
 * The `postinstall` that applies the patches, and the package that provides it. `--error-on-fail`
 * makes a patch that no longer applies fail the install, as patch-package already does on CI.
 */
export const PATCH_PACKAGE_SCRIPT = 'patch-package';
const PATCH_PACKAGE_COMMAND = 'patch-package --error-on-fail';
export const PATCH_PACKAGE_RANGE = '^8.0.0';
/**
 * yarn classic does not run the root `postinstall` after `yarn remove`, which replaces
 * `node_modules` and so drops the patches; patch-package's README asks for this package to run it.
 */
const POSTINSTALL_POSTINSTALL = 'postinstall-postinstall';
const POSTINSTALL_POSTINSTALL_RANGE = '^2.1.0';

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

    const setup = patchPackageSetup(root, target.packageManager.name);
    if (setup.length && !yes) {
      return {
        status: 'needs-consent',
        projectChanges: setup.map((change) => change.description),
        files,
      };
    }

    const patchText = await unifiedDiffAsync(cleanDir, target.packageDir, diff, target.packageName);
    const patchFile = path.join(
      root,
      'patches',
      patchPackageFileName(target.packageName, target.version)
    );
    fs.mkdirSync(path.dirname(patchFile), { recursive: true });
    fs.writeFileSync(patchFile, patchText);
    applyPackageJsonChanges(root, setup);
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
 * The `resolved` of a yarn classic lockfile entry for `<name>` at `<version>`.
 *
 * The `#…` fragment of a registry tarball URL is its sha1 and goes. The fragment of a git URL is
 * the commit that was installed, and stays: without it `npm pack` clones the default branch.
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
      if (!resolved) {
        return null;
      }
      return isGitSpec(resolved) ? resolved : resolved.replace(/#.*$/, '');
    }
  }
  return null;
}

function isGitSpec(spec: string): boolean {
  return /^(?:git\+|git:\/\/|ssh:\/\/|github:)/.test(spec) || /\.git(?:#|$)/.test(spec);
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
 * copies' paths and are rewritten to the package's. The user's git config does not change the bytes:
 * with `core.autocrlf=true` (the Windows default) a CRLF file would diff to LF context that no longer
 * applies. patch-package cannot apply a binary change, so one is refused, and the patch is checked
 * against the clean copy before it is saved.
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
    const git = requireTool('git');
    const noConfig = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'];
    const result = await spawnSubprocessAsync(
      git,
      [
        ...noConfig,
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
    // `Binary files a/x and b/x differ`, with /dev/null for an added or removed file.
    const binary = [
      ...result.stdout.matchAll(
        /^Binary files (?:a\/(\S+)|\/dev\/null) and (?:b\/(\S+)|\/dev\/null) differ$/gm
      ),
    ];
    if (binary.length) {
      throw new CommandError(
        'PATCH_BINARY',
        `patch-package cannot apply a change to a binary file, so the patch was not saved: ${binary
          .map((match) => match[1] ?? match[2])
          .join(', ')}.\nHow: undo the change to the binary file, or patch it another way.`
      );
    }
    // Apply the patch to the clean copy, as the next install will.
    const patchFile = path.join(work, 'check.patch');
    fs.writeFileSync(patchFile, result.stdout);
    const check = result.stdout.trim()
      ? await spawnSubprocessAsync(git, [...noConfig, 'apply', '--check', '-p1', patchFile], {
          cwd: a,
          output: 'capture',
        })
      : null;
    if (!check || check.exitCode !== 0) {
      const error = new CommandError(
        'PATCH_NOT_APPLICABLE',
        [
          `The patch that was made from the edits does not apply to a clean copy of the package, so it was not saved.`,
          check ? `${check.stderr}\n${check.stdout}`.trim() : 'The patch is empty.',
        ].join('\n')
      );
      throw error;
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

interface PackageJsonChange {
  /** What a person reads in the plan. */
  description: string;
  apply: (pkg: Record<string, any>) => void;
}

/**
 * What `package.json` still needs for patch-package to apply the patches on install. An existing
 * `postinstall` is kept, and patch-package runs after it.
 */
function patchPackageSetup(
  root: string,
  manager: DetectedPackageManager['name']
): PackageJsonChange[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const changes: PackageJsonChange[] = [];
  const postinstall: unknown = pkg.scripts?.postinstall;
  if (typeof postinstall !== 'string' || !postinstall.includes(PATCH_PACKAGE_SCRIPT)) {
    const script =
      typeof postinstall === 'string' && postinstall
        ? `${postinstall} && ${PATCH_PACKAGE_COMMAND}`
        : PATCH_PACKAGE_COMMAND;
    changes.push({
      description:
        typeof postinstall === 'string' && postinstall
          ? `scripts.postinstall: "${postinstall}" → "${script}"`
          : `scripts.postinstall: "${script}"`,
      apply: (json) => {
        json.scripts ??= {};
        json.scripts.postinstall = script;
      },
    });
  }
  const devDependencies: [string, string][] = [[PATCH_PACKAGE_SCRIPT, PATCH_PACKAGE_RANGE]];
  if (manager === 'yarn-classic') {
    devDependencies.push([POSTINSTALL_POSTINSTALL, POSTINSTALL_POSTINSTALL_RANGE]);
  }
  for (const [name, range] of devDependencies) {
    if (!pkg.devDependencies?.[name] && !pkg.dependencies?.[name]) {
      changes.push({
        description: `devDependencies.${name}: "${range}" (install it before the next fresh install)`,
        apply: (json) => {
          json.devDependencies ??= {};
          json.devDependencies[name] = range;
        },
      });
    }
  }
  return changes;
}

function applyPackageJsonChanges(root: string, changes: PackageJsonChange[]): void {
  if (!changes.length) {
    return;
  }
  const file = path.join(root, 'package.json');
  const text = fs.readFileSync(file, 'utf8');
  const pkg = JSON.parse(text);
  for (const change of changes) {
    change.apply(pkg);
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
