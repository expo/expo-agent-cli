// @ref llp/0037-patch-command.rfc.md §Package-manager backends

import fs from 'fs';
import os from 'os';
import path from 'path';

import * as Log from '../log';
import { CommandError } from '../utils/errors';
import { toPosixPath } from '../utils/filePath';
import type { DetectedPackageManager } from './packageManager';
import {
  saveWithPatchPackageFormatAsync,
  usesPatchPackage,
  type PatchPackageSetup,
} from './patchPackage';
import { findPatchFile } from './registry';
import { runToolAsync } from './tools';
import {
  applyTreeDiff,
  copyTree,
  diffTrees,
  filesOfDiff,
  isEmptyDiff,
  restoreTree,
  symlinksOf,
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
      /** patch-package only: the `package.json` changes still to write, then the lockfile. */
      setup?: PatchPackageSetup;
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
  /** The caller passed `--yes`. Only the patch-package path asks for it. */
  yes: boolean;
}

const NO_PATCH_COMMAND_REASON = 'has no patch command of its own';

export async function savePatchAsync(
  target: PatchTarget,
  options: BackendOptions
): Promise<BackendResult> {
  switch (target.packageManager.name) {
    case 'bun':
      return saveWithBunAsync(target);
    case 'pnpm':
      return saveWithEditDirAsync(target, PNPM);
    case 'yarn-berry':
      return saveWithEditDirAsync(target, YARN_BERRY);
    case 'npm':
      return saveWithNpmAsync(target, options);
    case 'yarn-classic':
      return saveWithPatchPackageFormatAsync(target, options, NO_PATCH_COMMAND_REASON);
  }
}

// ---- bun ----

/**
 * `bun patch --commit` records every difference between `node_modules/<pkg>` and bun's cache, so it
 * runs on a clean copy that holds only the agent's edits: the edited package is copied aside, `bun
 * patch <pkg>` replaces `node_modules/<pkg>` with a clean, unlinked copy, and only the files that
 * differ are copied back.
 *
 * After `bun patch <pkg>`, the copy aside is the only copy of the edits. So any failure puts it
 * back before the copy is deleted.
 */
async function saveWithBunAsync(target: PatchTarget): Promise<BackendResult> {
  const root = target.packageManager.root;
  const relative = toPosixPath(path.relative(root, target.packageDir));
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

      await runBunAsync(['patch', '--commit', relative], root);
      return { status: 'saved', patchFile: findSavedPatch(target), files: filesOfDiff(diff) };
    } catch (error) {
      restoreTree(edited, target.packageDir);
      throw error;
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function runBunAsync(args: string[], root: string) {
  return runToolAsync('bun', args, { cwd: root }).catch((error: unknown) => {
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

// ---- pnpm, yarn berry, npm 12: an edit directory ----

/** A package manager that makes a clean edit directory and commits a patch from it. */
interface EditDirBackend {
  /** Make the clean edit directory, and return it. */
  openAsync(target: PatchTarget, scratch: string): Promise<string>;
  /** Take out the edits the package manager would not record. */
  filter?(diff: TreeDiff, cleanDir: string, editedDir: string): void;
  commitAsync(editDir: string, root: string): Promise<unknown>;
}

const PNPM: EditDirBackend = {
  async openAsync(target, scratch) {
    const editDir = path.join(scratch, 'edit');
    const spec = `${target.packageName}@${target.version}`;
    await runToolAsync('pnpm', ['patch', spec, '--edit-dir', editDir], {
      cwd: target.packageManager.root,
    });
    return editDir;
  },
  commitAsync: (editDir, root) => runToolAsync('pnpm', ['patch-commit', editDir], { cwd: root }),
};

const YARN_BERRY: EditDirBackend = {
  async openAsync(target) {
    const result = await runToolAsync('yarn', ['patch', target.packageName, '--json'], {
      cwd: target.packageManager.root,
    });
    return parseYarnEditDir(result.stdout);
  },
  commitAsync: (editDir, root) =>
    runToolAsync('yarn', ['patch-commit', '-s', editDir], { cwd: root }),
};

const NPM: EditDirBackend = {
  async openAsync(target, scratch) {
    const editDir = path.join(scratch, 'edit');
    const spec = `${target.packageName}@${target.version}`;
    await runToolAsync('npm', ['patch', 'add', spec, '--edit-dir', editDir], {
      cwd: target.packageManager.root,
    });
    return editDir;
  },
  filter: dropNpmUnpatchable,
  commitAsync: (editDir, root) => runToolAsync('npm', ['patch', 'commit', editDir], { cwd: root }),
};

async function saveWithEditDirAsync(
  target: PatchTarget,
  backend: EditDirBackend
): Promise<BackendResult> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-patch-'));
  try {
    const editDir = await backend.openAsync(target, scratch);
    // The edit directory is a clean copy: comparing against it is what finds the agent's edits.
    const diff = diffTrees(editDir, target.packageDir);
    if (isEmptyDiff(diff)) {
      return { status: 'no-edits' };
    }
    backend.filter?.(diff, editDir, target.packageDir);
    applyTreeDiff(diff, target.packageDir, editDir);
    await backend.commitAsync(editDir, target.packageManager.root);
    return { status: 'saved', patchFile: findSavedPatch(target), files: filesOfDiff(diff) };
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

// ---- npm ----

const NPM_NON_REGISTRY_REASON =
  'patch refuses a package that is not from the npm registry (EPATCHNONREGISTRY)';

/**
 * npm 12 saves with `npm patch`, unless the project already uses patch-package. A package `npm
 * patch` refuses, and npm before 12, take the patch-package path.
 */
async function saveWithNpmAsync(
  target: PatchTarget,
  options: BackendOptions
): Promise<BackendResult> {
  const root = target.packageManager.root;
  if (!(await hasNpmPatchAsync(root)) || usesPatchPackage(root)) {
    return saveWithPatchPackageFormatAsync(target, options, NO_PATCH_COMMAND_REASON);
  }
  try {
    return await saveWithEditDirAsync(target, NPM);
  } catch (error) {
    if (!isNpmNonRegistryError(error)) {
      throw error;
    }
    return saveWithPatchPackageFormatAsync(target, options, NPM_NON_REGISTRY_REASON);
  }
}

/** npm 12 has `npm patch`; npm 11 answers `npm patch --help` with "Unknown command" and exit 1. */
async function hasNpmPatchAsync(root: string): Promise<boolean> {
  const result = await runToolAsync('npm', ['patch', '--help'], { cwd: root, allowFailure: true });
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

// ---- shared ----

/** The patch file the package manager just registered: the one the next install applies. */
function findSavedPatch(target: PatchTarget): string {
  try {
    return findPatchFile(
      target.packageManager.root,
      target.packageName,
      target.version,
      target.projectRoot
    );
  } catch (error) {
    if (error instanceof CommandError && error.code === 'PATCH_NOT_FOUND') {
      throw new CommandError(
        'PATCH_NOT_WRITTEN',
        `The package manager reported success, but registered no patch file for ${target.packageName}@${target.version}.`
      );
    }
    throw error;
  }
}
