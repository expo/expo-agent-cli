// @ref llp/0021-honest-reports.rfc.md §The rules (rule 10: an observed signal, or the band)
// Whether `new` may say the dependencies are installed. `create-expo` exits 0 when its own install
// fails (npm `ERESOLVE`, no network), leaving a scaffold with no `node_modules`, so the exit code
// is not evidence. The project's own `expo` on disk is: every later verb needs it.

import path from 'path';

import { resolvePackageRootSync } from '../project/nodeModules';
import { wrapUntrustedAppOutput } from '../runtime/untrusted';

/** What `new` knows about the dependencies of the project it created. */
export type InstallState =
  /** `expo` resolves from the project directory. */
  | 'installed'
  /** `--no-install` was passed; no install ran. */
  | 'skipped'
  /** create-expo ran its install, but `expo` does not resolve from the project. */
  | 'missing';

/**
 * Decide from the disk, not from what was requested. `expo` is looked up the way every later verb
 * looks it up (`resolvePackageRootSync`), so `installed` means those verbs will find it.
 */
export function resolveInstallState(projectRoot: string, requested: boolean): InstallState {
  if (!requested) {
    return 'skipped';
  }
  return resolvePackageRootSync(projectRoot, 'expo') ? 'installed' : 'missing';
}

/** The last non-empty lines of a captured run, which is where a tool says what went wrong. */
export function tailLines(output: string, maxLines: number): string {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-maxLines)
    .join('\n');
}

/** The report's reason for `installed: false` after a `create-expo` that exited 0. */
export function describeMissingInstall(
  projectRoot: string,
  installCommand: string,
  outputTail: string
): string {
  return [
    `Dependencies are not installed: create-expo exited 0, but expo/package.json does not resolve from the project (looked for ${path.join(projectRoot, 'node_modules', 'expo', 'package.json')} and in the parent directories).`,
    `Why: create-expo's own dependency install did not finish, and it exited successfully anyway${outputTail ? '; its output ends with the lines below' : ''}.`,
    `How: run "${installCommand}", then continue with the next steps.`,
    ...(outputTail ? [wrapUntrustedAppOutput(outputTail)] : []),
  ].join('\n');
}
