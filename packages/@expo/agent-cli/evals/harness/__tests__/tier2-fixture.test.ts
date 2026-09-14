import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertBrokenBaseline, isolatedEnvironment } from '../../tier2/fixture-tools.mjs';

const proc = { exitCode: 1, signal: null, timedOut: false, spawnError: null, pid: 123 };
it('accepts only the intended Metro module resolution failure', () => {
  expect(() =>
    assertBrokenBaseline(
      proc,
      'Error: Unable to resolve module ./src/total from /tmp/cart/App.js:\nNone of these files exist:'
    )
  ).not.toThrow();
  expect(() =>
    assertBrokenBaseline(proc, 'Unable to resolve "./src/total" from "App.js"')
  ).not.toThrow();
  for (const log of [
    'Command referenced src/total but failed with EACCES',
    'Unable to resolve "react" from "App.js"',
    'Unable to resolve "./src/total" from "Other.js"',
  ]) {
    expect(() => assertBrokenBaseline(proc, log)).toThrow();
  }
  for (const patch of [
    { exitCode: 0 },
    { exitCode: null },
    { signal: 'SIGKILL' },
    { timedOut: true },
    { spawnError: 'ENOENT' },
  ]) {
    expect(() =>
      assertBrokenBaseline({ ...proc, ...patch }, 'Unable to resolve "./src/total" from "App.js"')
    ).toThrow();
  }
});
it('isolates home and strips ambient account/agent settings', () => {
  const env = isolatedEnvironment('/scratch/run/home', {
    HOME: '/real/home',
    PATH: '/usr/bin',
    LANG: 'en_US.UTF-8',
    EXPO_TOKEN: 'secret',
    ANTHROPIC_API_KEY: 'secret',
    CODEX_HOME: '/real/codex',
    XDG_CONFIG_HOME: '/real/config',
    CLAUDE_CONFIG_DIR: '/real/claude',
    npm_config_user_agent: 'bun',
  });
  expect(env.HOME).toBe('/scratch/run/home');
  expect(env.XDG_CONFIG_HOME).toBe('/scratch/run/home/.config');
  expect(env.PATH).toBe('/usr/bin');
  for (const key of [
    'EXPO_TOKEN',
    'ANTHROPIC_API_KEY',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'npm_config_user_agent',
  ])
    expect(env).not.toHaveProperty(key);
});
it('ships an exact SDK57 dependency graph including the web runtime and integrity hashes', () => {
  const fixture = pathToFileURL(resolve(__dirname, '../../tier2/fixture') + '/');
  const pkg = JSON.parse(readFileSync(new URL('package.json', fixture), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', fixture), 'utf8'));
  expect(pkg.dependencies).toEqual({
    '@expo/metro-runtime': '57.0.15',
    expo: '57.0.19',
    react: '19.2.3',
    'react-dom': '19.2.3',
    'react-native': '0.86.3',
    'react-native-web': '0.21.2',
  });
  expect(lock.lockfileVersion).toBe(3);
  expect(lock.packages[''].dependencies).toEqual(pkg.dependencies);
  for (const [name, version] of Object.entries(pkg.dependencies))
    expect(lock.packages[`node_modules/${name}`].version).toBe(version);
  for (const [name, pkg] of Object.entries(lock.packages) as [
    string,
    { integrity?: string; resolved?: string },
  ][]) {
    if (!name) continue;
    expect(pkg.integrity, name).toMatch(/^sha512-/);
    expect(pkg.resolved, name).toMatch(/^https:\/\/registry\.npmjs\.org\//);
  }
});
