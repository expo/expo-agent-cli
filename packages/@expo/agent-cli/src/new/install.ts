// @ref llp/0021-honest-reports.rfc.md §The rules (rule 10: an observed signal, or the band)
// Whether `new` may say the dependencies are installed. `create-expo` exits 0 when its own install
// fails (npm `ERESOLVE`, no network), leaving a scaffold with no `node_modules`, so the exit code
// is not evidence. The project's own `expo` on disk is: every later verb needs it.

import path from 'path';

import { wrapUntrustedAppOutput } from '../runtime/untrusted';
import { fileExistsSync } from '../utils/dir';
import type { Invoker } from '../utils/invoker';

/** What `new` knows about the dependencies of the project it created. */
export type InstallState =
  /** `<dir>/node_modules/expo/package.json` is on disk. */
  | 'installed'
  /** `--no-install` was passed, so nothing was asked for. */
  | 'skipped'
  /** An install was asked for and the project's `expo` is not on disk. */
  | 'missing';

/** Decide from the disk, not from what was requested. */
export function resolveInstallState(projectRoot: string, requested: boolean): InstallState {
  if (!requested) {
    return 'skipped';
  }
  return fileExistsSync(path.join(projectRoot, 'node_modules', 'expo', 'package.json'))
    ? 'installed'
    : 'missing';
}

/**
 * The install command for the project's package manager.
 *
 * The lockfile `create-expo` left names the manager; with none (a failed install writes none),
 * the runner this process came from does. `--legacy-peer-deps` is offered only for an npm
 * `ERESOLVE`, the one case it was observed to fix [observed — 2026-10-05, a prerelease SDK whose
 * `react-native-reanimated` peer range excluded `react-native@0.88.0-rc.3`].
 */
export function suggestInstallCommand(
  projectRoot: string,
  output: string,
  invoker: Invoker
): string {
  const has = (file: string) => fileExistsSync(path.join(projectRoot, file));
  if (has('bun.lock') || has('bun.lockb')) return 'bun install';
  if (has('pnpm-lock.yaml')) return 'pnpm install';
  if (has('yarn.lock')) return 'yarn install';
  if (has('package-lock.json') || invoker === 'npx') {
    return output.includes('ERESOLVE') ? 'npm install --legacy-peer-deps' : 'npm install';
  }
  return 'bun install';
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
    `Dependencies are not installed: create-expo exited 0, but ${path.join(projectRoot, 'node_modules', 'expo', 'package.json')} does not exist.`,
    `Why: create-expo's own dependency install did not finish, and it exited successfully anyway${outputTail ? '; its output ends with the lines below' : ''}.`,
    `How: run "${installCommand}", then continue with the next steps.`,
    ...(outputTail ? [wrapUntrustedAppOutput(outputTail)] : []),
  ].join('\n');
}
