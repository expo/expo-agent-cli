// @ref llp/0037-patch-command.rfc.md §Package-manager backends
// Which package manager owns this project, read from the lockfile the project already has.
//
// The lockfile table and its precedence mirror `@expo/package-manager`'s `resolvePackageManager`
// [observed — `packages/@expo/package-manager/src/utils/nodeManagers.ts`]. It is a copy of a
// *decision*, not an import: the process boundary of llp/0001 rules out reaching into that package.
// The deferred `doctor:fix` keeps its own copy (`src/deferred/doctor-fix/packageManager.ts`), because
// deferred code is reference material and imports nothing live.
//
// One addition over that table: yarn is split in two. Yarn classic and yarn berry write the same
// `yarn.lock` name and have nothing else in common where patches are concerned — berry has a patch
// protocol of its own, classic has none.

import fs from 'fs';
import path from 'path';

export type PackageManagerName = 'bun' | 'pnpm' | 'yarn-berry' | 'yarn-classic' | 'npm';

export interface DetectedPackageManager {
  name: PackageManagerName;
  /** The lockfile that decided it, or null when the project has none (npm, the default). */
  lockfile: string | null;
  /** The directory the package manager runs in: the lockfile's, or the project root. */
  root: string;
}

/** Lockfile names per manager, in the order one directory is searched. */
const LOCKFILES: { name: 'bun' | 'yarn' | 'npm' | 'pnpm'; files: string[] }[] = [
  { name: 'bun', files: ['bun.lock', 'bun.lockb'] },
  { name: 'yarn', files: ['yarn.lock'] },
  { name: 'npm', files: ['package-lock.json'] },
  { name: 'pnpm', files: ['pnpm-lock.yaml'] },
];

/**
 * Find the package manager of a project.
 *
 * Walks up from the project, because a package of a monorepo has no lockfile of its own and the
 * workspace root's is the one that matters.
 */
export function detectPackageManager(projectRoot: string): DetectedPackageManager {
  let dir = path.resolve(projectRoot);
  for (;;) {
    const found = lockfileIn(dir);
    if (found) {
      return found;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return { name: 'npm', lockfile: null, root: path.resolve(projectRoot) };
    }
    dir = parent;
  }
}

/** The package manager whose lockfile is in this directory, if any. */
function lockfileIn(dir: string): DetectedPackageManager | null {
  for (const { name, files } of LOCKFILES) {
    const file = files.find((candidate) => fs.existsSync(path.join(dir, candidate)));
    if (!file) {
      continue;
    }
    const lockfile = path.join(dir, file);
    if (name === 'yarn') {
      return { name: isYarnBerry(dir) ? 'yarn-berry' : 'yarn-classic', lockfile, root: dir };
    }
    return { name, lockfile, root: dir };
  }
  return null;
}

/**
 * Whether the yarn of this directory is berry (2+).
 *
 * `.yarnrc.yml` is berry's config file and classic never reads it; a `packageManager` field naming
 * `yarn@2` or later says the same thing for a project that has not written one yet.
 */
export function isYarnBerry(dir: string): boolean {
  if (fs.existsSync(path.join(dir, '.yarnrc.yml'))) {
    return true;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const match = /^yarn@(\d+)/.exec(pkg.packageManager ?? '');
    return !!match && Number(match[1]) >= 2;
  } catch {
    return false;
  }
}
