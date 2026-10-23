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

// The user's global excludes (a `.env*` rule) and the system config would change the answers.
const isolatedGit = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.excludesFile',
  GIT_CONFIG_VALUE_0: '',
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-exclude-')));
  for (const [key, value] of Object.entries(isolatedGit)) vi.stubEnv(key, value);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe(ensureGitExcludedAsync, () => {
  it(`covers a project in a subdirectory of the repo`, async () => {
    const repo = initRepo();
    const app = path.join(repo, 'apps', 'mobile');
    fs.mkdirSync(app, { recursive: true });
    await expect(ensureGitExcludedAsync(app, NAME)).resolves.toEqual({ result: 'added' });
    expect(fs.existsSync(path.join(app, '.git'))).toBe(false);
    expect(isIgnored(app)).toBe(true);
  });

  it(`writes nothing when .gitignore already lists the file`, async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, '.gitignore'), `${NAME}\n`);
    const before = readExclude(repo);
    await expect(ensureGitExcludedAsync(repo, NAME)).resolves.toEqual({ result: 'already' });
    expect(readExclude(repo)).toBe(before);
  });

  it(`does nothing outside a git repo`, async () => {
    const dir = path.join(tmp, 'plain');
    fs.mkdirSync(dir);
    await expect(ensureGitExcludedAsync(dir, NAME)).resolves.toEqual({ result: 'skipped' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it(`reports a tracked file and changes neither the index nor the exclude file`, async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, NAME), 'EXPO_TOKEN=secret\n');
    git(repo, 'add', NAME);
    const before = readExclude(repo);
    await expect(ensureGitExcludedAsync(repo, NAME)).resolves.toEqual({ result: 'tracked' });
    expect(git(repo, 'ls-files', NAME).trim()).toBe(NAME);
    expect(readExclude(repo)).toBe(before);
  });

  // A `.gitignore` negation wins over info/exclude. The file stays committable, so this must not
  // read as added, and a second bind must not append the line again.
  it(`names the rule that un-ignores the file, and writes the line once`, async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, '.gitignore'), '!.env*\n');
    const overridden = { result: 'overridden', rule: '.gitignore:1:!.env*' };
    await expect(ensureGitExcludedAsync(repo, NAME)).resolves.toEqual(overridden);
    await expect(ensureGitExcludedAsync(repo, NAME)).resolves.toEqual(overridden);
    expect(
      readExclude(repo)
        .split('\n')
        .filter((line) => line === NAME)
    ).toHaveLength(1);
  });
});
