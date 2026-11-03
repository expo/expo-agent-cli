// @ref llp/0004-smart-start-and-project-state.rfc.md §Not an Expo app
// The second wrong-directory failure, and the one `NO_PROJECT` cannot catch: there *is* a
// package.json here, it is just not an app. Everything in this file reads one file synchronously,
// because it runs at the top of a command — before the probe, before the plan, before anything is
// spawned — and a command that must not act on this directory must not do work here first.
//
// @ref llp/0010-agent-conventions.rfc.md §Forwarded codes, and the exception
// The third: an app whose dependencies are not installed, which nothing can act on until they are.
import fs from 'fs';
import path from 'path';

import { PROGRAM_PREFIX } from '../programName';
import { CommandError } from '../utils/errors';
import { findUpProjectRootOrAssert } from '../utils/findUp';
import { resolvePackageRootSync } from './nodeModules';

/** The command that creates an app, named on the `Try:` line and in the `How:` sentence. */
const NEW_APP_COMMAND = `${PROGRAM_PREFIX} new my-app`;

/**
 * Whether the package at this root declares `expo` as a dependency.
 *
 * Declared, not installed. See `ProjectState.isExpoApp` for why: a fresh clone has no
 * `node_modules` and is still an Expo app, and the two questions have two fields.
 *
 * An unreadable or malformed `package.json` answers `false` — nothing there declares `expo`, and
 * this is a guard rather than a diagnosis.
 */
export function declaresExpoSync(projectRoot: string): boolean {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return packageJson?.dependencies?.expo != null || packageJson?.devDependencies?.expo != null;
  } catch {
    return false;
  }
}

/**
 * Stop a command that acts on the app when this directory holds no app to act on.
 *
 * What / Why / How, per the repo's error style, because all three are things the caller does not
 * know: *what* is wrong is a fact about a file they did not look at, *why* is almost always a
 * command run one directory too high, and *how* has three answers depending on which of those they
 * meant. The `Try:` line names the safe one — creating an app changes nothing that is already here,
 * where adding Expo to this package is exactly the mutation this guard exists to prevent.
 *
 * Exit code: the default `EXIT_ERROR` band, the same as `NO_PROJECT`. The tool did not work,
 * the call was aimed at the wrong directory, and running it again unchanged does the same thing.
 */
export function assertExpoAppSync(projectRoot: string): void {
  if (declaresExpoSync(projectRoot)) {
    return;
  }
  const error = new CommandError(
    'NOT_EXPO_APP',
    [
      `This directory is not an Expo app, so this command has nothing to act on.`,
      `Why: ${path.join(projectRoot, 'package.json')} declares no "expo" dependency, which is what makes a package an Expo app. The likeliest cause is a command run one directory too high — a repository or workspace root above the app.`,
      `How: change to the app's own directory and run this again; create an app here with "${NEW_APP_COMMAND}"; or, if you really mean to add Expo to this package, run "${PROGRAM_PREFIX} install expo" first.`,
    ].join('\n')
  );
  error.suggestedCommand = NEW_APP_COMMAND;
  throw error;
}

/**
 * The project root of an Expo app, or a stop naming which of the two things is missing.
 *
 * The one line a command that acts on the app runs instead of `findUpProjectRootOrAssert`: the
 * walk answers "is there a project here", and this answers "is that project this CLI's subject".
 */
export function findUpExpoAppRootOrAssert(cwd: string): string {
  const projectRoot = findUpProjectRootOrAssert(cwd);
  assertExpoAppSync(projectRoot);
  return projectRoot;
}

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

/**
 * Stop a command that acts on the app while its dependencies are not installed.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §Dependencies not installed
 */
export function assertDependenciesInstalledSync(projectRoot: string): void {
  if (dependenciesMissingSync(projectRoot)) {
    throw dependenciesNotInstalledError('nothing ran');
  }
}
