// @ref llp/0037-patch-command.rfc.md §Command surface

import path from 'path';

import { readJsonFileSync, resolvePackageRootSync } from '../project/nodeModules';
import { PROGRAM_PREFIX } from '../programName';
import { isPathInside } from '../utils/dir';
import { CommandError } from '../utils/errors';

export interface InstalledPackage {
  packageDir: string;
  version: string;
  manifest: Record<string, any>;
}

/**
 * The copy of a package the project resolves, the way Node does: the nearest `node_modules` from the
 * project root up. A copy above the workspace root is not the project's, so it does not count.
 */
export function resolveInstalledPackage(
  projectRoot: string,
  packageName: string,
  workspaceRoot: string
): InstalledPackage {
  const packageDir = resolvePackageRootSync(projectRoot, packageName);
  const manifest =
    packageDir && isPathInside(packageDir, workspaceRoot)
      ? readJsonFileSync<Record<string, any>>(path.join(packageDir, 'package.json'))
      : null;
  if (packageDir && manifest) {
    return { packageDir, version: String(manifest.version), manifest };
  }
  const error = new CommandError(
    'PATCH_NOT_INSTALLED',
    [
      `${packageName} is not installed in ${projectRoot}, so there is nothing to patch.`,
      `How: install it first, edit its files in node_modules/${packageName}, then run this again.`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} install ${packageName}`;
  throw error;
}
