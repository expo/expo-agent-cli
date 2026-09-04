import { describe, expect, it, mock } from 'bun:test';
import path from 'node:path';

import {
  applyVersion,
  bumpPatch,
  DEFAULT_PACKAGE,
  parseArgs,
  publish,
  USAGE,
  type CommandResult,
  type PublishIo,
} from './publish';

const cwd = '/repo';
const aliasPackageJsonPath = path.join(cwd, 'packages/expo-agent-cli/package.json');
const agentCliPackageJsonPath = path.join(cwd, 'packages/@expo/agent-cli/package.json');

function packageJsonAt(version: string, name = DEFAULT_PACKAGE): string {
  return `${JSON.stringify({ name, version }, null, 2)}\n`;
}

function ok(stdout = ''): CommandResult {
  return { status: 0, stdout, stderr: '' };
}

function fail(stderr: string, stdout = ''): CommandResult {
  return { status: 1, stdout, stderr };
}

function ghDispatch(tag: string, packageName: string, branch = 'main'): string {
  return `gh workflow run publish.yml --ref ${branch} --field package=${packageName} --field tag=${tag}`;
}

function createIo(
  argv: string[],
  commands: Record<string, CommandResult>,
  files: Record<string, string> = { [agentCliPackageJsonPath]: packageJsonAt('1.0.0') }
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
    expect(parseArgs([])).toEqual({
      version: undefined,
      packageName: DEFAULT_PACKAGE,
      tag: 'latest',
      dryRun: false,
      help: false,
    });
  });

  it('should parse version tag and dry-run', () => {
    expect(parseArgs(['2.0.0', '--tag', 'next', '--dry-run'])).toEqual({
      version: '2.0.0',
      packageName: DEFAULT_PACKAGE,
      tag: 'next',
      dryRun: true,
      help: false,
    });
  });

  it('should parse --tag=value', () => {
    expect(parseArgs(['--tag=beta'])).toEqual({
      version: undefined,
      packageName: DEFAULT_PACKAGE,
      tag: 'beta',
      dryRun: false,
      help: false,
    });
  });

  it('should parse --package', () => {
    expect(parseArgs(['--package', 'expo-agent-cli', '2.0.0'])).toEqual({
      version: '2.0.0',
      packageName: 'expo-agent-cli',
      tag: 'latest',
      dryRun: false,
      help: false,
    });
  });

  it('should parse --package=value', () => {
    expect(parseArgs(['--package=expo-agent-cli'])).toEqual({
      version: undefined,
      packageName: 'expo-agent-cli',
      tag: 'latest',
      dryRun: false,
      help: false,
    });
  });

  it('should throw when --tag is missing a value', () => {
    expect(() => parseArgs(['--tag'])).toThrow('publish: --tag needs a value');
  });

  it('should throw when --package is missing a value', () => {
    expect(() => parseArgs(['--package'])).toThrow('publish: --package needs a value');
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

describe('bumpPatch', () => {
  it('should increment the patch number', () => {
    expect(bumpPatch('1.2.3')).toBe('1.2.4');
  });

  it('should increment patch from 9 to 10', () => {
    expect(bumpPatch('1.2.9')).toBe('1.2.10');
  });

  it('should drop prerelease and build metadata', () => {
    expect(bumpPatch('1.2.3-beta.1')).toBe('1.2.4');
    expect(bumpPatch('1.2.3+build.5')).toBe('1.2.4');
  });

  it('should throw for an invalid version', () => {
    expect(() => bumpPatch('1.2')).toThrow('publish: invalid version 1.2');
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

  it('should bump the patch version when version is omitted for expo-agent-cli', () => {
    const io = createIo(['--package', 'expo-agent-cli'], {
      'npm view expo-agent-cli@1.0.1 version': fail('404 Not Found'),
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
      'git status --porcelain': ok(''),
      'git add packages/expo-agent-cli/package.json': ok(),
      'git commit -m Publish expo-agent-cli@1.0.1': ok(),
      'git push': ok(),
      [ghDispatch('latest', 'expo-agent-cli')]: ok(),
    }, { [aliasPackageJsonPath]: packageJsonAt('1.0.0', 'expo-agent-cli') });

    publish(io);

    expect(io.writes[aliasPackageJsonPath]).toBe(packageJsonAt('1.0.1', 'expo-agent-cli'));
    expect(io.runs).toEqual([
      'npm view expo-agent-cli@1.0.1 version',
      'git rev-parse --abbrev-ref HEAD',
      'git status --porcelain',
      'git add packages/expo-agent-cli/package.json',
      'git commit -m Publish expo-agent-cli@1.0.1',
      'git push',
      ghDispatch('latest', 'expo-agent-cli'),
    ]);
    expect(io.logs).toEqual([
      'Publishing expo-agent-cli@1.0.1 with tag latest',
      'Pushed expo-agent-cli@1.0.1 to origin/main',
      'Dispatched publish.yml on main (package expo-agent-cli, tag latest)',
    ]);
    expect(io.exit).toHaveBeenCalledWith(0);
  });

  it('should dispatch without rewriting when package.json already matches', () => {
    const io = createIo(['2.0.0', '--tag', 'next'], {
      'npm view @expo/agent-cli@2.0.0 version': fail('404 Not Found'),
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
      'git status --porcelain': ok(''),
      [ghDispatch('next', '@expo/agent-cli')]: ok(),
    }, { [agentCliPackageJsonPath]: packageJsonAt('2.0.0') });

    publish(io);

    expect(io.writes).toEqual({});
    expect(io.runs).not.toContain('git push');
    expect(io.logs).toEqual([
      'Publishing @expo/agent-cli@2.0.0 with tag next',
      'package.json is already 2.0.0',
      'Dispatched publish.yml on main (package @expo/agent-cli, tag next)',
    ]);
    expect(io.exit).toHaveBeenCalledWith(0);
  });

  it('should not write push or dispatch on dry-run', () => {
    const io = createIo(['2.0.0', '--dry-run'], {
      'npm view @expo/agent-cli@2.0.0 version': fail('404 Not Found'),
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
      'git status --porcelain': ok(''),
    });

    publish(io);

    expect(io.writes).toEqual({});
    expect(io.runs).toEqual([
      'npm view @expo/agent-cli@2.0.0 version',
      'git rev-parse --abbrev-ref HEAD',
      'git status --porcelain',
    ]);
    expect(io.logs).toEqual([
      'Publishing @expo/agent-cli@2.0.0 with tag latest',
      'Would update packages/@expo/agent-cli/package.json to 2.0.0',
      'Would commit and push to origin/main',
      'Would dispatch publish.yml on main (package @expo/agent-cli, tag latest)',
    ]);
    expect(io.exit).toHaveBeenCalledWith(0);
  });

  it('should publish @expo/agent-cli from packages/@expo/agent-cli by default', () => {
    const io = createIo(['2.0.0', '--tag', 'next'], {
      'npm view @expo/agent-cli@2.0.0 version': fail('404 Not Found'),
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
      'git status --porcelain': ok(''),
      'git add packages/@expo/agent-cli/package.json': ok(),
      'git commit -m Publish @expo/agent-cli@2.0.0': ok(),
      'git push': ok(),
      [ghDispatch('next', '@expo/agent-cli')]: ok(),
    });

    publish(io);

    expect(io.writes[agentCliPackageJsonPath]).toBe(packageJsonAt('2.0.0'));
    expect(io.runs).toEqual([
      'npm view @expo/agent-cli@2.0.0 version',
      'git rev-parse --abbrev-ref HEAD',
      'git status --porcelain',
      'git add packages/@expo/agent-cli/package.json',
      'git commit -m Publish @expo/agent-cli@2.0.0',
      'git push',
      ghDispatch('next', '@expo/agent-cli'),
    ]);
    expect(io.logs).toEqual([
      'Publishing @expo/agent-cli@2.0.0 with tag next',
      'Pushed @expo/agent-cli@2.0.0 to origin/main',
      'Dispatched publish.yml on main (package @expo/agent-cli, tag next)',
    ]);
    expect(io.exit).toHaveBeenCalledWith(0);
  });

  it('should bump the patch version when version is omitted', () => {
    const io = createIo([], {
      'npm view @expo/agent-cli@1.0.1 version': fail('404 Not Found'),
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
      'git status --porcelain': ok(''),
      'git add packages/@expo/agent-cli/package.json': ok(),
      'git commit -m Publish @expo/agent-cli@1.0.1': ok(),
      'git push': ok(),
      [ghDispatch('latest', '@expo/agent-cli')]: ok(),
    });

    publish(io);

    expect(io.writes[agentCliPackageJsonPath]).toBe(packageJsonAt('1.0.1'));
    expect(io.runs).toEqual([
      'npm view @expo/agent-cli@1.0.1 version',
      'git rev-parse --abbrev-ref HEAD',
      'git status --porcelain',
      'git add packages/@expo/agent-cli/package.json',
      'git commit -m Publish @expo/agent-cli@1.0.1',
      'git push',
      ghDispatch('latest', '@expo/agent-cli'),
    ]);
    expect(io.logs).toEqual([
      'Publishing @expo/agent-cli@1.0.1 with tag latest',
      'Pushed @expo/agent-cli@1.0.1 to origin/main',
      'Dispatched publish.yml on main (package @expo/agent-cli, tag latest)',
    ]);
    expect(io.exit).toHaveBeenCalledWith(0);
  });

  it('should exit 1 when the version is already on npm', () => {
    const io = createIo(['1.0.0'], {
      'npm view @expo/agent-cli@1.0.0 version': ok('1.0.0\n'),
    });

    publish(io);

    expect(io.errors).toEqual(['publish: @expo/agent-cli@1.0.0 is already on npm']);
    expect(io.exit).toHaveBeenCalledWith(1);
    expect(io.writes).toEqual({});
  });

  it('should exit 1 for an unknown package', () => {
    const io = createIo(['--package', 'not-a-package'], {});
    publish(io);
    expect(io.errors).toEqual([
      'publish: unknown package not-a-package (expected expo-agent-cli, @expo/agent-cli)',
    ]);
    expect(io.exit).toHaveBeenCalledWith(1);
    expect(io.runs).toEqual([]);
  });

  it('should exit 1 when the selected package is not in the repo', () => {
    const io = createIo([], {}, {});
    publish(io);
    expect(io.errors).toEqual([
      `publish: cannot read ${agentCliPackageJsonPath} (ENOENT: ${agentCliPackageJsonPath})`,
    ]);
    expect(io.exit).toHaveBeenCalledWith(1);
  });

  it('should exit 1 when the working tree is dirty', () => {
    const io = createIo(['2.0.0'], {
      'npm view @expo/agent-cli@2.0.0 version': fail('404 Not Found'),
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
      'npm view @expo/agent-cli@2.0.0 version': fail('404 Not Found'),
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
      'git status --porcelain': ok(''),
      'git add packages/@expo/agent-cli/package.json': ok(),
      'git commit -m Publish @expo/agent-cli@2.0.0': ok(),
      'git push': ok(),
      [ghDispatch('latest', '@expo/agent-cli')]: fail('cannot find gh'),
    });

    publish(io);

    expect(io.errors).toEqual(['publish: failed to dispatch workflow (cannot find gh)']);
    expect(io.exit).toHaveBeenCalledWith(1);
  });
});
