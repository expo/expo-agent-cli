// @ref llp/0010-agent-conventions.rfc.md §Forwarded codes, and the exception
//
// A fresh clone has no node_modules, so `expo install` cannot read the SDK. A bare `install` then
// runs the package manager's own install, and a named package is refused until it has.
import fs from 'node:fs';
import path from 'node:path';

import {
  executeAgentCliAsync,
  getTemporaryPath,
  installStubBinAsync,
  isolatedPath,
  pathEnvVars,
  setupFixtureAsync,
  stubExpoEnv,
} from '../utils';
import { INSTALL_DEPENDENCIES_COMMAND } from '../../src/project/expoApp';

// Records each call. A plain `install` writes the lockfile, as npm does. On success it installs an
// expo the way a real install does, unless told not to.
const STUB_PACKAGE_MANAGER = `const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_PM_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const code = Number(process.env.STUB_PM_EXIT_CODE ?? 0);
if (code === 0 && args.join(' ') === 'install') {
  fs.writeFileSync('package-lock.json', '{}');
}
if (code === 0 && !process.env.STUB_PM_SKIP_EXPO) {
  fs.mkdirSync(path.join('node_modules', 'expo'), { recursive: true });
  fs.writeFileSync(path.join('node_modules', 'expo', 'package.json'), '{"name":"expo","version":"54.0.0"}');
}
process.exit(code);
`;

interface UninstalledProjectOptions {
  /** The project's own lockfile, or null for none. */
  lockfile?: string | null;
  /** The directory above the project, with its package.json and its lockfile. */
  parent?: { manifest: object; lockfile: string };
}

/** A go-app copy with no installed `expo`, and a stub `npm` that records each call. */
async function setupUninstalledProjectAsync({
  lockfile = 'package-lock.json',
  parent,
}: UninstalledProjectOptions = {}) {
  const projectRoot = await setupFixtureAsync('go-app');
  await fs.promises.rm(path.join(projectRoot, 'node_modules', 'expo'), { recursive: true });
  if (lockfile) {
    await fs.promises.writeFile(path.join(projectRoot, lockfile), '');
  }
  const parentDir = path.dirname(projectRoot);
  if (parent) {
    await fs.promises.writeFile(
      path.join(parentDir, 'package.json'),
      JSON.stringify(parent.manifest)
    );
    await fs.promises.writeFile(path.join(parentDir, parent.lockfile), '');
  }

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
  return { projectRoot, parentDir: fs.realpathSync.native(parentDir), env, calls };
}

describe('@expo/agent-cli install with no installed dependencies', () => {
  it.each<[string, UninstalledProjectOptions, 'project' | 'parent']>([
    ['its own lockfile', {}, 'project'],
    ['no lockfile', { lockfile: null }, 'project'],
    [
      'the lockfile of the workspace it belongs to',
      {
        lockfile: null,
        parent: { manifest: { workspaces: ['go-app'] }, lockfile: 'package-lock.json' },
      },
      'parent',
    ],
    // An install in the wrong directory deletes that directory's node_modules.
    [
      'a parent lockfile that is not its workspace',
      { lockfile: null, parent: { manifest: { name: 'outer' }, lockfile: 'package-lock.json' } },
      'project',
    ],
  ])(`should install a project with %s`, async (_, options, where) => {
    const { projectRoot, parentDir, env, calls } = await setupUninstalledProjectAsync(options);

    await executeAgentCliAsync(projectRoot, ['install'], { env });

    const cwd = where === 'parent' ? parentDir : fs.realpathSync.native(projectRoot);
    expect(calls()).toEqual([{ args: ['install'], cwd }]);
  });

  it(`should exit with the package manager's code when its install fails`, async () => {
    const { projectRoot, env } = await setupUninstalledProjectAsync();

    const result = await executeAgentCliAsync(projectRoot, ['install'], {
      env: { ...env, STUB_PM_EXIT_CODE: '3' },
      reject: false,
    });

    expect(result.exitCode).toBe(3);
  });

  // A machine without the lockfile's package manager is an ordinary bootstrap failure, in both modes.
  it.each([[['--json']], [[]]])(
    `should name a package manager that is not installed, with %j`,
    async (flags) => {
      const { projectRoot, env } = await setupUninstalledProjectAsync({ lockfile: 'bun.lock' });
      const systemDirs =
        process.platform === 'win32'
          ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')]
          : ['/usr/bin', '/bin'];

      const result = await executeAgentCliAsync(projectRoot, ['install', ...flags], {
        env: { ...env, ...pathEnvVars(isolatedPath([], { systemDirs })) },
        reject: false,
      });

      expect(result.exitCode).toBe(1);
      expect(result.all).toContain('"bun" is not installed on this machine');
      expect(result.all).not.toMatch(/^\s+at /m);
    }
  );

  // @ref llp/0021-honest-reports.rfc.md — a 0 exit that left expo unresolved is not an install.
  it(`should fail, naming the install that ran, when it exits 0 and expo still does not resolve`, async () => {
    const { projectRoot, env } = await setupUninstalledProjectAsync({ lockfile: null });

    const result = await executeAgentCliAsync(projectRoot, ['install', '--json'], {
      env: { ...env, STUB_PM_SKIP_EXPO: '1' },
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    const { error } = JSON.parse(result.stdout);
    expect(error.code).toBe('DEPENDENCIES_NOT_INSTALLED');
    expect(error.message).toContain('"npm install" exited 0');
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
