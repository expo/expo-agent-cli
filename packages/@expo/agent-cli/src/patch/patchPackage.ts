// @ref llp/0037-patch-command.rfc.md §Package-manager backends
// The patch-package path, for npm without `npm patch` (or refused by it) and yarn classic. The CLI
// writes the patch in patch-package's format from a clean copy, and patch-package only applies it
// at `postinstall`.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { readJsonFileSync } from '../project/nodeModules';
import { CommandError } from '../utils/errors';
import { toPosixPath } from '../utils/filePath';
import type { BackendOptions, BackendResult, PatchTarget } from './backends';
import type { PackageManagerName } from './packageManager';
import type { PackageJsonEdit } from './packageJson';
import { patchPackageFileName } from './registry';
import { runToolAsync, toolOutput, type ToolResult } from './tools';
import { copyEntry, diffTrees, filesOfDiff, isEmptyDiff, symlinksOf, type TreeDiff } from './tree';

/**
 * The `postinstall` that applies the patches, and the package that provides it. `--error-on-fail`
 * makes a patch that no longer applies fail the install, as patch-package already does on CI.
 */
const PATCH_PACKAGE_SCRIPT = 'patch-package';
const PATCH_PACKAGE_COMMAND = 'patch-package --error-on-fail';
const PATCH_PACKAGE_RANGE = '^8.0.0';
/**
 * yarn classic does not run the root `postinstall` after `yarn remove`, which replaces
 * `node_modules` and so drops the patches; patch-package's README asks for this package to run it.
 */
const POSTINSTALL_POSTINSTALL = 'postinstall-postinstall';
const POSTINSTALL_POSTINSTALL_RANGE = '^2.1.0';

/** What `package.json` at the workspace root still needs for patch-package to apply the patch. */
export interface PatchPackageSetup {
  root: string;
  manager: PackageManagerName;
  edits: PackageJsonEdit[];
  /** A dev dependency is added, so the lockfile has to be updated after `package.json`. */
  updatesLockfile: boolean;
}

interface PackageJsonChange {
  /** What a person reads in the plan. */
  description: string;
  dependency?: boolean;
  edit: PackageJsonEdit;
}

/**
 * The project already applies patches with patch-package. A second patch system would apply its
 * patches as well, so the project stays on patch-package.
 */
export function usesPatchPackage(root: string): boolean {
  const pkg = readJsonFileSync<Record<string, any>>(path.join(root, 'package.json'));
  return (
    String(pkg?.scripts?.postinstall ?? '').includes(PATCH_PACKAGE_SCRIPT) ||
    !!pkg?.devDependencies?.['patch-package'] ||
    !!pkg?.dependencies?.['patch-package']
  );
}

/**
 * Write the patch file. The `package.json` changes come back in `setup`, for the caller to write
 * together with its own, and then to update the lockfile (`updateLockfileAsync`).
 */
export async function saveWithPatchPackageFormatAsync(
  target: PatchTarget,
  { yes }: BackendOptions,
  /** Why patch-package, after the package manager's name: "<manager> <reason>". */
  reason: string
): Promise<BackendResult> {
  const root = target.packageManager.root;
  assertTopLevelCopy(target);
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

    const changes = patchPackageChanges(root, target.packageManager.name);
    if (changes.length && !yes) {
      return {
        status: 'needs-consent',
        reason: `${target.packageManager.name} ${reason}`,
        projectChanges: changes.map((change) => change.description),
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
    return {
      status: 'saved',
      patchFile,
      files,
      setup: {
        root,
        manager: target.packageManager.name,
        edits: changes.map((change) => change.edit),
        updatesLockfile: changes.some((change) => change.dependency),
      },
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * patch-package applies `patches/<name>+<version>.patch` to `<root>/node_modules/<name>`, whatever
 * version is there. A workspace package can have its own, nested copy at another version, and the
 * patch would then go to the root's copy.
 */
function assertTopLevelCopy(target: PatchTarget): void {
  const topLevel = path.join(
    target.packageManager.root,
    'node_modules',
    ...target.packageName.split('/')
  );
  const real = (dir: string) => (fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir));
  if (real(target.packageDir) !== real(topLevel)) {
    const error = new CommandError(
      'PATCH_NESTED_COPY',
      [
        `${target.packageName}@${target.version} is a nested copy in ${target.packageDir}, and patch-package applies a patch only to ${topLevel}. So the patch was not saved.`,
        `How: make the workspace use one version of ${target.packageName}, so the copy at the root is the one that is used, then edit that copy and run this again.`,
      ].join('\n')
    );
    error.data = { packageDir: target.packageDir, topLevel };
    throw error;
  }
}

/** The command that adds the new devDependencies to the lockfile, and the lockfile. */
const LOCKFILE_UPDATE: Record<
  'npm' | 'yarn-classic',
  { tool: string; lockfile: string; args: string[] }
> = {
  npm: {
    tool: 'npm',
    lockfile: 'package-lock.json',
    args: ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
  },
  // yarn 1 has no lockfile-only install. Its `postinstall` applies the patches again.
  'yarn-classic': { tool: 'yarn', lockfile: 'yarn.lock', args: ['install', '--non-interactive'] },
};

/** Add patch-package to the lockfile, so a frozen install (`npm ci`, CI, EAS Build) still works. */
export async function updateLockfileAsync(
  { root, manager }: PatchPackageSetup,
  patchFile: string
): Promise<void> {
  if (manager !== 'npm' && manager !== 'yarn-classic') {
    return;
  }
  const { tool, lockfile, args } = LOCKFILE_UPDATE[manager];
  if (!fs.existsSync(path.join(root, lockfile))) {
    return;
  }
  const result = await runToolAsync(tool, args, { cwd: root, allowFailure: true });
  if (result.exitCode !== 0) {
    const command = `${tool} ${args.join(' ')}`;
    const error = new CommandError(
      'PATCH_LOCKFILE_FAILED',
      [
        `The patch was saved to ${patchFile} and package.json was updated, but "${command}" exited with ${result.exitCode}, so ${lockfile} does not list patch-package yet, and a frozen install fails.`,
        toolOutput(result),
        `How: fix the error, then run "${command}" in ${root}.`,
      ].join('\n')
    );
    error.data = { patchFile, exitCode: result.exitCode };
    throw error;
  }
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
    { cwd: root }
  );
  const tarball = path.join(scratch, parsePackFilename(result.stdout));
  const unpacked = path.join(scratch, 'clean');
  fs.mkdirSync(unpacked);
  await runToolAsync('tar', ['-xzf', tarball, '-C', unpacked], { cwd: scratch });
  return path.join(unpacked, 'package');
}

function resolvedSpecFromNpmLock(root: string, packageDir: string): string | null {
  const lock = readJsonFileSync<{ packages?: Record<string, { resolved?: unknown }> }>(
    path.join(root, 'package-lock.json')
  );
  const resolved = lock?.packages?.[toPosixPath(path.relative(root, packageDir))]?.resolved;
  // A `file:` spec in the lockfile is relative to the lockfile's directory, which is the cwd.
  return typeof resolved === 'string' ? resolved : null;
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
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-patch-diff-'));
  try {
    const work = path.join(scratch, 'repo');
    const packageRoot = path.join(work, 'node_modules', ...packageName.split('/'));
    const env = scratchGitEnv(scratch, work);
    const config = [
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.safecrlf=false',
      '-c',
      'core.quotepath=false',
    ];
    const gitAsync = (args: string[], allowFailure = false): Promise<ToolResult> =>
      runToolAsync('git', [...config, ...args], { cwd: work, env, allowFailure });
    const writeTreeAsync = async () => {
      // `--force`: a `.gitignore` in the package must not drop an edit.
      await gitAsync(['add', '--all', '--force']);
      return (await gitAsync(['write-tree'])).stdout.trim();
    };

    fs.mkdirSync(work);
    await gitAsync(['init', '--quiet']);
    for (const file of [...diff.changed, ...diff.removed]) {
      copyEntry(path.join(cleanDir, file), path.join(packageRoot, file));
    }
    const cleanTree = await writeTreeAsync();

    for (const file of diff.removed) {
      fs.rmSync(path.join(packageRoot, file), { force: true });
    }
    for (const file of [...diff.changed, ...diff.added]) {
      copyEntry(path.join(editedDir, file), path.join(packageRoot, file));
    }
    const editedTree = await writeTreeAsync();

    const diffArgs = ['diff', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv'];
    // `--numstat` marks a binary file with `-` for both counts.
    const binary = (await gitAsync([...diffArgs, '--numstat', '-z', cleanTree, editedTree])).stdout
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
    const patchText = (
      await gitAsync([...diffArgs, '--src-prefix=a/', '--dst-prefix=b/', cleanTree, editedTree])
    ).stdout;

    // Apply the saved bytes to the clean tree, as the next install will.
    const patchFile = path.join(scratch, 'check.patch');
    fs.writeFileSync(patchFile, patchText);
    await gitAsync(['read-tree', cleanTree]);
    const checkArgs = ['apply', '--check', '--cached', patchFile];
    const check = patchText.trim() ? await gitAsync(checkArgs, true) : null;
    if (!check || check.exitCode !== 0) {
      throw new CommandError(
        'PATCH_NOT_APPLICABLE',
        [
          `The patch that was made from the edits does not apply to a clean copy of the package, so it was not saved.`,
          check ? toolOutput(check) : 'The patch is empty.',
        ].join('\n')
      );
    }
    return patchText;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The env of the scratch git repository: its own directory, index and objects, and no config of
 * the user's. The child env is merged over process.env, so each variable that could point git
 * elsewhere is set here, not removed. `XDG_CONFIG_HOME` hides the user's `git/ignore` and
 * `git/attributes`, which git reads with no config entry.
 */
function scratchGitEnv(scratch: string, work: string): NodeJS.ProcessEnv {
  const home = path.join(scratch, 'home');
  fs.mkdirSync(home);
  const emptyConfig = path.join(home, 'gitconfig');
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
    XDG_CONFIG_HOME: home,
  };
}

/**
 * The changes `package.json` still needs for patch-package to apply the patches on install. An
 * existing `postinstall` is kept, and patch-package runs after it.
 */
function patchPackageChanges(root: string, manager: PackageManagerName): PackageJsonChange[] {
  const pkg = readJsonFileSync<Record<string, any>>(path.join(root, 'package.json')) ?? {};
  const changes: PackageJsonChange[] = [];
  const postinstall: unknown = pkg.scripts?.postinstall;
  if (typeof postinstall !== 'string' || !postinstall.includes(PATCH_PACKAGE_SCRIPT)) {
    const existing = typeof postinstall === 'string' && postinstall ? postinstall : null;
    const script = existing ? `${existing} && ${PATCH_PACKAGE_COMMAND}` : PATCH_PACKAGE_COMMAND;
    changes.push({
      description: existing
        ? `scripts.postinstall: "${existing}" → "${script}"`
        : `scripts.postinstall: "${script}"`,
      edit: (json) => {
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
        description: `devDependencies.${name}: "${range}", and the lockfile is updated to match`,
        dependency: true,
        edit: (json) => {
          json.devDependencies ??= {};
          json.devDependencies[name] = range;
        },
      });
    }
  }
  return changes;
}
