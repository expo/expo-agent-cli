import path from 'path';

import { fileExistsSync } from './dir';

/**
 * The `PATH` a child spawned with `env` searches.
 *
 * On Windows env keys are case-insensitive, and an env object can hold `PATH` and `Path` at once.
 * Node keeps the first of them in sort order for the child (`lib/child_process.js`), so this does
 * too.
 *
 * @param platform the platform the child runs on, for a caller that injects it.
 */
export function pathFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform
): string {
  if (platform !== 'win32') {
    return env.PATH ?? '';
  }
  const key = Object.keys(env)
    .filter((name) => name.toUpperCase() === 'PATH')
    .sort()[0];
  return (key && env[key]) ?? '';
}

/** Filename variants of one command, in the order this CLI tries them on this platform. */
function executableNames(name: string): string[] {
  if (process.platform !== 'win32' || /\.(cmd|bat|exe)$/i.test(name)) {
    return [name];
  }
  return [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name];
}

/**
 * Find a command on `PATH` without spawning anything.
 *
 * `which`/`where` would be a subprocess for a question two `stat` calls answer, and a command
 * that has to *report* which binary it is about to run (`@expo/agent-cli deploy` names the `eas` it
 * found) needs the path, not just a yes.
 *
 * An entry whose `stat` throws — a symlink loop (`ELOOP`), an unreadable directory (`EACCES`) — is
 * skipped like an entry that does not hold the executable, the way a shell skips it, so a later
 * entry can still answer. `throwIfNoEntry: false` covers only `ENOENT` [observed — Node 26.5,
 * 2026-10-16].
 *
 * @param env the environment whose `PATH` is searched: a child's, or a test's that must not depend
 *   on the machine's.
 * @param paths how to split and join `PATH`: this host's, or `path.win32` for a caller that has
 *   already decided it runs on Windows.
 * @returns the absolute path of the executable, or `null` when no entry of `PATH` holds it.
 */
export function findExecutableOnPath(
  name: string,
  { env = process.env, paths = path }: { env?: NodeJS.ProcessEnv; paths?: path.PlatformPath } = {}
): string | null {
  for (const dir of pathFromEnv(env).split(paths.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const fileName of executableNames(name)) {
      const candidate = paths.join(dir, fileName);
      if (isFileSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function isFileSync(file: string): boolean {
  try {
    return fileExistsSync(file);
  } catch {
    return false;
  }
}
