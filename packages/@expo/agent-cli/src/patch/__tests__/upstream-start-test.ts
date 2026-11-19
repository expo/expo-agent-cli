import fs from 'fs';
import path from 'path';

import { startCommands } from '../upstream';

// Real git in a real directory: memfs cannot hold a repository.
vi.unmock('fs');
vi.unmock('node:fs');

const os = await vi.importActual<typeof import('os')>('os');
const { execFileSync } = await vi.importActual<typeof import('child_process')>('child_process');

let root: string;
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-upstream-start-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe(startCommands, () => {
  // GitHub serves a fetch of any sha; a local repository needs allowAnySHA1InWant for it.
  it.each(['published', 'main'])('leaves upstream/main for the rebase (base: %s)', (kind) => {
    const upstream = path.join(root, 'upstream');
    fs.mkdirSync(upstream);
    git(upstream, ['init', '-q', '-b', 'main']);
    git(upstream, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    git(upstream, ['commit', '-q', '--allow-empty', '-m', 'published']);
    const published = git(upstream, ['rev-parse', 'HEAD']);
    git(upstream, ['commit', '-q', '--allow-empty', '-m', 'later']);

    const fork = path.join(root, 'fork');
    fs.mkdirSync(fork);
    git(fork, ['init', '-q', '-b', 'main']);
    git(fork, ['remote', 'add', 'upstream', upstream]);
    const base = kind === 'main' ? 'main' : published;
    for (const command of startCommands(base, 'fix/x')) {
      git(fork, command.split(' ').slice(1));
    }

    expect(git(fork, ['rev-parse', 'HEAD'])).toBe(
      kind === 'main' ? git(upstream, ['rev-parse', 'HEAD']) : published
    );
    git(fork, ['rebase', 'upstream/main']);
    expect(git(fork, ['rev-parse', 'HEAD'])).toBe(git(upstream, ['rev-parse', 'HEAD']));
  });
});
