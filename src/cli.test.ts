import { describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readAliasVersion } from './readAliasVersion';
import { canonicalSpec, resolveNpxRunner, resolveRunner } from './resolveRunner';
import { run } from './run';
import { resolveSpawnTarget } from './windowsShim';

const version = (
  JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

describe('canonicalSpec', () => {
  it('should request the target at or below the alias version', () => {
    expect(canonicalSpec('1.0.2')).toBe('@expo/agent-cli@<=1.0.2');
  });
});

describe('resolveRunner', () => {
  it('should run bunx with an explicit package and bin under bun', () => {
    expect(resolveRunner({ userAgent: 'bun/1.2.0 npm/? bunx/1.2.0' }, '2.0.0', ['status'])).toEqual({
      command: 'bunx',
      args: ['--package', '@expo/agent-cli@<=2.0.0', 'expo-agent-cli', 'status'],
    });
  });

  it('should run pnpm dlx with an explicit package and bin under pnpm', () => {
    expect(
      resolveRunner({ userAgent: 'pnpm/10.0.0 npm/? node/v22.0.0' }, '2.0.0', ['dev', '--json'])
    ).toEqual({
      command: 'pnpm',
      args: ['--package', '@expo/agent-cli@<=2.0.0', 'dlx', 'expo-agent-cli', 'dev', '--json'],
    });
  });

  it('should run yarn dlx with an explicit package and bin under yarn berry', () => {
    expect(resolveRunner({ userAgent: 'yarn/4.0.0 npm/? node/v22.0.0' }, '2.0.0', [])).toEqual({
      command: 'yarn',
      args: ['dlx', '--package', '@expo/agent-cli@<=2.0.0', 'expo-agent-cli'],
    });
  });

  it('should run npx with an explicit package and bin under npm', () => {
    expect(resolveRunner({ userAgent: 'npm/10.0.0 node/v22.0.0' }, '2.0.0', ['--help'])).toEqual({
      command: 'npx',
      args: ['--yes', '--package=@expo/agent-cli@<=2.0.0', '--', 'expo-agent-cli', '--help'],
    });
  });

  it('should default to npx when the user agent is missing', () => {
    expect(resolveRunner({}, '1.0.0', ['status'])).toEqual({
      command: 'npx',
      args: ['--yes', '--package=@expo/agent-cli@<=1.0.0', '--', 'expo-agent-cli', 'status'],
    });
  });

  it('should fall back to npx under yarn classic', () => {
    expect(
      resolveRunner({ userAgent: 'yarn/1.22.19 npm/? node/v16.13.1' }, '2.0.0', ['status'])
    ).toEqual(resolveNpxRunner('2.0.0', ['status']));
  });

  it('should run bunx when the process is bun even without a user agent', () => {
    expect(resolveRunner({ bunRuntime: true }, '2.0.0', [])).toEqual({
      command: 'bunx',
      args: ['--package', '@expo/agent-cli@<=2.0.0', 'expo-agent-cli'],
    });
  });

  it('should run bunx when npm_execpath is the bun binary', () => {
    expect(
      resolveRunner({ execPath: '/opt/homebrew/Cellar/bun/1.3.14/bin/bun' }, '2.0.0', [])
    ).toEqual({
      command: 'bunx',
      args: ['--package', '@expo/agent-cli@<=2.0.0', 'expo-agent-cli'],
    });
  });

  it('should run bunx when npm_execpath is bun.exe', () => {
    expect(resolveRunner({ execPath: 'C:\\Users\\me\\.bun\\bin\\bun.exe' }, '2.0.0', [])).toEqual({
      command: 'bunx',
      args: ['--package', '@expo/agent-cli@<=2.0.0', 'expo-agent-cli'],
    });
  });

  it('should run pnpm when npm_execpath is pnpm.cjs', () => {
    expect(
      resolveRunner({ execPath: '/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs' }, '2.0.0', [])
    ).toEqual({
      command: 'pnpm',
      args: ['--package', '@expo/agent-cli@<=2.0.0', 'dlx', 'expo-agent-cli'],
    });
  });

  it('should not treat bunyan as bun', () => {
    expect(resolveRunner({ execPath: '/usr/local/bin/bunyan' }, '1.0.0', ['status'])).toEqual(
      resolveNpxRunner('1.0.0', ['status'])
    );
  });

  it('should ignore bun mentioned later in an npm user agent', () => {
    expect(
      resolveRunner({ userAgent: 'npm/10.0.0 node/v22.0.0 bun/false' }, '1.0.0', [])
    ).toEqual(resolveNpxRunner('1.0.0', []));
  });
});

describe('readAliasVersion', () => {
  it('should read the version from the package next to this module', () => {
    expect(readAliasVersion()).toBe(version);
  });

  it('should read the version from the package next to the bundled bin', () => {
    expect(readAliasVersion(path.join(import.meta.dir, '..', 'bin', 'cli.js'))).toBe(version);
  });

  it('should throw a short error when the entry path cannot be resolved', () => {
    expect(() =>
      readAliasVersion(path.join(os.tmpdir(), 'expo-agent-cli-missing', 'cli.js'))
    ).toThrow(/cannot resolve package\.json/);
  });

  it('should throw a short error when package.json is not json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-agent-cli-'));
    try {
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'cli.js'), '');
      fs.writeFileSync(path.join(root, 'package.json'), '{');
      expect(() => readAliasVersion(path.join(bin, 'cli.js'))).toThrow(/cannot read version/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('should throw when version is missing or empty', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-agent-cli-'));
    try {
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'cli.js'), '');
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '' }));
      expect(() => readAliasVersion(path.join(bin, 'cli.js'))).toThrow(/missing version/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveSpawnTarget', () => {
  it('should spawn the command as-is on posix', () => {
    expect(resolveSpawnTarget('npx', ['--yes', 'expo-agent-cli'], 'darwin')).toEqual({
      command: 'npx',
      args: ['--yes', 'expo-agent-cli'],
      shell: false,
    });
  });

  it('should not give a shell to a .cmd file on posix', () => {
    expect(resolveSpawnTarget('/project/weird.cmd', ['run'], 'darwin')).toEqual({
      command: '/project/weird.cmd',
      args: ['run'],
      shell: false,
    });
  });

  it('should run a .cmd shim through a shell on windows', () => {
    expect(resolveSpawnTarget('C:\\bin\\npx.cmd', ['status'], 'win32')).toEqual({
      command: '"C:\\bin\\npx.cmd"',
      args: ['^"status^"'],
      shell: true,
    });
  });

  it('should caret-escape cmd metacharacters in user argv on windows', () => {
    expect(resolveSpawnTarget('C:\\bin\\npx.cmd', ['status', 'a&b'], 'win32').args).toEqual([
      '^"status^"',
      '^"a^&b^"',
    ]);
  });

  it('should caret-escape the version range on windows', () => {
    expect(
      resolveSpawnTarget('C:\\bin\\npx.cmd', [`--package=${canonicalSpec('1.0.2')}`], 'win32').args
    ).toEqual(['^"--package=@expo/agent-cli@^<=1.0.2^"']);
  });

  it('should spawn a real executable without a shell on windows', () => {
    expect(resolveSpawnTarget('C:\\Program Files\\nodejs\\node.exe', ['-v'], 'win32')).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['-v'],
      shell: false,
    });
  });
});

describe('run', () => {
  it('should exit 0 when the child exits 0', () => {
    const child = new EventEmitter();
    const spawnFn = mock(() => child);
    const exit = mock(() => {});
    run({ npm_config_user_agent: 'npm/10.0.0 node/v22.0.0' }, ['status'], {
      spawn: spawnFn as unknown as typeof import('node:child_process').spawn,
      bunRuntime: false,
      exit,
      kill: mock(() => {}),
      error: mock(() => {}),
      pid: 123,
      platform: 'darwin',
    });
    child.emit('exit', 0, null);
    expect(exit).toHaveBeenCalledWith(0);
    expect(spawnFn).toHaveBeenCalledWith(
      'npx',
      ['--yes', `--package=${canonicalSpec(version)}`, '--', 'expo-agent-cli', 'status'],
      { stdio: 'inherit', shell: false }
    );
  });

  it('should exit with the child code when the child fails', () => {
    const child = new EventEmitter();
    const exit = mock(() => {});
    run({ npm_config_user_agent: 'npm/10.0.0' }, [], {
      spawn: mock(() => child) as unknown as typeof import('node:child_process').spawn,
      bunRuntime: false,
      exit,
      kill: mock(() => {}),
      error: mock(() => {}),
      pid: 123,
      platform: 'darwin',
    });
    child.emit('exit', 2, null);
    expect(exit).toHaveBeenCalledWith(2);
  });

  it('should re-raise the child signal', () => {
    const child = new EventEmitter();
    const kill = mock(() => {});
    run({ npm_config_user_agent: 'npm/10.0.0' }, [], {
      spawn: mock(() => child) as unknown as typeof import('node:child_process').spawn,
      bunRuntime: false,
      exit: mock(() => {}),
      kill,
      error: mock(() => {}),
      pid: 123,
      platform: 'darwin',
    });
    child.emit('exit', null, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(123, 'SIGTERM');
  });

  it('should fall back to npx when the chosen runner is missing', () => {
    const missing = new EventEmitter();
    const fallback = new EventEmitter();
    const spawnFn = mock((command: string) => (command === 'bunx' ? missing : fallback));
    const error = mock(() => {});
    const exit = mock(() => {});
    run({ npm_config_user_agent: 'bun/1.2.0 npm/? bunx/1.2.0' }, ['status'], {
      spawn: spawnFn as unknown as typeof import('node:child_process').spawn,
      bunRuntime: false,
      exit,
      kill: mock(() => {}),
      error,
      pid: 123,
      platform: 'darwin',
    });
    const err = new Error('spawn bunx ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    missing.emit('error', err);
    fallback.emit('exit', 0, null);
    expect(error).toHaveBeenCalledWith('expo-agent-cli: cannot find bunx; falling back to npx');
    expect(spawnFn).toHaveBeenNthCalledWith(
      2,
      'npx',
      ['--yes', `--package=${canonicalSpec(version)}`, '--', 'expo-agent-cli', 'status'],
      { stdio: 'inherit', shell: false }
    );
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('should print the spawn error when npx is missing', () => {
    const missing = new EventEmitter();
    const error = mock(() => {});
    const exit = mock(() => {});
    run({ npm_config_user_agent: 'npm/10.0.0' }, [], {
      spawn: mock(() => missing) as unknown as typeof import('node:child_process').spawn,
      bunRuntime: false,
      exit,
      kill: mock(() => {}),
      error,
      pid: 123,
      platform: 'darwin',
    });
    const err = new Error('spawn npx ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    missing.emit('error', err);
    expect(error).toHaveBeenCalledWith('spawn npx ENOENT');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('should spawn the windows .cmd shim through a shell', () => {
    const child = new EventEmitter();
    const spawnFn = mock(() => child);
    const npx = resolveNpxRunner(version, ['status']);
    const target = resolveSpawnTarget(`${npx.command}.cmd`, npx.args, 'win32');
    run({ npm_config_user_agent: 'npm/10.0.0' }, ['status'], {
      spawn: spawnFn as unknown as typeof import('node:child_process').spawn,
      bunRuntime: false,
      exit: mock(() => {}),
      kill: mock(() => {}),
      error: mock(() => {}),
      pid: 123,
      platform: 'win32',
    });
    expect(spawnFn).toHaveBeenCalledWith(target.command, target.args, {
      stdio: 'inherit',
      shell: true,
    });
  });
});
