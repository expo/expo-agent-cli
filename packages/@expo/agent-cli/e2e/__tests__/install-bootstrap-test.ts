// @ref llp/0010-agent-conventions.rfc.md §Forwarded codes, and the exception
//
// A fresh clone has no node_modules, so `expo install` cannot read the SDK. A bare `install` then
// runs the lockfile's frozen install, and a named package is refused until it has.
import fs from 'node:fs';
import path from 'node:path';

import {
  executeAgentCliAsync,
  getTemporaryPath,
  installStubBinAsync,
  pathEnvVars,
  setupFixtureAsync,
  stubExpoEnv,
} from '../utils';

const STUB_PACKAGE_MANAGER = `const fs = require('fs');
fs.appendFileSync(process.env.STUB_PM_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
process.exit(Number(process.env.STUB_PM_EXIT_CODE ?? 0));
`;

/** A go-app copy with no installed `expo`, and stub `npm` and `bun` bins that record each call. */
async function setupUninstalledProjectAsync(lockfile: string) {
  const projectRoot = await setupFixtureAsync('go-app');
  await fs.promises.rm(path.join(projectRoot, 'node_modules', 'expo'), { recursive: true });
  await fs.promises.writeFile(path.join(projectRoot, lockfile), '');

  const binDir = path.join(getTemporaryPath(), 'pm-bin');
  const script = path.join(binDir, 'stub-pm.js');
  await fs.promises.mkdir(binDir, { recursive: true });
  await fs.promises.writeFile(script, STUB_PACKAGE_MANAGER);
  for (const name of ['npm', 'bun']) {
    await installStubBinAsync(binDir, name, script);
  }
  const log = path.join(binDir, 'calls.jsonl');
  const env = {
    ...pathEnvVars(`${binDir}${path.delimiter}${stubExpoEnv(projectRoot).PATH}`),
    STUB_PM_LOG: log,
  };
  const calls = (): { args: string[]; cwd: string }[] =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  return { projectRoot, env, calls };
}

describe('@expo/agent-cli install with no installed dependencies', () => {
  it.each([
    ['package-lock.json', ['npm', 'ci']],
    ['bun.lock', ['bun', 'install', '--frozen-lockfile']],
  ])(`should install %s's dependencies on a bare install`, async (lockfile, argv) => {
    const { projectRoot, env, calls } = await setupUninstalledProjectAsync(lockfile);

    await executeAgentCliAsync(projectRoot, ['install'], { env });

    expect(calls()).toEqual([{ args: argv.slice(1), cwd: fs.realpathSync(projectRoot) }]);
  });

  it(`should exit with the package manager's code when its install fails`, async () => {
    const { projectRoot, env } = await setupUninstalledProjectAsync('package-lock.json');

    const result = await executeAgentCliAsync(projectRoot, ['install'], {
      env: { ...env, STUB_PM_EXIT_CODE: '3' },
      reject: false,
    });

    expect(result.exitCode).toBe(3);
  });

  it(`should refuse a named package and name the bare install`, async () => {
    const { projectRoot, env, calls } = await setupUninstalledProjectAsync('package-lock.json');

    const result = await executeAgentCliAsync(projectRoot, ['install', 'expo-sqlite', '--json'], {
      env,
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: 'DEPENDENCIES_NOT_INSTALLED',
      suggestedCommand: 'npx @expo/agent-cli install',
    });
    expect(calls()).toEqual([]);
  });
});
