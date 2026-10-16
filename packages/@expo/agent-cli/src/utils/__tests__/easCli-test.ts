// @ref llp/0015-backend-selection-and-config.rfc.md §Resolving the EAS CLI
//
// Three rungs: the project's pin through the runner, a recent global `eas-cli`, then the runner.
// These tests pin what makes that safe — the project's pin still wins, and no file called `eas` is
// spawned unless it resolves to the `eas-cli` package at a version new enough — plus the one failure
// left, which is a machine with no runner at all.
//
// The claim the design rests on was measured rather than assumed [observed — live, 2026-08-27,
// against a project holding eas-cli 22.4.0 while the registry served 22.6.0]:
//
//   npx --yes eas-cli          -> 22.4.0, and answers against a *dead* registry (no fetch)
//   bunx eas-cli               -> 22.4.0, likewise
//   npx --yes eas-cli   -> 22.6.0: a version in the spec defeats the pin
//
// Which is why the spec is always the bare name.

import { vol } from 'memfs';
import path from 'path';

import {
  easCliArgs,
  easCliInvocation,
  easCliLabel,
  findGlobalEasCli,
  mayDownloadEasCli,
  projectDeclaresEasCli,
  resolveEasCli,
  resolveEasCliOrThrow,
} from '../easCli';
import { CommandError } from '../errors';
import { resetInvokerCache } from '../invoker';
import { resetPackageRunnerCache } from '../packageRunner';

const projectRoot = '/project';
const realPlatform = process.platform;

/** A `PATH` with a package runner on it and no `eas`, which is the machine this rung is for. */
const PATH_WITH_RUNNER = '/usr/local/bin';

/** Environments captured live, the same two `packageRunner-test.ts` pins. */
const NPX_ENV = {
  npm_config_user_agent: 'npm/11.17.0 node/v26.5.0 darwin arm64 workspaces/false',
  npm_execpath: '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
};
const BUNX_ENV = {
  npm_config_user_agent: 'bun/1.3.14 npm/? node/v24.3.0 darwin arm64',
  npm_execpath: '/opt/homebrew/Cellar/bun/1.3.14/bin/bun',
};

function mockPlatform(value: typeof process.platform) {
  Object.defineProperty(process, 'platform', { value });
}

/** A project manifest, with or without an `eas-cli` of its own, and a runner on `PATH`. */
function project(manifest: Record<string, unknown>, extra: Record<string, string> = {}) {
  vol.fromJSON({
    [`${projectRoot}/package.json`]: JSON.stringify(manifest),
    '/usr/local/bin/npx': '#!/bin/sh',
    ...extra,
  });
}

beforeEach(() => {
  mockPlatform('darwin');
  resetInvokerCache();
  resetPackageRunnerCache();
});

afterEach(() => {
  mockPlatform(realPlatform);
  vol.reset();
});

describe(resolveEasCliOrThrow, () => {
  it(`should run eas-cli through npx, without @latest, when the project declares none`, () => {
    // No `@latest`: it made the runner ask the registry on every run, where the bare name lets the
    // runner reuse its cache.
    project({ name: 'app', dependencies: { expo: '~54.0.0' } });

    expect(resolveEasCliOrThrow(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV })).toEqual({
      command: 'npx',
      prefixArgs: ['--yes', 'eas-cli'],
      source: 'npx --yes eas-cli',
      runner: 'npx',
      pinned: false,
      global: false,
    });
  });

  it(`should keep the bare spec when the project pins eas-cli, so the pin wins`, () => {
    // A version in the spec would run 22.6.0 in a project holding 22.4.0, where the bare name runs
    // the project's own copy and touches no network.
    project({ name: 'app', devDependencies: { 'eas-cli': '22.4.0' } });

    expect(resolveEasCliOrThrow(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV })).toEqual({
      command: 'npx',
      prefixArgs: ['--yes', 'eas-cli'],
      source: 'npx --yes eas-cli',
      runner: 'npx',
      pinned: true,
      global: false,
    });
  });

  it(`should read a plain dependency as a pin too`, () => {
    project({ name: 'app', dependencies: { 'eas-cli': '^22.0.0' } });

    expect(
      resolveEasCliOrThrow(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV })
    ).toMatchObject({ prefixArgs: ['--yes', 'eas-cli'], pinned: true });
  });

  it(`should use bunx, without --yes, in a project whose lockfile is bun's`, () => {
    project(
      { name: 'app' },
      { [`${projectRoot}/bun.lock`]: '', '/usr/local/bin/bunx': '#!/bin/sh' }
    );

    expect(resolveEasCliOrThrow(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV })).toEqual({
      command: path.join('/usr/local/bin', 'bunx'),
      prefixArgs: ['eas-cli'],
      source: 'bunx eas-cli',
      runner: 'bunx',
      pinned: false,
      global: false,
    });
  });

  it(`should use bunx when bunx started this process, whatever the lockfile says`, () => {
    project(
      { name: 'app' },
      { [`${projectRoot}/package-lock.json`]: '', '/usr/local/bin/bunx': '#!/bin/sh' }
    );

    expect(
      resolveEasCliOrThrow(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: BUNX_ENV })
    ).toMatchObject({ runner: 'bunx', source: 'bunx eas-cli' });
  });

  it(`should keep npx for a bun project on a machine where bunx is not reachable`, () => {
    project({ name: 'app' }, { [`${projectRoot}/bun.lockb`]: '' });

    expect(
      resolveEasCliOrThrow(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV })
    ).toMatchObject({ runner: 'npx', prefixArgs: ['--yes', 'eas-cli'] });
  });

  it(`should never spawn a file called eas that is not the eas-cli package`, () => {
    // The impostor class: neither of these resolves to the `eas-cli` package, so neither is
    // spawned. Before wave 18 the first won, and a shim in the second was spawned and quoted.
    project(
      { name: 'app' },
      {
        [`${projectRoot}/node_modules/.bin/eas`]: '#!/bin/sh',
        '/usr/local/bin/eas': '#!/bin/sh',
      }
    );

    const resolved = resolveEasCliOrThrow(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV });

    expect(resolved.command).toBe('npx');
    expect(resolved.source).not.toContain('/eas');
  });

  it(`should throw a prompt the agent can act on only when no runner is reachable`, () => {
    // Errors are prompts (llp/0006). Not an install line for eas-cli: this CLI would have run the
    // published one, so what is broken is the Node install under it.
    vol.fromJSON({ [`${projectRoot}/package.json`]: '{}' });
    expect.assertions(6);
    try {
      resolveEasCliOrThrow(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV });
    } catch (error: any) {
      expect(error).toBeInstanceOf(CommandError);
      expect(error.code).toBe('EAS_CLI_MISSING');
      expect(error.message).toContain('no package runner');
      expect(error.message).toContain('on PATH');
      expect(error.message).not.toContain('npm install');
      expect(error.suggestedCommand).toBeUndefined();
    }
  });
});

/** A global `eas-cli` the way npm leaves one: a bin symlinked into the package's own directory. */
function globalEasCli(version: string, { name = 'eas-cli', binDir = '/usr/local/bin' } = {}) {
  const packageDir = path.join(binDir, '..', 'lib', 'node_modules', name);
  vol.fromJSON(
    {
      [`${packageDir}/package.json`]: JSON.stringify({ name, version, bin: { eas: 'bin/run' } }),
      [`${packageDir}/bin/run`]: '#!/usr/bin/env node',
    },
    '/'
  );
  vol.mkdirSync(binDir, { recursive: true });
  vol.symlinkSync(`${packageDir}/bin/run`, `${binDir}/eas`);
}

describe(findGlobalEasCli, () => {
  it(`should take a global eas-cli at 25.0.0 or newer, and spawn it without a runner`, () => {
    project({ name: 'app' });
    globalEasCli('25.0.0');

    expect(resolveEasCliOrThrow(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV })).toEqual({
      command: '/usr/local/bin/eas',
      prefixArgs: [],
      source: 'eas',
      runner: 'npx',
      pinned: false,
      global: true,
    });
  });

  it(`should pass over a global eas-cli older than 25.0.0 for the runner`, () => {
    project({ name: 'app' });
    globalEasCli('24.9.1');

    expect(findGlobalEasCli({ pathEnv: PATH_WITH_RUNNER })).toBeNull();
    expect(
      resolveEasCliOrThrow(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV })
    ).toMatchObject({ command: 'npx', prefixArgs: ['--yes', 'eas-cli'], global: false });
  });

  it(`should pass over a bin that resolves to a package that is not eas-cli`, () => {
    project({ name: 'app' });
    globalEasCli('30.0.0', { name: 'not-eas-cli' });

    expect(findGlobalEasCli({ pathEnv: PATH_WITH_RUNNER })).toBeNull();
  });

  it(`should read only the first eas on PATH, the one the reader's shell runs`, () => {
    project({ name: 'app' });
    globalEasCli('22.0.0', { binDir: '/opt/old/bin' });
    globalEasCli('25.1.0');

    expect(findGlobalEasCli({ pathEnv: `/opt/old/bin${path.delimiter}/usr/local/bin` })).toBeNull();
    expect(findGlobalEasCli({ pathEnv: `/usr/local/bin${path.delimiter}/opt/old/bin` })).toBe(
      '/usr/local/bin/eas'
    );
  });

  it(`should leave a project's pin to win over a global install`, () => {
    project({ name: 'app', devDependencies: { 'eas-cli': '22.4.0' } });
    globalEasCli('25.1.0');

    expect(
      resolveEasCliOrThrow(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV })
    ).toMatchObject({
      command: 'npx',
      prefixArgs: ['--yes', 'eas-cli'],
      pinned: true,
      global: false,
    });
  });

  it(`should never count a global install as a download`, () => {
    project({ name: 'app' });
    globalEasCli('25.1.0');

    expect(
      mayDownloadEasCli(resolveEasCli(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV }))
    ).toBe(false);
  });

  it(`should answer the global install even with no runner on PATH`, () => {
    vol.fromJSON({ [`${projectRoot}/package.json`]: '{}' });
    globalEasCli('25.1.0');

    expect(resolveEasCli(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV })).toMatchObject({
      command: '/usr/local/bin/eas',
      global: true,
    });
  });
});

describe(resolveEasCli, () => {
  it(`should answer null when no runner is on PATH, and the invocation regardless`, () => {
    vol.fromJSON({ [`${projectRoot}/package.json`]: '{}' });

    expect(resolveEasCli(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV })).toBeNull();
    // `easCliInvocation` does not gate: the auth passthrough always has to answer with something to
    // spawn, and the runner's own ENOENT is a truer sentence than a guess.
    expect(
      easCliInvocation(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV })
    ).toMatchObject({ command: 'npx' });
  });
});

describe(projectDeclaresEasCli, () => {
  it(`should read "does not declare it" out of every unreadable manifest`, () => {
    // Never throws: the cost of a broken manifest is the pin, never the command.
    expect(projectDeclaresEasCli(projectRoot)).toBe(false);
    vol.fromJSON({ [`${projectRoot}/package.json`]: 'not json' });
    expect(projectDeclaresEasCli(projectRoot)).toBe(false);
    vol.reset();
    vol.fromJSON({ [`${projectRoot}/package.json`]: '[]' });
    expect(projectDeclaresEasCli(projectRoot)).toBe(false);
  });
});

describe(mayDownloadEasCli, () => {
  it(`should be true only for a project with no eas-cli of its own`, () => {
    project({ name: 'app' });
    expect(
      mayDownloadEasCli(resolveEasCli(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV }))
    ).toBe(true);

    vol.reset();
    project({ name: 'app', devDependencies: { 'eas-cli': '22.4.0' } });
    expect(
      mayDownloadEasCli(resolveEasCli(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV }))
    ).toBe(false);

    expect(mayDownloadEasCli(null)).toBe(false);
  });
});

describe(easCliLabel, () => {
  it(`should name the runner and the spec, never the path the runner was found at`, () => {
    project(
      { name: 'app' },
      { '/usr/local/bin/bunx': '#!/bin/sh', [`${projectRoot}/bun.lock`]: '' }
    );

    const easCli = resolveEasCliOrThrow(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV });

    expect(easCli.command).toBe(path.join('/usr/local/bin', 'bunx'));
    expect(easCliLabel(easCli)).toBe('bunx eas-cli');
  });
});

describe(easCliArgs, () => {
  it(`should put the runner's flags and the package spec before the eas command word`, () => {
    project({ name: 'app' });

    const easCli = resolveEasCliOrThrow(projectRoot, { pathEnv: PATH_WITH_RUNNER, env: NPX_ENV });

    expect(easCliArgs(easCli, ['build:list', '--json'])).toEqual([
      '--yes',
      'eas-cli',
      'build:list',
      '--json',
    ]);
  });
});
