import { describe, expect, it, mock } from 'bun:test';
import path from 'node:path';

import {
  applyVersion,
  parseArgs,
  publish,
  USAGE,
  type CommandResult,
  type PublishIo,
} from './publish';

const cwd = '/repo';
const packageJsonPath = path.join(cwd, 'package.json');

function packageJsonAt(version: string): string {
  return `${JSON.stringify({ name: 'expo-agent-cli', version }, null, 2)}\n`;
}

function ok(stdout = ''): CommandResult {
  return { status: 0, stdout, stderr: '' };
}

function fail(stderr: string, stdout = ''): CommandResult {
  return { status: 1, stdout, stderr };
}

function createIo(
  argv: string[],
  commands: Record<string, CommandResult>,
  files: Record<string, string> = { [packageJsonPath]: packageJsonAt('1.0.0') }
): PublishIo & { logs: string[]; errors: string[]; writes: Record<string, string>; runs: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  const writes: Record<string, string> = {};
  const runs: string[] = [];
  const io: PublishIo & {
    logs: string[];
    errors: string[];
    writes: Record<string, string>;
    runs: string[];
  } = {
    cwd,
    argv,
    logs,
    errors,
    writes,
    runs,
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
    exit: mock(() => {}),
    readFile: (filePath) => {
      if (!(filePath in files)) {
        throw new Error(`ENOENT: ${filePath}`);
      }
      return files[filePath];
    },
    writeFile: (filePath, contents) => {
      files[filePath] = contents;
      writes[filePath] = contents;
    },
    run: (command, args) => {
      const key = [command, ...args].join(' ');
      runs.push(key);
      const result = commands[key];
      if (!result) {
        throw new Error(`unexpected command: ${key}`);
      }
      return result;
    },
  };
  return io;
}

describe('parseArgs', () => {
  it('should default to latest without a version', () => {
    expect(parseArgs([])).toEqual({ version: undefined, tag: 'latest', dryRun: false, help: false });
  });

  it('should parse version tag and dry-run', () => {
    expect(parseArgs(['2.0.0', '--tag', 'next', '--dry-run'])).toEqual({
      version: '2.0.0',
      tag: 'next',
      dryRun: true,
      help: false,
    });
  });

  it('should parse --tag=value', () => {
    expect(parseArgs(['--tag=beta'])).toEqual({
      version: undefined,
      tag: 'beta',
      dryRun: false,
      help: false,
    });
  });

  it('should throw when --tag is missing a value', () => {
    expect(() => parseArgs(['--tag'])).toThrow('publish: --tag needs a value');
  });

  it('should throw on unknown options', () => {
    expect(() => parseArgs(['--nope'])).toThrow('publish: unknown option --nope');
  });

  it('should throw on extra positional arguments', () => {
    expect(() => parseArgs(['1.0.0', '2.0.0'])).toThrow('publish: unexpected extra argument 2.0.0');
  });
});

describe('applyVersion', () => {
  it('should replace the version and keep json formatting', () => {
    expect(applyVersion(packageJsonAt('1.0.0'), '2.0.0')).toBe(packageJsonAt('2.0.0'));
  });
});

describe('publish', () => {
  it('should print usage and exit 0 for --help', () => {
    const io = createIo(['--help'], {});
    publish(io);
    expect(io.logs).toEqual([USAGE]);
    expect(io.exit).toHaveBeenCalledWith(0);
    expect(io.runs).toEqual([]);
  });

  it('should bump commit push and dispatch when version is omitted', () => {
    const io = createIo([], {
      'npm view @expo/agent-cli@latest version': ok('2.0.0\n'),
      'npm view expo-agent-cli@2.0.0 version': fail('404 Not Found'),
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
      'git status --porcelain': ok(''),
      'git add package.json': ok(),
      'git commit -m Publish expo-agent-cli@2.0.0': ok(),
      'git push': ok(),
      'gh workflow run publish.yml --ref main --field tag=latest': ok(),
    });

    publish(io);

    expect(io.writes[packageJsonPath]).toBe(packageJsonAt('2.0.0'));
    expect(io.runs).toEqual([
      'npm view @expo/agent-cli@latest version',
      'npm view expo-agent-cli@2.0.0 version',
      'git rev-parse --abbrev-ref HEAD',
      'git status --porcelain',
      'git add package.json',
      'git commit -m Publish expo-agent-cli@2.0.0',
      'git push',
      'gh workflow run publish.yml --ref main --field tag=latest',
    ]);
    expect(io.logs).toEqual([
      'Publishing expo-agent-cli@2.0.0 with tag latest',
      'Pushed expo-agent-cli@2.0.0 to origin/main',
      'Dispatched publish.yml on main (tag latest)',
    ]);
    expect(io.exit).toHaveBeenCalledWith(0);
  });

  it('should dispatch without rewriting when package.json already matches', () => {
    const io = createIo(['2.0.0', '--tag', 'next'], {
      'npm view expo-agent-cli@2.0.0 version': fail('404 Not Found'),
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
      'git status --porcelain': ok(''),
      'gh workflow run publish.yml --ref main --field tag=next': ok(),
    }, { [packageJsonPath]: packageJsonAt('2.0.0') });

    publish(io);

    expect(io.writes).toEqual({});
    expect(io.runs).not.toContain('git push');
    expect(io.logs).toEqual([
      'Publishing expo-agent-cli@2.0.0 with tag next',
      'package.json is already 2.0.0',
      'Dispatched publish.yml on main (tag next)',
    ]);
    expect(io.exit).toHaveBeenCalledWith(0);
  });

  it('should not write push or dispatch on dry-run', () => {
    const io = createIo(['--dry-run'], {
      'npm view @expo/agent-cli@latest version': ok('2.0.0\n'),
      'npm view expo-agent-cli@2.0.0 version': fail('404 Not Found'),
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
      'git status --porcelain': ok(''),
    });

    publish(io);

    expect(io.writes).toEqual({});
    expect(io.runs).toEqual([
      'npm view @expo/agent-cli@latest version',
      'npm view expo-agent-cli@2.0.0 version',
      'git rev-parse --abbrev-ref HEAD',
      'git status --porcelain',
    ]);
    expect(io.logs).toEqual([
      'Publishing expo-agent-cli@2.0.0 with tag latest',
      'Would update package.json to 2.0.0',
      'Would commit and push to origin/main',
      'Would dispatch publish.yml on main (tag latest)',
    ]);
    expect(io.exit).toHaveBeenCalledWith(0);
  });

  it('should exit 1 when the alias version is already on npm', () => {
    const io = createIo(['1.0.0'], {
      'npm view expo-agent-cli@1.0.0 version': ok('1.0.0\n'),
    });

    publish(io);

    expect(io.errors).toEqual(['publish: expo-agent-cli@1.0.0 is already on npm']);
    expect(io.exit).toHaveBeenCalledWith(1);
    expect(io.writes).toEqual({});
  });

  it('should exit 1 when the working tree is dirty', () => {
    const io = createIo(['2.0.0'], {
      'npm view expo-agent-cli@2.0.0 version': fail('404 Not Found'),
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
      'git status --porcelain': ok(' M README.md\n'),
    });

    publish(io);

    expect(io.errors).toEqual(['publish: working tree is not clean']);
    expect(io.exit).toHaveBeenCalledWith(1);
  });

  it('should exit 1 for an invalid dist-tag', () => {
    const io = createIo(['--tag', 'latest tag'], {});
    publish(io);
    expect(io.errors).toEqual(['publish: invalid dist-tag latest tag']);
    expect(io.exit).toHaveBeenCalledWith(1);
  });

  it('should exit 1 when gh is missing', () => {
    const io = createIo(['2.0.0'], {
      'npm view expo-agent-cli@2.0.0 version': fail('404 Not Found'),
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
      'git status --porcelain': ok(''),
      'git add package.json': ok(),
      'git commit -m Publish expo-agent-cli@2.0.0': ok(),
      'git push': ok(),
      'gh workflow run publish.yml --ref main --field tag=latest': fail('cannot find gh'),
    });

    publish(io);

    expect(io.errors).toEqual(['publish: failed to dispatch workflow (cannot find gh)']);
    expect(io.exit).toHaveBeenCalledWith(1);
  });
});
