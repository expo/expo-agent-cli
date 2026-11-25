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
    } else if (!sameEntry(path.join(cleanRoot, file), path.join(editedRoot, file))) {
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

/**
 * Whether two entries hold the same thing. A symlink is compared by where it points, and never
 * read through: a link to a directory cannot be read as a file.
 */
function sameEntry(a: string, b: string): boolean {
  const linkA = fs.lstatSync(a).isSymbolicLink();
  const linkB = fs.lstatSync(b).isSymbolicLink();
  if (linkA || linkB) {
    return linkA && linkB && fs.readlinkSync(a) === fs.readlinkSync(b);
  }
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

export function isEmptyDiff(diff: TreeDiff): boolean {
  return !diff.changed.length && !diff.added.length && !diff.removed.length;
}

export function filesOfDiff(diff: TreeDiff): string[] {
  return [...diff.changed, ...diff.added, ...diff.removed].sort();
}

/** Files of the diff that are a symlink in the clean or the edited tree. */
export function symlinksOf(diff: TreeDiff, cleanRoot: string, editedRoot: string): string[] {
  const isLink = (root: string, file: string) =>
    fs.lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
  return filesOfDiff(diff).filter((file) => isLink(cleanRoot, file) || isLink(editedRoot, file));
}

/** Make `targetRoot` hold the edits of `diff`, copied from `editedRoot`. */
export function applyTreeDiff(diff: TreeDiff, editedRoot: string, targetRoot: string): void {
  for (const file of [...diff.changed, ...diff.added]) {
    copyEntry(path.join(editedRoot, file), path.join(targetRoot, file));
  }
  for (const file of diff.removed) {
    fs.rmSync(path.join(targetRoot, file), { force: true });
  }
}

/** Copy one file, or one symlink as a symlink. */
export function copyEntry(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { force: true });
  if (fs.lstatSync(from).isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(from), to);
  } else {
    fs.copyFileSync(from, to);
  }
}

/** Copy a whole directory, nested `node_modules` included, with symlinks kept as symlinks. */
export function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(source, target);
    } else {
      copyEntry(source, target);
    }
  }
}

/** Replace `dir` with the copy in `backup`. `dir` may be a symlink; it becomes a directory. */
export function restoreTree(backup: string, dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  copyTree(backup, dir);
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
