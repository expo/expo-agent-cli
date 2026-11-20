// @ref llp/0037-patch-command.rfc.md
//
// `patch` driven through the published bin against **real** package managers, because the property
// under test is the boundary: the patch file each manager writes, the registration it reads, and
// that a fresh install applies the patch again. A stub would only prove the argv.
//
// The two packages are packed from `fixtures/patch-packages` into local tarballs and installed as
// `file:` dependencies. Every manager, npm too, is installed from the npm registry at a pinned
// version into a cache directory before its tests, so they run the same on every machine and on CI.
// npm 12 refuses to patch a `file:` package, so its save test patches a small scoped registry package.
// bun installs with `--backend=copyfile` so the edit in place is the same
// on Linux CI (whose default is hard links) as on macOS; the hard-link case has a test of its own.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { executeAgentCliAsync, fixturesDir, getTemporaryPath, TEMP_DIR } from '../utils';

const isWindows = process.platform === 'win32';

type Manager = 'bun' | 'pnpm' | 'npm' | 'npm12' | 'yarn1' | 'yarn4';

/** The npm package and version that provides each installed manager. */
const PINNED: Record<Manager, string> = {
  // Not the runner's bun: bun 1.3.14 crashes in `bun patch --commit` for a `file:` package.
  bun: 'bun@1.4.4',
  pnpm: 'pnpm@12.2.1',
  // npm 11 has no `npm patch`, so it takes the patch-package path; npm 12 has it.
  npm: 'npm@11.20.0',
  npm12: 'npm@12.2.3',
  yarn1: 'yarn@1.22.22',
  yarn4: '@yarnpkg/cli-dist@4.18.1',
};

/** The patch-package that a `postinstall` of the patch-package path runs. */
const PATCH_PACKAGE = 'patch-package@8.0.1';

const INSTALL: Record<Manager, string[]> = {
  bun: ['install', '--backend=copyfile'],
  pnpm: ['install', '--config.package-import-method=copy'],
  npm: ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
  npm12: ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
  yarn1: ['install', '--ignore-scripts', '--non-interactive'],
  // yarn 4 turns on `--immutable` under CI=1, and the first install writes the lockfile.
  yarn4: ['install', '--no-immutable'],
};

/** The command a manager runs as. */
function commandOf(manager: Manager): string {
  return manager.startsWith('yarn') ? 'yarn' : manager.startsWith('npm') ? 'npm' : manager;
}

/** PATH with the pinned manager's bin directory first, or the runner's own PATH. */
const pathFor: Partial<Record<Manager, string>> = {};

/**
 * yarn 1 keys its global cache of a `file:` tarball by name and version, so a changed fixture with
 * the same version would install the old bytes; its tests get a cache of their own.
 */
const YARN1_CACHE = path.join(getTemporaryPath(), 'yarn1-cache');

function envFor(manager: Manager): NodeJS.ProcessEnv {
  const { npm_config_minimum_release_age, ...rest } = process.env;
  const env = manager === 'yarn1' ? { ...rest, YARN_CACHE_FOLDER: YARN1_CACHE } : rest;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const bin = pathFor[manager];
  return bin ? { ...env, [pathKey]: `${bin}${path.delimiter}${env[pathKey] ?? ''}` } : env;
}

/**
 * Install a pinned npm package once per machine, and return the path of its command.
 * Every tool of these tests, the managers and patch-package, comes from here.
 */
function installPinnedTool(spec: string, command: string): string {
  const prefix = path.join(TEMP_DIR, 'agent-cli-e2e-package-managers', spec.replace(/[@/]/g, '_'));
  const bin = path.join(prefix, 'node_modules', '.bin', isWindows ? `${command}.cmd` : command);
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(prefix, { recursive: true });
    run(
      'npm',
      ['install', '--prefix', prefix, '--no-save', '--no-audit', '--no-fund', spec],
      prefix,
      'npm'
    );
  }
  return bin;
}

/** Install the pinned manager, and put it first on PATH for its tests. */
function usePinnedManager(manager: Manager): void {
  beforeAll(() => {
    pathFor[manager] = path.dirname(installPinnedTool(PINNED[manager], commandOf(manager)));
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
function patchAsync(
  manager: Manager,
  projectRoot: string,
  args: string[],
  reject = true,
  env: NodeJS.ProcessEnv = {}
) {
  return executeAgentCliAsync(projectRoot, ['patch', ...args], {
    env: { ...envFor(manager), ...env },
    reject,
  });
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

describe.each([
  { manager: 'npm' as const, hooks: ['patch-package'] },
  { manager: 'yarn1' as const, hooks: ['patch-package', 'postinstall-postinstall'] },
])('@expo/agent-cli patch — $manager (patch-package format)', ({ manager, hooks }) => {
  usePinnedManager(manager);
  let patchPackageBin: string;
  beforeAll(() => {
    patchPackageBin = installPinnedTool(PATCH_PACKAGE, 'patch-package');
  }, 180_000);

  it(`exits 1 with the --yes line before it sets up patch-package, and writes nothing`, async () => {
    const projectRoot = await setupProjectAsync(manager);
    edit(projectRoot, 'fake-js-lib/index.js', '// fix\n');
    const before = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8');

    const result = await patchAsync(manager, projectRoot, ['fake-js-lib', '--json'], false);
    const { error } = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(error.code).toBe('PATCH_NEEDS_CONSENT');
    expect(error.suggestedCommand).toMatch(/patch fake-js-lib --json --yes$/);
    expect(error.data.pendingChanges).toEqual([
      'scripts.postinstall: "patch-package --error-on-fail"',
      ...hooks.map((name) => expect.stringContaining(`devDependencies.${name}`)),
    ]);
    expect(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(projectRoot, 'patches'))).toBe(false);
  });

  it(`writes a patch, from a clean copy of the installed tarball, that patch-package applies to a fresh install`, async () => {
    const projectRoot = await setupProjectAsync(manager);
    const pkgDir = path.join(projectRoot, 'node_modules/fake-expo-module');
    // A changed, an added and a removed file, and an added line that looks like a file header.
    edit(projectRoot, 'fake-expo-module/ios/FakeModule.swift', '++ b/fix\n');
    fs.writeFileSync(path.join(pkgDir, 'ios/New File.swift'), '// new\n');
    fs.rmSync(path.join(pkgDir, 'src/index.ts'));

    // Git variables of the caller that would change the patch, or the index it is checked in.
    const callerGit = {
      GIT_INDEX_FILE: path.join(projectRoot, 'no-such-dir', 'index'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'diff.noprefix',
      GIT_CONFIG_VALUE_0: 'true',
    };
    const result = await patchAsync(
      manager,
      projectRoot,
      ['fake-expo-module', '--json', '--yes'],
      true,
      callerGit
    );
    const report = JSON.parse(result.stdout);

    expect(report).toMatchObject({
      packageManager: manager === 'npm' ? 'npm' : 'yarn-classic',
      buildFromSource: [{ platform: 'ios', added: ['fake-expo-module'] }],
    });
    expect([...report.files].sort()).toEqual([
      'ios/FakeModule.swift',
      'ios/New File.swift',
      'src/index.ts',
    ]);
    expect(
      path.relative(fs.realpathSync.native(projectRoot), fs.realpathSync.native(report.patchFile))
    ).toBe(path.join('patches', 'fake-expo-module+1.0.0.patch'));
    const pkg = readJson(path.join(projectRoot, 'package.json'));
    expect(pkg.scripts.postinstall).toBe('patch-package --error-on-fail');
    expect(Object.keys(pkg.devDependencies)).toEqual(hooks);

    // The project's install of patch-package would come from the registry, so the fresh install
    // leaves it out, and the pinned patch-package applies the patch the way postinstall would.
    delete pkg.devDependencies;
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    reinstall(projectRoot, manager);
    run(patchPackageBin, ['--error-on-fail'], projectRoot);
    expect(fs.readFileSync(path.join(pkgDir, 'ios/FakeModule.swift'), 'utf8')).toMatch(
      /\n\+\+ b\/fix\n$/
    );
    expect(fs.readFileSync(path.join(pkgDir, 'ios/New File.swift'), 'utf8')).toBe('// new\n');
    expect(fs.existsSync(path.join(pkgDir, 'src/index.ts'))).toBe(false);
  });

  it.each([
    {
      kind: 'binary',
      code: 'PATCH_BINARY',
      make: (dir: string) =>
        fs.writeFileSync(path.join(dir, 'data.bin'), Buffer.from([0, 1, 2, 0])),
    },
    {
      kind: 'symlink',
      code: 'PATCH_SYMLINK',
      make: (dir: string) => fs.symlinkSync('index.js', path.join(dir, 'link.js')),
    },
  ])(`refuses a $kind edit, which patch-package cannot apply`, async ({ code, make }) => {
    const projectRoot = await setupProjectAsync(manager);
    make(path.join(projectRoot, 'node_modules/fake-js-lib'));

    const result = await patchAsync(
      manager,
      projectRoot,
      ['fake-js-lib', '--json', '--yes'],
      false
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe(code);
    expect(fs.existsSync(path.join(projectRoot, 'patches'))).toBe(false);
  });
});

describe('@expo/agent-cli patch — npm 12 (npm patch)', () => {
  usePinnedManager('npm12');
  /** A small scoped registry package: npm writes its patch to `patches/@isaacs/…`. */
  const SCOPED = '@isaacs/string-locale-compare';

  it(`takes the patch-package path, behind --yes, for a package npm patch refuses`, async () => {
    // A `file:` tarball: npm patch refuses what is not from the registry (EPATCHNONREGISTRY).
    const projectRoot = await setupProjectAsync('npm12');
    edit(projectRoot, 'fake-js-lib/index.js', '// fix\n');

    const result = await patchAsync('npm12', projectRoot, ['fake-js-lib', '--json'], false);
    const { error } = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(error.code).toBe('PATCH_NEEDS_CONSENT');
    expect(error.message).toContain('EPATCHNONREGISTRY');
    expect(error.data.pendingChanges[0]).toBe(
      'scripts.postinstall: "patch-package --error-on-fail"'
    );
  });

  /** A project with one registry package, which npm patch accepts. */
  function registryProject(): string {
    const projectRoot = path.join(getTemporaryPath(), 'patch-npm12');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({
        name: 'patch-app',
        version: '1.0.0',
        private: true,
        dependencies: { [SCOPED]: '1.1.0' },
      }) + '\n'
    );
    run('npm', INSTALL.npm12, projectRoot, 'npm12');
    return projectRoot;
  }

  it(`saves a scoped package with npm patch, with no patch-package, and a fresh install applies it`, async () => {
    const projectRoot = registryProject();
    edit(projectRoot, `${SCOPED}/index.js`, '// patched by e2e\n');
    // npm leaves the package's own package.json out of the patch, so the report does too.
    edit(projectRoot, `${SCOPED}/package.json`, '\n');

    const result = await patchAsync('npm12', projectRoot, [SCOPED, '--json']);
    const report = JSON.parse(result.stdout);

    expect(report).toMatchObject({ packageManager: 'npm', files: ['index.js'] });
    expect(result.stderr).toContain('package.json');
    expect(
      path.relative(fs.realpathSync.native(projectRoot), fs.realpathSync.native(report.patchFile))
    ).toBe(path.join('patches', '@isaacs', 'string-locale-compare@1.1.0.patch'));
    const pkg = readJson(path.join(projectRoot, 'package.json'));
    expect(pkg.patchedDependencies).toEqual({
      [`${SCOPED}@1.1.0`]: `patches/${SCOPED}@1.1.0.patch`,
    });
    expect(pkg.scripts).toBeUndefined();

    reinstall(projectRoot, 'npm12');
    expect(
      fs.readFileSync(path.join(projectRoot, 'node_modules', SCOPED, 'index.js'), 'utf8')
    ).toContain('// patched by e2e');
  });

  it.each([
    {
      kind: 'its own package.json',
      make: (dir: string) => fs.appendFileSync(path.join(dir, 'package.json'), '\n'),
    },
    {
      kind: 'a symlink',
      make: (dir: string) => fs.symlinkSync('index.js', path.join(dir, 'link.js')),
    },
    {
      // A PNG header: no NUL byte, and not UTF-8. npm would write back the decoded string.
      kind: 'a file that is not UTF-8',
      make: (dir: string) =>
        fs.writeFileSync(
          path.join(dir, 'icon.png'),
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        ),
    },
  ])(`refuses when the only edit is one npm patch does not record: $kind`, async ({ make }) => {
    const projectRoot = registryProject();
    make(path.join(projectRoot, 'node_modules', SCOPED));

    const result = await patchAsync('npm12', projectRoot, [SCOPED, '--json'], false);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('PATCH_NOT_PATCHABLE');
  });
});
