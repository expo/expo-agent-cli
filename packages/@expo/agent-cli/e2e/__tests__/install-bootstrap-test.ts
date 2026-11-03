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
import { INSTALL_DEPENDENCIES_COMMAND } from '../../src/project/dependencies';

const STUB_PACKAGE_MANAGER = `const fs = require('fs');
fs.appendFileSync(process.env.STUB_PM_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
process.exit(Number(process.env.STUB_PM_EXIT_CODE ?? 0));
`;

/** A go-app copy with an npm lockfile, no installed `expo`, and a stub `npm` that records each call. */
async function setupUninstalledProjectAsync() {
  const projectRoot = await setupFixtureAsync('go-app');
  await fs.promises.rm(path.join(projectRoot, 'node_modules', 'expo'), { recursive: true });
  await fs.promises.writeFile(path.join(projectRoot, 'package-lock.json'), '');

  const binDir = path.join(getTemporaryPath(), 'pm-bin');
  const script = path.join(binDir, 'stub-pm.js');
  await fs.promises.mkdir(binDir, { recursive: true });
  await fs.promises.writeFile(script, STUB_PACKAGE_MANAGER);
  await installStubBinAsync(binDir, 'npm', script);
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
  // Which command each lockfile gets is the `lockfileInstall` table's unit test; this proves the run.
  it(`should run the lockfile's install in its directory on a bare install`, async () => {
    const { projectRoot, env, calls } = await setupUninstalledProjectAsync();

    await executeAgentCliAsync(projectRoot, ['install'], { env });

    expect(calls()).toEqual([{ args: ['ci'], cwd: fs.realpathSync(projectRoot) }]);
  });

  it(`should exit with the package manager's code when its install fails`, async () => {
    const { projectRoot, env } = await setupUninstalledProjectAsync();

    const result = await executeAgentCliAsync(projectRoot, ['install'], {
      env: { ...env, STUB_PM_EXIT_CODE: '3' },
      reject: false,
    });

    expect(result.exitCode).toBe(3);
  });

  it.each([[['expo-sqlite']], [['--check']], [['--fix']], [['--', '--verbose']]])(
    `should refuse %j, which needs expo install, and name the bare install`,
    async (args) => {
      const { projectRoot, env, calls } = await setupUninstalledProjectAsync();

      const result = await executeAgentCliAsync(projectRoot, ['install', '--json', ...args], {
        env,
        reject: false,
      });

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error).toMatchObject({
        code: 'DEPENDENCIES_NOT_INSTALLED',
        suggestedCommand: INSTALL_DEPENDENCIES_COMMAND,
      });
      expect(calls()).toEqual([]);
    }
  );
});
