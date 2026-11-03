// The lockfile that governs a project, and the command that installs exactly what it records.

import fs from 'fs';
import path from 'path';

import { fileExistsSync } from './dir';

export type PackageManager = 'bun' | 'yarn' | 'npm' | 'pnpm';

/**
 * Lockfile names per manager, in the order one directory is searched.
 *
 * A copy of a *decision*, not an import: the same table `@expo/package-manager`'s
 * `resolvePackageManager` uses [observed — `packages/@expo/package-manager/src/utils/nodeManagers.ts`],
 * which `src/deferred/doctor-fix/packageManager.ts` also mirrors. That module is the v1 narrowing's
 * reference shelf and is imported by nothing (llp/0016 §Deferred is a place), so the four names are
 * spelled again here rather than reached for across that line.
 *
 * The whole table and not just bun's two entries, because the *precedence* is the answer: a project
 * with both `bun.lock` and `package-lock.json` in one directory installs with bun, and a walk that
 * only looked for bun's would keep climbing past an npm project into whatever a parent directory has.
 */
const LOCKFILES: { manager: PackageManager; files: string[] }[] = [
  { manager: 'bun', files: ['bun.lock', 'bun.lockb'] },
  { manager: 'yarn', files: ['yarn.lock'] },
  { manager: 'npm', files: ['package-lock.json'] },
  { manager: 'pnpm', files: ['pnpm-lock.yaml'] },
];

export interface Lockfile {
  manager: PackageManager;
  /** The lockfile's name, e.g. `bun.lock`. */
  file: string;
  /** The directory it is in: the project, or a workspace root above it. */
  dir: string;
}

/**
 * The lockfile that governs this project.
 *
 * Walks up, because a package of a monorepo has no lockfile of its own and the workspace root's is
 * the one that installed it. The first directory holding *any* known lockfile decides.
 */
export function findLockfile(projectRoot: string): Lockfile | null {
  let dir = path.resolve(projectRoot);
  // Bounded by the filesystem root: `path.dirname('/')` is `'/'`, which ends the walk.
  for (;;) {
    for (const { manager, files } of LOCKFILES) {
      for (const file of files) {
        if (fileExistsSync(path.join(dir, file))) {
          return { manager, file, dir };
        }
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** A command to spawn, in the directory it must run in. */
export interface DependencyInstall {
  command: string;
  args: string[];
  cwd: string;
  /** The lockfile it installs, or null for a project with none. */
  lockfile: string | null;
}

// Yarn's install is not frozen: Yarn 1 spells it `--frozen-lockfile` and Berry `--immutable`.
const FROZEN_INSTALL: Record<PackageManager, Pick<DependencyInstall, 'command' | 'args'>> = {
  bun: { command: 'bun', args: ['install', '--frozen-lockfile'] },
  pnpm: { command: 'pnpm', args: ['install', '--frozen-lockfile'] },
  yarn: { command: 'yarn', args: ['install'] },
  npm: { command: 'npm', args: ['ci'] },
};

/**
 * What installs this project's dependencies exactly as its lockfile records them. A project with no
 * lockfile gets `npm install`, because `npm ci` refuses to run without one.
 *
 * A lockfile above the project counts only at a workspace root. {@link findLockfile} takes the
 * nearest one, which is right for choosing a runner and wrong for an install: `npm ci` in an
 * unrelated parent deletes that directory's node_modules and installs nothing here.
 */
export function lockfileInstall(projectRoot: string): DependencyInstall {
  const root = path.resolve(projectRoot);
  const nearest = findLockfile(root);
  const found = nearest && (nearest.dir === root || isWorkspaceRoot(nearest.dir)) ? nearest : null;
  return found
    ? { ...FROZEN_INSTALL[found.manager], cwd: found.dir, lockfile: found.file }
    : { command: 'npm', args: ['install'], cwd: root, lockfile: null };
}

/** A `package.json` with `workspaces` (npm, yarn, bun) or a `pnpm-workspace.yaml` marks one. */
function isWorkspaceRoot(dir: string): boolean {
  if (fileExistsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    return true;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return manifest?.workspaces != null;
  } catch {
    return false;
  }
}
