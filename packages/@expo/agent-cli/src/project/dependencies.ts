// @ref llp/0004-smart-start-and-project-state.rfc.md §Dependencies not installed
import { PROGRAM_PREFIX } from '../programName';
import { CommandError } from '../utils/errors';
import { resolvePackageRootSync } from './nodeModules';

/** The bare install: the lockfile's dependencies, for a project whose `expo` does not resolve. */
export const INSTALL_DEPENDENCIES_COMMAND = `${PROGRAM_PREFIX} install`;

/**
 * Whether this project's dependencies are installed: `expo` resolves from the project root or a
 * directory above it, the way a workspace hoists it.
 *
 * Without them, every fact the plan reads from `node_modules` is absent: no `expo-dev-client`, no
 * `@expo/fingerprint`, no SDK. The plan then reads a fresh clone as "no dev client, no build".
 */
export function dependenciesInstalledSync(projectRoot: string): boolean {
  return resolvePackageRootSync(projectRoot, 'expo') != null;
}

/** The stop of a command that plans or runs the app in a project with no installed dependencies. */
export function dependenciesNotInstalledError(): CommandError {
  const error = new CommandError(
    'DEPENDENCIES_NOT_INSTALLED',
    [
      `Dependencies are not installed, so nothing was planned or run.`,
      `Why: the expo package does not resolve from this project or any directory above it. Without node_modules the plan cannot see expo-dev-client or compute the fingerprint, so it would plan a dev-client install and a new native build that this project may not need.`,
      `How: run "${INSTALL_DEPENDENCIES_COMMAND}" with no packages. It installs the lockfile. Then run this command again.`,
    ].join('\n')
  );
  error.suggestedCommand = INSTALL_DEPENDENCIES_COMMAND;
  return error;
}
