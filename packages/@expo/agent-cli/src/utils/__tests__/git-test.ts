import { spawn } from 'child_process';

import { resolveWorkTreeAsync } from '../git';
import { mockSpawnAlways, mockSpawnBy } from './fakeSpawn';

type GitReply = { stdout?: string; stderr?: string; code?: number };

/** Answer every `git` spawn from a table keyed by the first argument. */
function mockGit(replies: (args: string[]) => GitReply): void {
  mockSpawnBy(({ args }) => {
    const { stdout, stderr, code } = replies(args);
    return { stdout, stderr, exitCode: code };
  });
}

/** Every `git` invocation, as `[args, options]` pairs. */
function gitCalls(): { args: string[]; cwd: string; indexFile?: string }[] {
  return vi.mocked(spawn).mock.calls.map(([, args, options]: any) => ({
    args,
    cwd: options.cwd,
    indexFile: options.env.GIT_INDEX_FILE,
  }));
}

const projectRoot = '/repo/apps/app';

describe(resolveWorkTreeAsync, () => {
  it(`should report the work tree root and the project's prefix`, async () => {
    mockGit(() => ({ stdout: 'true\n/repo\napps/app/\n' }));

    await expect(resolveWorkTreeAsync(projectRoot)).resolves.toEqual({
      toplevel: '/repo',
      prefix: 'apps/app',
    });
    expect(gitCalls()[0]!.args).toEqual([
      'rev-parse',
      '--is-inside-work-tree',
      '--show-toplevel',
      '--show-prefix',
    ]);
  });

  it(`should report an empty prefix for a project at the work tree root`, async () => {
    mockGit(() => ({ stdout: 'true\n/repo\n\n' }));

    await expect(resolveWorkTreeAsync('/repo')).resolves.toEqual({
      toplevel: '/repo',
      prefix: '',
    });
  });

  it(`should return null outside a git work tree`, async () => {
    mockGit(() => ({ stderr: 'fatal: not a git repository', code: 128 }));

    await expect(resolveWorkTreeAsync(projectRoot)).resolves.toBeNull();
  });

  it(`should return null when git is not installed`, async () => {
    mockSpawnAlways({ error: new Error('spawn git ENOENT') });

    await expect(resolveWorkTreeAsync(projectRoot)).resolves.toBeNull();
  });

  it(`should return null inside a bare repository`, async () => {
    mockGit(() => ({ stdout: 'false\n\n\n' }));

    await expect(resolveWorkTreeAsync(projectRoot)).resolves.toBeNull();
  });
});
