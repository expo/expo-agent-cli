// @ref llp/0010-agent-conventions.rfc.md §Forwarded codes, and the exception
// The bare install of an app whose dependencies are not installed: the package manager's own
// install, with the manager and the workspace root that `@expo/package-manager` resolves.

import {
  createForProject,
  resolvePackageManager,
  resolveWorkspaceRoot,
  type NodePackageManager,
} from '@expo/package-manager';

import * as Log from '../log';
import { CommandError } from '../utils/errors';

/**
 * The install that installs exactly what each manager's lockfile records. Yarn's is not frozen,
 * because Yarn 1 spells that `--frozen-lockfile` and Berry `--immutable`.
 */
const FROZEN_INSTALL_ARGS: Record<NodePackageManager['name'], string[]> = {
  npm: ['ci'],
  bun: ['install', '--frozen-lockfile'],
  pnpm: ['install', '--frozen-lockfile'],
  yarn: ['install'],
  nub: ['install'],
};

/** The install that ran: its command, its arguments and its directory. */
export interface BareInstall {
  command: string;
  args: string[];
  cwd: string;
}

/**
 * Run the bare install, in the workspace root the project belongs to, or in the project.
 *
 * Output follows `expo install`'s: inherited for a person, captured and sent to stderr under
 * `--json`, whose stdout holds one object.
 *
 * @returns the package manager's exit code, and the install that produced it.
 * @throws {CommandError} `PACKAGE_MANAGER_NOT_FOUND` when the manager could not be started.
 */
export async function runBareInstallAsync(
  projectRoot: string,
  json: boolean
): Promise<{ exitCode: number; ran: BareInstall }> {
  const cwd = resolveWorkspaceRoot(projectRoot) ?? projectRoot;
  const locked = resolvePackageManager(projectRoot);
  // Its own log goes to stdout, so it is replaced by the line below.
  const manager = createForProject(projectRoot, { cwd, silent: json, log: () => {} });
  // With no lockfile there is nothing to freeze, and `npm ci` refuses to run.
  const ran = {
    command: manager.bin,
    args: locked ? FROZEN_INSTALL_ARGS[locked] : ['install'],
    cwd,
  };
  const message = `Installing the dependencies with ${spell(ran)} in ${cwd}`;
  if (json) {
    Log.error(message);
  } else {
    Log.log(message);
  }

  try {
    printCaptured(json, await manager.runAsync(ran.args));
    return { exitCode: 0, ran };
  } catch (error) {
    const failure = asSpawnFailure(error);
    // `@expo/spawn-async` rejects a process that could not start with no status and no signal.
    if (failure.status == null && failure.signal == null) {
      throw packageManagerNotFoundError(ran, failure.code);
    }
    printCaptured(json, failure);
    return { exitCode: failure.status ?? 1, ran };
  }
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

/** The stop of a bare install that exited 0 and still left `expo` unresolved. */
export function stillUnresolvedError({ cwd, ...ran }: BareInstall): CommandError {
  return new CommandError(
    'DEPENDENCIES_NOT_INSTALLED',
    [
      `"${spell(ran)}" exited 0 in ${cwd}, but expo still does not resolve from this project, so its dependencies are not installed.`,
      `Why: what that install installed does not include this project's expo, for example a lockfile written before expo was added, or a workspace that does not list this package.`,
      `How: install this project with its package manager directly, and check that the lockfile lists expo.`,
    ].join('\n')
  );
}

function packageManagerNotFoundError(ran: BareInstall, code: string | undefined): CommandError {
  return new CommandError(
    'PACKAGE_MANAGER_NOT_FOUND',
    [
      `"${ran.command}" is not installed on this machine, so the dependencies were not installed.`,
      `Why: ${ran.command} is the package manager of this project, and starting "${spell(ran)}" in ${ran.cwd} failed${code ? ` with ${code}` : ''}.`,
      `How: install ${ran.command}, then run this command again.`,
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

function spell({ command, args }: Pick<BareInstall, 'command' | 'args'>): string {
  return [command, ...args].join(' ');
}
