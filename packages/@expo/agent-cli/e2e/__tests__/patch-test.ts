// @ref llp/0037-patch-command.rfc.md
//
// `patch` driven through the published bin against **real** package managers, because the property
// under test is the boundary: the patch file each manager writes, the registration it reads, and
// that a fresh install applies the patch again. A stub would only prove the argv.
//
// The two packages are packed from `fixtures/patch-packages` into local tarballs and installed as
// `file:` dependencies. bun, pnpm, yarn 1 and yarn 4 are installed from the npm registry at pinned
// versions into a cache directory before their tests, so they run on every machine and on CI.
// bun installs with `--backend=copyfile` so the edit in place is the same
// on Linux CI (whose default is hard links) as on macOS; the hard-link case has a test of its own.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { executeAgentCliAsync, fixturesDir, getTemporaryPath, TEMP_DIR } from '../utils';

const isWindows = process.platform === 'win32';

type Manager = 'bun' | 'pnpm' | 'npm' | 'yarn1' | 'yarn4';

/** The npm package and version that provides each installed manager. npm comes with node. */
const PINNED: Partial<Record<Manager, string>> = {
  // Not the runner's bun: bun 1.3.14 crashes in `bun patch --commit` for a `file:` package.
  bun: 'bun@1.4.4',
  pnpm: 'pnpm@12.2.1',
  yarn1: 'yarn@1.22.22',
  yarn4: '@yarnpkg/cli-dist@4.18.1',
};

const INSTALL: Record<Manager, string[]> = {
  bun: ['install', '--backend=copyfile'],
  pnpm: ['install', '--config.package-import-method=copy'],
  npm: ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
  yarn1: ['install', '--ignore-scripts', '--non-interactive'],
  // yarn 4 turns on `--immutable` under CI=1, and the first install writes the lockfile.
  yarn4: ['install', '--no-immutable'],
};

/** The command a manager runs as. */
function commandOf(manager: Manager): string {
  return manager.startsWith('yarn') ? 'yarn' : manager;
}

/** PATH with the pinned manager's bin directory first, or the runner's own PATH. */
const pathFor: Partial<Record<Manager, string>> = {};

function envFor(manager: Manager): NodeJS.ProcessEnv {
  const { npm_config_minimum_release_age, ...env } = process.env;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const bin = pathFor[manager];
  return bin ? { ...env, [pathKey]: `${bin}${path.delimiter}${env[pathKey] ?? ''}` } : env;
}

/** Install the pinned manager once per machine, and put it first on PATH for its tests. */
function usePinnedManager(manager: Manager): void {
  beforeAll(() => {
    const spec = PINNED[manager]!;
    const prefix = path.join(
      TEMP_DIR,
      'agent-cli-e2e-package-managers',
      spec.replace(/[@/]/g, '_')
    );
    const bin = path.join(prefix, 'node_modules', '.bin');
    if (
      !fs.existsSync(path.join(bin, isWindows ? `${commandOf(manager)}.cmd` : commandOf(manager)))
    ) {
      fs.mkdirSync(prefix, { recursive: true });
      run(
        'npm',
        ['install', '--prefix', prefix, '--no-save', '--no-audit', '--no-fund', spec],
        prefix,
        'npm'
      );
    }
    pathFor[manager] = bin;
  }, 180_000);
}

function run(command: string, args: string[], cwd: string, manager?: Manager): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: isWindows,
    env: manager ? envFor(manager) : undefined,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.status}:\n${result.stdout}\n${
        result.stderr
      }`
    );
  }
  return result.stdout;
}

/** `patch <args>` in the project, with the manager's PATH. */
function patchAsync(manager: Manager, projectRoot: string, args: string[], reject = true) {
  return executeAgentCliAsync(projectRoot, ['patch', ...args], { env: envFor(manager), reject });
}

/** A project with the two fake packages installed by `manager`. */
async function setupProjectAsync(
  manager: Manager,
  installArgs = INSTALL[manager]
): Promise<string> {
  const projectRoot = path.join(getTemporaryPath(), `patch-${manager}`);
  fs.mkdirSync(projectRoot, { recursive: true });
  for (const name of ['fake-expo-module', 'fake-js-lib']) {
    run(
      'npm',
      ['pack', path.join(fixturesDir, 'patch-packages', name), '--pack-destination', projectRoot],
      projectRoot
    );
  }
  if (manager === 'yarn4') {
    // Expo needs a node_modules tree; yarn 4 makes Plug'n'Play by default.
    fs.writeFileSync(
      path.join(projectRoot, '.yarnrc.yml'),
      'nodeLinker: node-modules\nenableTelemetry: false\n'
    );
  }
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'patch-app',
        version: '1.0.0',
        private: true,
        dependencies: {
          'fake-expo-module': 'file:./fake-expo-module-1.0.0.tgz',
          'fake-js-lib': 'file:./fake-js-lib-2.1.0.tgz',
        },
      },
      null,
      2
    ) + '\n'
  );
  run(commandOf(manager), installArgs, projectRoot, manager);
  return projectRoot;
}

function edit(projectRoot: string, file: string, append: string): void {
  fs.appendFileSync(path.join(projectRoot, 'node_modules', file), append);
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Delete node_modules and install again, which is what has to bring the patch back. */
function reinstall(projectRoot: string, manager: Manager): void {
  fs.rmSync(path.join(projectRoot, 'node_modules'), { recursive: true, force: true });
  run(commandOf(manager), INSTALL[manager], projectRoot, manager);
}

describe('@expo/agent-cli patch — bun', () => {
  usePinnedManager('bun');

  it(`saves a JavaScript edit with bun's own patch, and a fresh install applies it`, async () => {
    const projectRoot = await setupProjectAsync('bun');
    edit(projectRoot, 'fake-js-lib/index.js', '// patched by e2e\n');

    const result = await patchAsync('bun', projectRoot, ['fake-js-lib', '--json']);
    const report = JSON.parse(result.stdout);

    expect(report).toMatchObject({
      packageManager: 'bun',
      package: 'fake-js-lib',
      version: '2.1.0',
      status: 'saved',
      files: ['index.js'],
      native: [],
      buildFromSource: [],
    });
    expect(path.dirname(fs.realpathSync.native(report.patchFile))).toBe(
      path.join(fs.realpathSync.native(projectRoot), 'patches')
    );
    expect(fs.readFileSync(report.patchFile, 'utf8')).toContain('+// patched by e2e');
    expect(
      Object.keys(readJson(path.join(projectRoot, 'package.json')).patchedDependencies)
    ).toEqual([expect.stringMatching(/^fake-js-lib@/)]);
    expect(report.followups.map((f: { id: string }) => f.id)).toEqual(['reload-app']);

    reinstall(projectRoot, 'bun');
    expect(
      fs.readFileSync(path.join(projectRoot, 'node_modules/fake-js-lib/index.js'), 'utf8')
    ).toContain('// patched by e2e');
  });

  it(`builds a natively patched Expo module from source, for the platform the patch touches`, async () => {
    const projectRoot = await setupProjectAsync('bun');
    edit(projectRoot, 'fake-expo-module/ios/FakeModule.swift', '// fix\n');

    const result = await patchAsync('bun', projectRoot, ['fake-expo-module', '--json']);
    const report = JSON.parse(result.stdout);

    expect(report).toMatchObject({
      status: 'saved',
      files: ['ios/FakeModule.swift'],
      native: ['ios'],
      buildFromSource: [{ platform: 'ios', added: ['fake-expo-module'] }],
    });
    const pkg = readJson(path.join(projectRoot, 'package.json'));
    expect(pkg.expo.autolinking).toEqual({ ios: { buildFromSource: ['fake-expo-module'] } });
    expect(report.followups.map((f: { id: string }) => f.id)).toEqual(['dev']);
  });

  it(`keeps an existing buildFromSource entry that already covers the module`, async () => {
    const projectRoot = await setupProjectAsync('bun');
    const pkgPath = path.join(projectRoot, 'package.json');
    const pkg = readJson(pkgPath);
    pkg.expo = { autolinking: { android: { buildFromSource: ['.*'] } } };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    edit(
      projectRoot,
      'fake-expo-module/android/src/main/java/expo/modules/fake/FakeModule.kt',
      '// fix\n'
    );

    const result = await patchAsync('bun', projectRoot, ['fake-expo-module', '--json']);
    const report = JSON.parse(result.stdout);

    expect(report.native).toEqual(['android']);
    expect(report.buildFromSource).toEqual([]);
    expect(readJson(pkgPath).expo.autolinking).toEqual({ android: { buildFromSource: ['.*'] } });
  });

  it(`refuses a package with no edits`, async () => {
    const projectRoot = await setupProjectAsync('bun');

    const result = await patchAsync('bun', projectRoot, ['fake-js-lib', '--json'], false);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('PATCH_NO_EDITS');
    expect(fs.existsSync(path.join(projectRoot, 'patches'))).toBe(false);
  });

  it.skipIf(isWindows)(`refuses files that are hard links into the store`, async () => {
    const projectRoot = await setupProjectAsync('bun', ['install', '--backend=hardlink']);

    const result = await patchAsync('bun', projectRoot, ['fake-js-lib', '--json'], false);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('PATCH_LINKED_STORE');
  });
});

describe.each([
  { manager: 'pnpm' as const, patchFile: path.join('patches', 'fake-expo-module@1.0.0.patch') },
  {
    manager: 'yarn4' as const,
    patchFile: expect.stringMatching(/^\.yarn[\\/]patches[\\/]fake-expo-module-file-\w+\.patch$/),
  },
])('@expo/agent-cli patch — $manager (its own patch command)', ({ manager, patchFile }) => {
  usePinnedManager(manager);

  it(`saves a native edit through the manager's edit directory, and a fresh install applies it`, async () => {
    const projectRoot = await setupProjectAsync(manager);
    const kotlin = 'fake-expo-module/android/src/main/java/expo/modules/fake/FakeModule.kt';
    edit(projectRoot, kotlin, '// fix\n');

    const result = await patchAsync(manager, projectRoot, ['fake-expo-module', '--json']);
    const report = JSON.parse(result.stdout);

    expect(report).toMatchObject({
      packageManager: manager === 'pnpm' ? 'pnpm' : 'yarn-berry',
      status: 'saved',
      files: ['android/src/main/java/expo/modules/fake/FakeModule.kt'],
      native: ['android'],
      buildFromSource: [{ platform: 'android', added: ['fake-expo-module'] }],
    });
    expect(
      path.relative(fs.realpathSync.native(projectRoot), fs.realpathSync.native(report.patchFile))
    ).toEqual(patchFile);

    reinstall(projectRoot, manager);
    expect(fs.readFileSync(path.join(projectRoot, 'node_modules', kotlin), 'utf8')).toContain(
      '// fix'
    );
  });
});

describe.each(['npm' as const, 'yarn1' as const])(
  '@expo/agent-cli patch — %s (patch-package format)',
  (manager) => {
    if (manager !== 'npm') {
      usePinnedManager(manager);
    }

    it(`asks for --yes before it sets up patch-package, and writes nothing without it`, async () => {
      const projectRoot = await setupProjectAsync(manager);
      edit(projectRoot, 'fake-js-lib/index.js', '// fix\n');
      const before = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8');

      const result = await patchAsync(manager, projectRoot, ['fake-js-lib', '--json']);
      const report = JSON.parse(result.stdout);

      expect(report).toMatchObject({
        packageManager: manager === 'npm' ? 'npm' : 'yarn-classic',
        status: 'needs-consent',
        patchFile: null,
      });
      expect(report.pendingChanges).toEqual([
        'scripts.postinstall: "patch-package"',
        expect.stringContaining('devDependencies.patch-package'),
      ]);
      expect(report.rerun).toMatch(/patch fake-js-lib --json --yes$/);
      expect(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).toBe(before);
      expect(fs.existsSync(path.join(projectRoot, 'patches'))).toBe(false);
    });

    it(`writes a patch, from a clean copy of the installed tarball, that applies to a fresh install`, async () => {
      const projectRoot = await setupProjectAsync(manager);
      edit(projectRoot, 'fake-expo-module/ios/FakeModule.swift', '// fix\n');

      const result = await patchAsync(manager, projectRoot, [
        'fake-expo-module',
        '--json',
        '--yes',
      ]);
      const report = JSON.parse(result.stdout);

      expect(report).toMatchObject({
        status: 'saved',
        files: ['ios/FakeModule.swift'],
        buildFromSource: [{ platform: 'ios', added: ['fake-expo-module'] }],
      });
      expect(
        path.relative(fs.realpathSync.native(projectRoot), fs.realpathSync.native(report.patchFile))
      ).toBe(path.join('patches', 'fake-expo-module+1.0.0.patch'));
      const patch = fs.readFileSync(report.patchFile, 'utf8');
      expect(patch).toContain(
        'diff --git a/node_modules/fake-expo-module/ios/FakeModule.swift b/node_modules/fake-expo-module/ios/FakeModule.swift'
      );
      const pkg = readJson(path.join(projectRoot, 'package.json'));
      expect(pkg.scripts.postinstall).toBe('patch-package');
      expect(pkg.devDependencies['patch-package']).toBeDefined();

      // patch-package itself comes from the registry, so the fresh install leaves it out and is
      // checked with `git apply`, which reads the same format from the same directory.
      delete pkg.devDependencies['patch-package'];
      fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
      reinstall(projectRoot, manager);
      run('git', ['apply', report.patchFile], projectRoot);
      expect(
        fs.readFileSync(
          path.join(projectRoot, 'node_modules/fake-expo-module/ios/FakeModule.swift'),
          'utf8'
        )
      ).toContain('// fix');
    });
  }
);
