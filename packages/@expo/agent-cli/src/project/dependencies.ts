// @ref llp/0010-agent-conventions.rfc.md §Forwarded codes, and the exception
// The one answer to "are this app's dependencies installed", and the stop when they are not.

import { PROGRAM_PREFIX } from '../programName';
import { CommandError } from '../utils/errors';
import { declaresExpoSync } from './expoApp';
import { resolvePackageRootSync } from './nodeModules';

/** The bare install: the lockfile's dependencies, for an app whose dependencies are missing. */
export const INSTALL_DEPENDENCIES_COMMAND = `${PROGRAM_PREFIX} install`;

/**
 * Whether this is an Expo app whose dependencies are not installed: its package.json declares
 * `expo`, and no `expo` resolves from the project root or a directory above it, where a workspace
 * hoists it. A fresh clone or a new git worktree is in this state.
 */
export function dependenciesMissingSync(projectRoot: string): boolean {
  return declaresExpoSync(projectRoot) && resolvePackageRootSync(projectRoot, 'expo') == null;
}

/**
 * The stop of a command that cannot run until the dependencies are installed.
 *
 * @param outcome what did not happen, e.g. "nothing was installed".
 */
export function dependenciesNotInstalledError(outcome: string): CommandError {
  const error = new CommandError(
    'DEPENDENCIES_NOT_INSTALLED',
    [
      `This project's dependencies are not installed, so ${outcome}.`,
      `Why: package.json declares expo, and no expo resolves from this project or any directory above it. Every Expo tool reads the SDK and the project's packages from node_modules.`,
      `How: run "${INSTALL_DEPENDENCIES_COMMAND}" with no arguments. It installs the lockfile. Then run this command again.`,
    ].join('\n')
  );
  error.suggestedCommand = INSTALL_DEPENDENCIES_COMMAND;
  return error;
}
