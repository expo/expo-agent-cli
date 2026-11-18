// @ref llp/0037-patch-command.rfc.md
//
// `patch` driven through the published bin against **real** package managers, because the property
// under test is the boundary: the patch file each manager writes, the registration it reads, and
// that a fresh install applies the patch again. A stub would only prove the argv.
//
// No network: the two packages are packed from `fixtures/patch-packages` into local tarballs and
// installed as `file:` dependencies. bun installs with `--backend=copyfile` so the edit in place is
// the same on Linux CI (whose default is hard links) as on macOS; the hard-link case has a test of
// its own. pnpm is not on CI, so its tests run where it is installed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { executeAgentCliAsync, fixturesDir, getTemporaryPath } from '../utils';

const isWindows = process.platform === 'win32';

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: isWindows });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.status}:\n${result.stdout}\n${
        result.stderr
      }`
    );
  }
  return result.stdout;
}

function hasTool(name: string): boolean {
  return spawnSync(name, ['--version'], { shell: isWindows }).status === 0;
}

type Manager = 'bun' | 'pnpm' | 'npm';

const INSTALL: Record<Manager, string[]> = {
  bun: ['install', '--backend=copyfile'],
  pnpm: ['install', '--config.package-import-method=copy'],
  npm: ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
};

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
  run(manager, installArgs, projectRoot);
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
  run(manager, INSTALL[manager], projectRoot);
}

describe.skipIf(!hasTool('bun'))('@expo/agent-cli patch — bun', () => {
  it(`saves a JavaScript edit with bun's own patch, and a fresh install applies it`, async () => {
    const projectRoot = await setupProjectAsync('bun');
    edit(projectRoot, 'fake-js-lib/index.js', '// patched by e2e\n');

    const result = await executeAgentCliAsync(projectRoot, ['patch', 'fake-js-lib', '--json']);
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
    expect(path.dirname(report.patchFile)).toBe(path.join(fs.realpathSync(projectRoot), 'patches'));
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

    const result = await executeAgentCliAsync(projectRoot, ['patch', 'fake-expo-module', '--json']);
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

    const result = await executeAgentCliAsync(projectRoot, ['patch', 'fake-expo-module', '--json']);
    const report = JSON.parse(result.stdout);

    expect(report.native).toEqual(['android']);
    expect(report.buildFromSource).toEqual([]);
    expect(readJson(pkgPath).expo.autolinking).toEqual({ android: { buildFromSource: ['.*'] } });
  });

  it(`refuses a package with no edits`, async () => {
    const projectRoot = await setupProjectAsync('bun');

    const result = await executeAgentCliAsync(projectRoot, ['patch', 'fake-js-lib', '--json'], {
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('PATCH_NO_EDITS');
    expect(fs.existsSync(path.join(projectRoot, 'patches'))).toBe(false);
  });

  it.skipIf(isWindows)(`refuses files that are hard links into the store`, async () => {
    const projectRoot = await setupProjectAsync('bun', ['install', '--backend=hardlink']);

    const result = await executeAgentCliAsync(projectRoot, ['patch', 'fake-js-lib', '--json'], {
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('PATCH_LINKED_STORE');
  });
});

describe.skipIf(!hasTool('pnpm'))('@expo/agent-cli patch — pnpm', () => {
  it(`saves a native edit through pnpm's edit directory, and a fresh install applies it`, async () => {
    const projectRoot = await setupProjectAsync('pnpm');
    edit(
      projectRoot,
      'fake-expo-module/android/src/main/java/expo/modules/fake/FakeModule.kt',
      '// fix\n'
    );

    const result = await executeAgentCliAsync(projectRoot, ['patch', 'fake-expo-module', '--json']);
    const report = JSON.parse(result.stdout);

    expect(report).toMatchObject({
      packageManager: 'pnpm',
      status: 'saved',
      files: ['android/src/main/java/expo/modules/fake/FakeModule.kt'],
      native: ['android'],
      buildFromSource: [{ platform: 'android', added: ['fake-expo-module'] }],
    });
    expect(path.basename(report.patchFile)).toBe('fake-expo-module@1.0.0.patch');

    reinstall(projectRoot, 'pnpm');
    expect(
      fs.readFileSync(
        path.join(
          projectRoot,
          'node_modules/fake-expo-module/android/src/main/java/expo/modules/fake/FakeModule.kt'
        ),
        'utf8'
      )
    ).toContain('// fix');
  });
});

describe('@expo/agent-cli patch — npm (patch-package format)', () => {
  it(`asks for --yes before it sets up patch-package, and writes nothing without it`, async () => {
    const projectRoot = await setupProjectAsync('npm');
    edit(projectRoot, 'fake-js-lib/index.js', '// fix\n');
    const before = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8');

    const result = await executeAgentCliAsync(projectRoot, ['patch', 'fake-js-lib', '--json']);
    const report = JSON.parse(result.stdout);

    expect(report).toMatchObject({
      packageManager: 'npm',
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

  it(`writes a patch that applies to a fresh install`, async () => {
    const projectRoot = await setupProjectAsync('npm');
    edit(projectRoot, 'fake-expo-module/ios/FakeModule.swift', '// fix\n');

    const result = await executeAgentCliAsync(projectRoot, [
      'patch',
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
    expect(path.relative(fs.realpathSync(projectRoot), report.patchFile)).toBe(
      path.join('patches', 'fake-expo-module+1.0.0.patch')
    );
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
    reinstall(projectRoot, 'npm');
    run('git', ['apply', report.patchFile], projectRoot);
    expect(
      fs.readFileSync(
        path.join(projectRoot, 'node_modules/fake-expo-module/ios/FakeModule.swift'),
        'utf8'
      )
    ).toContain('// fix');
  });
});
