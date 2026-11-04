// @ref llp/0010-agent-conventions.rfc.md §Forwarded codes, and the exception
// The bare install of an app whose dependencies are not installed: the package manager's own
// install, with the manager and the workspace root that `@expo/package-manager` resolves.

import { createForProject, resolveWorkspaceRoot } from '@expo/package-manager';

import * as Log from '../log';
import { dependenciesMissingSync } from '../project/expoApp';
import { CommandError } from '../utils/errors';

/**
 * Run the bare install, in the workspace root the project belongs to, or in the project.
 *
 * Output follows `expo install`'s: inherited for a person, captured and sent to stderr under
 * `--json`, whose stdout holds one object.
 *
 * @returns the package manager's exit code.
 * @throws {CommandError} `PACKAGE_MANAGER_NOT_FOUND` when the manager could not be started, and
 * `DEPENDENCIES_NOT_INSTALLED` when it exited 0 and `expo` still does not resolve.
 */
export async function runBareInstallAsync(projectRoot: string, json: boolean): Promise<number> {
  const cwd = resolveWorkspaceRoot(projectRoot) ?? projectRoot;
  // Its own log goes to stdout, so it is replaced by the line below.
  const manager = createForProject(projectRoot, { cwd, silent: json, log: () => {} });
  const command = `${manager.bin} install`;
  (json ? Log.error : Log.log)(`Installing the dependencies with ${command} in ${cwd}`);

  let exitCode: number;
  try {
    printCaptured(json, await manager.installAsync());
    exitCode = 0;
  } catch (error) {
    const failure = asSpawnFailure(error);
    // `@expo/spawn-async` rejects a process that could not start with no status and no signal.
    if (failure.status == null && failure.signal == null) {
      throw packageManagerNotFoundError(manager.bin, command, cwd, failure.code);
    }
    printCaptured(json, failure);
    exitCode = failure.status ?? 1;
  }
  // @ref llp/0021-honest-reports.rfc.md — a 0 exit is not the answer; an expo that resolves is. No
  // Try: line, because running the bare install again would only repeat this.
  if (exitCode === 0 && dependenciesMissingSync(projectRoot)) {
    throw stillUnresolvedError(command, cwd);
  }
  return exitCode;
}

/** What `@expo/spawn-async` attaches to the error it rejects with. */
interface SpawnFailure {
  status?: number | null;
  signal?: string | null;
  code?: string;
  stdout?: string;
  stderr?: string;
}

function asSpawnFailure(error: unknown): SpawnFailure {
  return typeof error === 'object' && error != null ? (error as SpawnFailure) : {};
}

function stillUnresolvedError(command: string, cwd: string): CommandError {
  return new CommandError(
    'DEPENDENCIES_NOT_INSTALLED',
    [
      `"${command}" exited 0 in ${cwd}, but expo still does not resolve from this project, so its dependencies are not installed.`,
      `Why: what that install installed does not include this project's expo, for example a workspace that does not list this package.`,
      `How: install this project with its package manager directly, and check that package.json and the lockfile list expo.`,
    ].join('\n')
  );
}

function packageManagerNotFoundError(
  bin: string,
  command: string,
  cwd: string,
  code: string | undefined
): CommandError {
  return new CommandError(
    'PACKAGE_MANAGER_NOT_FOUND',
    [
      `"${bin}" is not installed on this machine, so the dependencies were not installed.`,
      `Why: ${bin} is the package manager of this project, and starting "${command}" in ${cwd} failed${code ? ` with ${code}` : ''}.`,
      `How: install ${bin}, then run this command again.`,
    ].join('\n')
  );
}

/** Under `--json`, what the package manager printed goes to stderr. */
function printCaptured(json: boolean, result: { stdout?: string; stderr?: string }): void {
  const printed = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (json && printed) {
    Log.error(printed);
  }
}
