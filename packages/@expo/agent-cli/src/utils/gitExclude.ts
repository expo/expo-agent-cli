// @ref llp/0035-one-device-per-worktree.rfc.md §EAS
import fs from 'fs';
import path from 'path';

import { spawnCaptureAsync } from './spawnCapture';

/**
 * - `added`: the name was appended to `info/exclude`, and git now ignores it.
 * - `already`: a git ignore rule covers the name.
 * - `tracked`: git tracks the file, so no ignore rule hides it.
 * - `overridden`: `info/exclude` lists the name, and a rule that wins over it un-ignores the file;
 *   `rule` names it as `git check-ignore -v` prints it.
 * - `skipped`: no git repo, or git or the file system failed.
 */
export type GitExcludeResult =
  | { result: 'added' | 'already' | 'tracked' | 'skipped' }
  | { result: 'overridden'; rule: string };

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
    if (tracked.exitCode === 0) return { result: 'tracked' };
    if (tracked.exitCode !== 1) return { result: 'skipped' };
    const ignored = await isIgnoredAsync(projectRoot, name);
    if (ignored !== false) return { result: ignored ? 'already' : 'skipped' };
    const where = await gitAsync(projectRoot, ['rev-parse', '--git-path', 'info/exclude']);
    if (where.exitCode !== 0 || !where.stdout.trim()) return { result: 'skipped' };
    const file = path.resolve(projectRoot, where.stdout.trim());
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const current = await fs.promises.readFile(file, 'utf8').catch(() => '');
    // Listed already and still not ignored: a later rule wins. Appending again would change nothing.
    if (!current.split('\n').some((line) => line.trim() === name)) {
      const separator = current && !current.endsWith('\n') ? '\n' : '';
      await fs.promises.appendFile(
        file,
        `${separator}# agent-cli: EAS session credentials\n${name}\n`
      );
    }
    if (await isIgnoredAsync(projectRoot, name)) return { result: 'added' };
    const verbose = await gitAsync(projectRoot, ['check-ignore', '-v', '--no-index', name]);
    return { result: 'overridden', rule: verbose.stdout.split('\t')[0]!.trim() || 'a git rule' };
  } catch {
    return { result: 'skipped' };
  }
}

/** True when git ignores `name`, false when it does not, null when git could not answer. */
async function isIgnoredAsync(cwd: string, name: string): Promise<boolean | null> {
  const { exitCode } = await gitAsync(cwd, ['check-ignore', '-q', '--no-index', name]);
  return exitCode === 0 ? true : exitCode === 1 ? false : null;
}

async function gitAsync(cwd: string, args: string[]) {
  const result = await spawnCaptureAsync('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  return { exitCode: result.spawnError ? null : result.exitCode, stdout: result.stdout };
}
