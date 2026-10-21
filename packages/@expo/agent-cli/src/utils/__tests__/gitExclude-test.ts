// @ref llp/0035-one-device-per-worktree.rfc.md §EAS
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ensureGitExcludedAsync } from '../gitExclude';

vi.unmock('fs');
vi.unmock('child_process');

const NAME = '.env.eas-simulator';
let tmp: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function initRepo(): string {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  return repo;
}

function readExclude(repo: string): string {
  const file = path.join(repo, '.git', 'info', 'exclude');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function isIgnored(cwd: string): boolean {
  try {
    git(cwd, 'check-ignore', '-q', '--no-index', NAME);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-exclude-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe(ensureGitExcludedAsync, () => {
  it(`adds the line once, then reports it already covered`, async () => {
    const repo = initRepo();
    await expect(ensureGitExcludedAsync(repo, NAME)).resolves.toBe('added');
    expect(
      readExclude(repo)
        .split('\n')
        .filter((line) => line === NAME)
    ).toHaveLength(1);
    expect(isIgnored(repo)).toBe(true);
    await expect(ensureGitExcludedAsync(repo, NAME)).resolves.toBe('already');
  });

  it(`covers a project in a subdirectory of the repo`, async () => {
    const repo = initRepo();
    const app = path.join(repo, 'apps', 'mobile');
    fs.mkdirSync(app, { recursive: true });
    await expect(ensureGitExcludedAsync(app, NAME)).resolves.toBe('added');
    expect(fs.existsSync(path.join(app, '.git'))).toBe(false);
    expect(isIgnored(app)).toBe(true);
  });

  it(`writes nothing when .gitignore already lists the file`, async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, '.gitignore'), `${NAME}\n`);
    const before = readExclude(repo);
    await expect(ensureGitExcludedAsync(repo, NAME)).resolves.toBe('already');
    expect(readExclude(repo)).toBe(before);
  });

  it(`does nothing outside a git repo`, async () => {
    const dir = path.join(tmp, 'plain');
    fs.mkdirSync(dir);
    await expect(ensureGitExcludedAsync(dir, NAME)).resolves.toBe('skipped');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it(`reports a tracked file and changes neither the index nor the exclude file`, async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, NAME), 'EXPO_TOKEN=secret\n');
    git(repo, 'add', NAME);
    const before = readExclude(repo);
    await expect(ensureGitExcludedAsync(repo, NAME)).resolves.toBe('tracked');
    expect(git(repo, 'ls-files', NAME).trim()).toBe(NAME);
    expect(readExclude(repo)).toBe(before);
  });
});
