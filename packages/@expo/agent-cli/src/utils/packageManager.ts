// @ref llp/0037-patch-command.rfc.md §Package-manager backends
// Which package manager owns this project. `@expo/package-manager` decides it, from the lockfile at
// the workspace root, as it does for `install` (`src/install/bareInstall.ts`).
//
// One addition over its answer: yarn is split in two. Yarn classic and yarn berry write the same
// `yarn.lock` name and have nothing else in common where patches are concerned — berry has a patch
// protocol of its own, classic has none.

import { resolvePackageManager, resolveWorkspaceRoot } from '@expo/package-manager';
import fs from 'fs';
import path from 'path';

import { CommandError } from './errors';

export type PackageManagerName = 'bun' | 'pnpm' | 'yarn-berry' | 'yarn-classic' | 'npm';

export interface DetectedPackageManager {
  name: PackageManagerName;
  /** The directory the package manager runs in: the workspace root, or the project root. */
  root: string;
}

/**
 * Find the package manager of a project. A project with no lockfile is npm's, as
 * `@expo/package-manager`'s `createForProject` falls back to npm.
 */
export function detectPackageManager(projectRoot: string): DetectedPackageManager {
  const root = resolveWorkspaceRoot(projectRoot) ?? path.resolve(projectRoot);
  const name = resolvePackageManager(projectRoot);
  switch (name) {
    case null:
      return { name: 'npm', root };
    case 'yarn':
      return { name: isYarnBerry(root) ? 'yarn-berry' : 'yarn-classic', root };
    case 'bun':
    case 'npm':
    case 'pnpm':
      return { name, root };
    default:
      throw new CommandError(
        'PATCH_UNSUPPORTED_PACKAGE_MANAGER',
        `This project uses ${name}, and patch supports bun, pnpm, yarn and npm.`
      );
  }
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
