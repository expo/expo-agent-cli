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
import * as Log from '../log';
import { CommandError } from '../utils/errors';
import { findExecutableOnPath } from '../utils/pathLookup';
import { spawnSubprocessAsync } from '../utils/subprocess';
import {
  applyTreeDiff,
  copyTree,
  diffTrees,
  isEmptyDiff,
  restoreTree,
  type TreeDiff,
} from './tree';

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
      /** Why the patch is saved with patch-package. */
      reason: string;
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
      if (
        (await hasNpmPatchAsync(target.packageManager.root)) &&
        !usesPatchPackage(target.packageManager.root)
      ) {
        try {
          return await saveWithEditDirAsync(target, 'npm');
        } catch (error) {
          if (!isNpmNonRegistryError(error)) {
            throw error;
          }
          return saveWithPatchPackageFormatAsync(target, options, NPM_NON_REGISTRY_REASON);
        }
      }
      return saveWithPatchPackageFormatAsync(target, options, NO_PATCH_COMMAND_REASON);
    case 'yarn-classic':
      return saveWithPatchPackageFormatAsync(target, options, NO_PATCH_COMMAND_REASON);
  }
}

// ---- bun ----

/**
 * `bun patch --commit` records every difference between `node_modules/<pkg>` and bun's cache, so it
 * runs on a clean copy that holds only the agent's edits: the edited package is copied aside, `bun
 * patch <pkg>` replaces `node_modules/<pkg>` with a clean, unlinked copy (it also drops the edits,
 * observed with bun 1.4.4), and only the files that differ are copied back.
 *
 * After `bun patch <pkg>`, the copy aside is the only copy of the edits. So any failure puts it
 * back before the copy is deleted.
 */
async function saveWithBunAsync(target: PatchTarget): Promise<BackendResult> {
  const root = target.packageManager.root;
  const relative = toPosix(path.relative(root, target.packageDir));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-patch-'));
  try {
    const edited = path.join(scratch, 'edited');
    // The real directory: a copy of a symlinked `node_modules/<pkg>` would be one more link to it.
    copyTree(fs.realpathSync(target.packageDir), edited);
    try {
      await runBunAsync(['patch', relative], root);

      const diff = diffTrees(target.packageDir, edited);
      if (isEmptyDiff(diff)) {
        return { status: 'no-edits' };
      }
      applyTreeDiff(diff, edited, target.packageDir);

      const before = snapshotPatchDirs(root);
      await runBunAsync(['patch', '--commit', relative], root);
      return {
        status: 'saved',
        patchFile: findWrittenPatch(root, before),
        files: filesOfDiff(diff),
      };
    } catch (error) {
      restoreTree(edited, target.packageDir);
      throw error;
    }
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
 * npm 12.2.3 refuses `npm patch add` for a `file:` or git dependency with this code (observed
 * 2026-11-18). patch-package's format still works for those, because its clean copy comes from the
 * lockfile.
 */
function isNpmNonRegistryError(error: unknown): boolean {
  return error instanceof CommandError && /EPATCHNONREGISTRY/.test(error.message);
}

const NO_PATCH_COMMAND_REASON = 'has no patch command of its own';
const NPM_NON_REGISTRY_REASON =
  'patch refuses a package that is not from the npm registry (EPATCHNONREGISTRY)';

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
    if (tool === 'npm') {
      dropNpmUnpatchable(diff, editDir, target.packageDir);
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
  { yes }: BackendOptions,
  /** Why patch-package, after the package manager's name: "<manager> <reason>". */
  reason: string
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
    const links = symlinksOf(diff, cleanDir, target.packageDir);
    if (links.length) {
      // patch-package 8.0.1 fails on a mode 120000 patch ("Patch file parse error", observed).
      throw new CommandError(
        'PATCH_SYMLINK',
        `patch-package cannot apply a change to a symlink, so the patch was not saved: ${links.join(
          ', '
        )}.\nHow: undo the change to the symlink, or patch it another way.`
      );
    }

    const setup = patchPackageSetup(root, target.packageManager.name);
    if (setup.length && !yes) {
      return {
        status: 'needs-consent',
        reason: `${target.packageManager.name} ${reason}`,
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
    // npm 11 prints an array; npm 12.2.3 prints an object keyed by package name.
    const start = stdout.search(/[[{]/);
    const parsed = JSON.parse(stdout.slice(start));
    const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
    const filename: unknown = (entry as { filename?: unknown } | undefined)?.filename;
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
 * Git writes it, in a scratch repository where the edited files sit at `node_modules/<pkg>/…`: one
 * tree from the clean copies, one from the edits, and `git diff` between them. So every header,
 * also of an added or a removed file, has the real path, and no line is rewritten afterwards.
 *
 * The user's git config is not read, because it can change the bytes: `core.autocrlf=true` (the
 * Windows default) turns CRLF context into LF that no longer applies, `diff.noprefix` drops `a/`,
 * and `core.quotepath` quotes a non-ASCII path. patch-package cannot apply a binary change, so one
 * is refused, and the exact patch is checked against the clean tree before it is saved.
 */
async function unifiedDiffAsync(
  cleanDir: string,
  editedDir: string,
  diff: TreeDiff,
  packageName: string
): Promise<string> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-patch-diff-'));
  try {
    const packageRoot = path.join(work, 'node_modules', ...packageName.split('/'));
    const env = scratchGitEnv(work);
    const config = [
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.safecrlf=false',
      '-c',
      'core.quotepath=false',
    ];
    const git = requireTool('git');
    const runGitAsync = async (args: string[]) => {
      const result = await spawnSubprocessAsync(git, [...config, ...args], {
        cwd: work,
        env,
        output: 'capture',
      });
      if (result.exitCode !== 0) {
        throw toolFailure('git', args, result);
      }
      return result.stdout;
    };

    await runGitAsync(['init', '--quiet']);
    for (const file of [...diff.changed, ...diff.removed]) {
      copyInto(cleanDir, packageRoot, file);
    }
    await runGitAsync(['add', '--all']);
    const cleanTree = (await runGitAsync(['write-tree'])).trim();

    for (const file of diff.removed) {
      fs.rmSync(path.join(packageRoot, file), { force: true });
    }
    for (const file of [...diff.changed, ...diff.added]) {
      copyInto(editedDir, packageRoot, file);
    }
    await runGitAsync(['add', '--all']);
    const editedTree = (await runGitAsync(['write-tree'])).trim();

    const diffArgs = ['diff', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv'];
    // `--numstat` marks a binary file with `-` for both counts.
    const binary = (await runGitAsync([...diffArgs, '--numstat', '-z', cleanTree, editedTree]))
      .split('\0')
      .filter((entry) => entry.startsWith('-\t-\t'))
      .map((entry) => entry.slice('-\t-\t'.length + `node_modules/${packageName}/`.length));
    if (binary.length) {
      throw new CommandError(
        'PATCH_BINARY',
        `patch-package cannot apply a change to a binary file, so the patch was not saved: ${binary.join(
          ', '
        )}.\nHow: undo the change to the binary file, or patch it another way.`
      );
    }
    const patchText = await runGitAsync([
      ...diffArgs,
      '--src-prefix=a/',
      '--dst-prefix=b/',
      cleanTree,
      editedTree,
    ]);

    // Apply the saved bytes to the clean tree, as the next install will.
    const patchFile = path.join(work, 'check.patch');
    fs.writeFileSync(patchFile, patchText);
    await runGitAsync(['read-tree', cleanTree]);
    const check = patchText.trim()
      ? await spawnSubprocessAsync(git, [...config, 'apply', '--check', '--cached', patchFile], {
          cwd: work,
          env,
          output: 'capture',
        })
      : null;
    if (!check || check.exitCode !== 0) {
      throw new CommandError(
        'PATCH_NOT_APPLICABLE',
        [
          `The patch that was made from the edits does not apply to a clean copy of the package, so it was not saved.`,
          check ? `${check.stderr}\n${check.stdout}`.trim() : 'The patch is empty.',
        ].join('\n')
      );
    }
    return patchText;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The env of the scratch git repository: its own directory, index and objects, and no config of
 * the user's. The child env is merged over process.env, so each GIT_ variable that could point git
 * elsewhere is set here, not removed.
 */
function scratchGitEnv(work: string): NodeJS.ProcessEnv {
  const emptyConfig = path.join(work, 'empty.gitconfig');
  fs.writeFileSync(emptyConfig, '');
  const gitDir = path.join(work, '.git');
  return {
    GIT_DIR: gitDir,
    GIT_WORK_TREE: work,
    GIT_INDEX_FILE: path.join(gitDir, 'index'),
    GIT_OBJECT_DIRECTORY: path.join(gitDir, 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_PARAMETERS: '',
  };
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
    // Nested: npm 12.2.3 writes a scoped patch to `patches/@scope/name@version.patch`.
    for (const name of fs.readdirSync(full, { recursive: true }) as string[]) {
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

/** Files of the diff that are a symlink in the clean or the edited tree. */
function symlinksOf(diff: TreeDiff, cleanDir: string, editedDir: string): string[] {
  const isLink = (dir: string, file: string) => {
    try {
      return fs.lstatSync(path.join(dir, file)).isSymbolicLink();
    } catch {
      return false;
    }
  };
  return filesOfDiff(diff).filter((file) => isLink(cleanDir, file) || isLink(editedDir, file));
}

/**
 * npm 12.2.3 cannot record three kinds of change, and still exits 0 (`lib/utils/patch-diff.js`):
 * the root `package.json`, because npm resolves the manifest from before the patch; anything that
 * is not a regular file, such as a symlink; and a file that is not UTF-8 text, because npm reads
 * both sides as UTF-8 and writes the decoded string back, which breaks a binary file. They are taken
 * out of the diff before anything is copied into the edit directory, so the report names only what
 * the patch holds; when nothing is left, the run fails and says why.
 */
function dropNpmUnpatchable(diff: TreeDiff, cleanDir: string, editedDir: string): void {
  const links = new Set(symlinksOf(diff, cleanDir, editedDir));
  const dropped = new Set([
    ...filesOfDiff(diff).filter((file) => file === 'package.json'),
    ...links,
    ...filesOfDiff(diff).filter(
      (file) => !links.has(file) && !(isUtf8Text(cleanDir, file) && isUtf8Text(editedDir, file))
    ),
  ]);
  if (!dropped.size) {
    return;
  }
  for (const key of ['changed', 'added', 'removed'] as const) {
    diff[key] = diff[key].filter((file) => !dropped.has(file));
  }
  const names = [...dropped].sort().join(', ');
  if (isEmptyDiff(diff)) {
    throw new CommandError(
      'PATCH_NOT_PATCHABLE',
      `npm patch does not record a change to the package's own package.json, to a symlink or to a file that is not UTF-8 text, and those are the only edits: ${names}. Nothing was saved.`
    );
  }
  Log.warn(`npm patch does not record these edits, so the patch leaves them out: ${names}.`);
}

/** A missing file counts as text: it is the other side of an added or a removed file. */
function isUtf8Text(dir: string, file: string): boolean {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) {
    return true;
  }
  const bytes = fs.readFileSync(full);
  if (bytes.includes(0)) {
    return false;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
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
