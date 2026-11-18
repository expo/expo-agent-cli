// @ref llp/0037-patch-command.rfc.md §Package-manager backends
// File-tree helpers for one installed package: which files an agent edited, and whether the
// package's files are shared with a package manager's global store.

import fs from 'fs';
import path from 'path';

/** Files of a package, relative to its root, with `/` separators. Nested `node_modules` is skipped. */
export function listPackageFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' && prefix === '') {
        continue;
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, relative);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relative);
      }
    }
  };
  walk(root, '');
  return files.sort();
}

export interface TreeDiff {
  /** In both trees, with different bytes. */
  changed: string[];
  /** Only in the edited tree. */
  added: string[];
  /** Only in the clean tree. */
  removed: string[];
}

/** Compare a clean copy of a package with the edited one, file by file. */
export function diffTrees(cleanRoot: string, editedRoot: string): TreeDiff {
  const clean = new Set(listPackageFiles(cleanRoot));
  const edited = new Set(listPackageFiles(editedRoot));
  const diff: TreeDiff = { changed: [], added: [], removed: [] };
  for (const file of edited) {
    if (!clean.has(file)) {
      diff.added.push(file);
    } else if (
      !fs
        .readFileSync(path.join(cleanRoot, file))
        .equals(fs.readFileSync(path.join(editedRoot, file)))
    ) {
      diff.changed.push(file);
    }
  }
  for (const file of clean) {
    if (!edited.has(file)) {
      diff.removed.push(file);
    }
  }
  return diff;
}

export function isEmptyDiff(diff: TreeDiff): boolean {
  return !diff.changed.length && !diff.added.length && !diff.removed.length;
}

/** Make `targetRoot` hold the edits of `diff`, copied from `editedRoot`. */
export function applyTreeDiff(diff: TreeDiff, editedRoot: string, targetRoot: string): void {
  for (const file of [...diff.changed, ...diff.added]) {
    const target = path.join(targetRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(editedRoot, file), target);
  }
  for (const file of diff.removed) {
    fs.rmSync(path.join(targetRoot, file), { force: true });
  }
}

/**
 * Files of a package that are hard links, i.e. that share their bytes with another path.
 *
 * A package manager that installs by hard link (pnpm and bun on Linux by default) shares each file
 * with its global store, so an edit in place has already changed the store, and the clean copy the
 * patch is computed against is no longer clean. Nothing can be saved correctly from that state.
 */
export function findLinkedFiles(root: string): string[] {
  return listPackageFiles(root).filter((file) => {
    try {
      return fs.lstatSync(path.join(root, file)).nlink > 1;
    } catch {
      return false;
    }
  });
}
