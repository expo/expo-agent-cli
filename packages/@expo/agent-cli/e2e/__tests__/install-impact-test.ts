// @ref llp/0004-smart-start-and-project-state.rfc.md §Sub-features — post-install impact.
//
// N2-66: in a project that builds its own runtime, `install expo-file-system` said the app could
// not load it and asked for a new build. `expo` already depends on it, so autolinking had it in
// the build. The fixture copy gets that package in `node_modules` and not in `package.json`, and
// a stub `expo install` that adds it to `package.json` the way the real one does.
import fs from 'node:fs';
import path from 'node:path';

import {
  executeAgentCliAsync,
  installStubFingerprintAsync,
  readStubFingerprintInvocations,
  setupFixtureAsync,
} from '../utils';

const NATIVE_PACKAGE = 'expo-file-system';
const JS_PACKAGE = 'lodash';
const LAST_BUILD = '.expo/agent-cli-last-build.json';

const STUB_EXPO_INSTALL = `
const fs = require('node:fs');
const path = require('node:path');
const [command, name] = process.argv.slice(2);
if (command === 'install' && name) {
  const manifestPath = path.join(process.cwd(), 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.dependencies[name] = '1.0.0';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n');
}
`;

async function setupProjectAsync(): Promise<string> {
  const projectRoot = await setupFixtureAsync('dev-client-fresh-app');
  await installStubFingerprintAsync(projectRoot);
  fs.writeFileSync(path.join(projectRoot, 'node_modules/expo/bin/cli'), STUB_EXPO_INSTALL);
  for (const [name, files] of [
    [NATIVE_PACKAGE, { 'expo-module.config.json': '{"platforms":["apple","android"]}' }],
    [JS_PACKAGE, {}],
  ] as const) {
    const packageRoot = path.join(projectRoot, 'node_modules', name);
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      `{"name":"${name}","version":"1.0.0"}`
    );
    for (const [file, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(packageRoot, file), contents);
    }
  }
  return projectRoot;
}

async function installAsync(projectRoot: string, name: string, env: NodeJS.ProcessEnv = {}) {
  const result = await executeAgentCliAsync(projectRoot, ['install', name, '--json'], { env });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout);
}

describe('@expo/agent-cli install, a native package in a project with a development build', () => {
  it.each([
    {
      name: 'the fingerprint matches the last recorded build',
      env: {},
      impact: { action: 'reload', fingerprint: 'unchanged', lastBuild: 'current' },
      followup: 'reload-app',
    },
    {
      // The stub hashes package.json, and `expo install` adds the package to it.
      name: 'the install changed the fingerprint',
      env: { STUB_FINGERPRINT_HASH_FROM_PROJECT: '1' },
      impact: { action: 'prebuild-and-build', fingerprint: 'changed' },
      followup: 'dev',
    },
    {
      name: 'the fingerprint did not change but the recorded build is stale',
      lastBuild: { ios: 'f00dbeef00000000000000000000000000000000' },
      env: {},
      impact: { action: 'prebuild-and-build', fingerprint: 'unchanged', lastBuild: 'stale' },
      followup: 'dev',
    },
    {
      name: 'the fingerprint did not change and no build is recorded',
      lastBuild: null,
      env: {},
      impact: { action: 'reload', fingerprint: 'unchanged' },
      followup: 'reload-app',
    },
  ])('answers $impact.action when $name', async ({ lastBuild, env, impact, followup }) => {
    const projectRoot = await setupProjectAsync();
    if (lastBuild === null) {
      fs.rmSync(path.join(projectRoot, LAST_BUILD));
    } else if (lastBuild) {
      fs.writeFileSync(path.join(projectRoot, LAST_BUILD), JSON.stringify(lastBuild));
    }

    const report = await installAsync(projectRoot, NATIVE_PACKAGE, env);

    expect(report.impact).toEqual([
      expect.objectContaining({ packageName: NATIVE_PACKAGE, impact: 'native-module', ...impact }),
    ]);
    expect(report.impact[0].lastBuild).toBe(impact.lastBuild);
    expect(report.followups[0].id).toBe(followup);
    // Two measurements: the post-install side is never answered from a cache.
    expect(readStubFingerprintInvocations(projectRoot)).toHaveLength(2);
  });

  it('measures the fingerprint only before a JavaScript-only install', async () => {
    const projectRoot = await setupProjectAsync();

    const report = await installAsync(projectRoot, JS_PACKAGE);

    expect(report.impact[0]).toMatchObject({ impact: 'js-only', action: 'reload' });
    expect(report.impact[0].fingerprint).toBeUndefined();
    expect(readStubFingerprintInvocations(projectRoot)).toHaveLength(1);
  });
});
