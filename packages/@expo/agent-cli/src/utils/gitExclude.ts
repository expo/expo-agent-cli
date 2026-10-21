// @ref llp/0035-one-device-per-worktree.rfc.md §EAS
import fs from 'fs';
import path from 'path';

import { spawnCaptureAsync } from './spawnCapture';

/**
 * - `added`: the name was appended to `info/exclude`.
 * - `already`: a git ignore rule covers the name.
 * - `tracked`: git tracks the file, so no ignore rule hides it.
 * - `skipped`: no git repo, or git or the file system failed.
 */
export type GitExcludeResult = 'added' | 'already' | 'tracked' | 'skipped';

const GIT_TIMEOUT_MS = 3_000;

/**
 * Make git ignore `name` in `projectRoot` through `info/exclude`, never `.gitignore`.
 *
 * The line is unanchored, so a project in a subdirectory of the repo is covered. Never throws.
 */
export async function ensureGitExcludedAsync(
  projectRoot: string,
  name: string
): Promise<GitExcludeResult> {
  try {
    const tracked = await gitAsync(projectRoot, ['ls-files', '--error-unmatch', '--', name]);
    if (tracked.exitCode === 0) {
      return 'tracked';
    }
    if (tracked.exitCode !== 1) {
      return 'skipped';
    }
    const ignored = await gitAsync(projectRoot, ['check-ignore', '-q', '--no-index', name]);
    if (ignored.exitCode === 0) {
      return 'already';
    }
    if (ignored.exitCode !== 1) {
      return 'skipped';
    }
    const where = await gitAsync(projectRoot, ['rev-parse', '--git-path', 'info/exclude']);
    if (where.exitCode !== 0 || !where.stdout.trim()) {
      return 'skipped';
    }
    const file = path.resolve(projectRoot, where.stdout.trim());
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const current = await fs.promises.readFile(file, 'utf8').catch(() => '');
    const separator = current && !current.endsWith('\n') ? '\n' : '';
    await fs.promises.appendFile(
      file,
      `${separator}# agent-cli: EAS session credentials\n${name}\n`
    );
    return 'added';
  } catch {
    return 'skipped';
  }
}

async function gitAsync(cwd: string, args: string[]) {
  const result = await spawnCaptureAsync('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  return { exitCode: result.spawnError ? null : result.exitCode, stdout: result.stdout };
}
