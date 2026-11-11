import { vol } from 'memfs';

import { classifyInstallImpactAsync } from '../impact';

const projectRoot = '/project';

interface ProjectFixture {
  /** Project dependencies, defaults to `expo` only. */
  dependencies?: Record<string, string>;
  /** Bundled native modules of the installed `expo` package. */
  bundled?: Record<string, string>;
  /** Checked-in native directories. */
  nativeDirs?: boolean;
  /** Extra files, e.g. the installed packages to classify. */
  files?: Record<string, string>;
}

function writeProject({
  dependencies = { expo: '54.0.0' },
  bundled = {},
  nativeDirs = false,
  files = {},
}: ProjectFixture) {
  vol.fromJSON({
    [`${projectRoot}/package.json`]: JSON.stringify({ name: 'app', dependencies }),
    [`${projectRoot}/node_modules/expo/package.json`]: '{"name":"expo","version":"54.0.0"}',
    [`${projectRoot}/node_modules/expo/bundledNativeModules.json`]: JSON.stringify(bundled),
    ...(nativeDirs
      ? { [`${projectRoot}/ios/Podfile`]: '', [`${projectRoot}/android/build.gradle`]: '' }
      : null),
    ...files,
  });
}

afterEach(() => {
  vol.reset();
});

describe(classifyInstallImpactAsync, () => {
  it(`should classify a package without native code as js-only`, async () => {
    writeProject({
      files: {
        [`${projectRoot}/node_modules/zod/package.json`]: '{"name":"zod"}',
        [`${projectRoot}/node_modules/zod/index.js`]: '',
      },
    });

    await expect(classifyInstallImpactAsync(projectRoot, ['zod'])).resolves.toEqual([
      {
        packageName: 'zod',
        impact: 'js-only',
        expoGoBundled: false,
        action: 'reload',
        reasons: [expect.any(String)],
      },
    ]);
  });

  it(`should classify a native module in a CNG project as prebuild-and-build`, async () => {
    writeProject({
      files: {
        [`${projectRoot}/node_modules/react-native-fancy/package.json`]: '{}',
        [`${projectRoot}/node_modules/react-native-fancy/ios/Fancy.m`]: '',
      },
    });

    const [report] = await classifyInstallImpactAsync(projectRoot, ['react-native-fancy']);

    expect(report).toMatchObject({
      packageName: 'react-native-fancy',
      impact: 'native-module',
      expoGoBundled: false,
      action: 'prebuild-and-build',
    });
  });

  it(`should classify a native module in a bare project as native-sync`, async () => {
    writeProject({
      nativeDirs: true,
      files: {
        [`${projectRoot}/node_modules/react-native-fancy/package.json`]: '{}',
        [`${projectRoot}/node_modules/react-native-fancy/android/build.gradle`]: '',
      },
    });

    const [report] = await classifyInstallImpactAsync(projectRoot, ['react-native-fancy']);

    expect(report).toMatchObject({ impact: 'native-module', action: 'native-sync' });
  });

  it(`should classify a native module by its expo-module.config.json`, async () => {
    writeProject({
      files: {
        [`${projectRoot}/node_modules/my-module/package.json`]: '{}',
        [`${projectRoot}/node_modules/my-module/expo-module.config.json`]: '{}',
      },
    });

    const [report] = await classifyInstallImpactAsync(projectRoot, ['my-module']);

    expect(report).toMatchObject({ impact: 'native-module' });
    expect(report?.reasons.join(' ')).toContain('expo-module.config.json');
  });

  it(`should classify a native module by its podspec`, async () => {
    writeProject({
      files: {
        [`${projectRoot}/node_modules/rn-legacy/package.json`]: '{}',
        [`${projectRoot}/node_modules/rn-legacy/RNLegacy.podspec`]: '',
      },
    });

    const [report] = await classifyInstallImpactAsync(projectRoot, ['rn-legacy']);

    expect(report).toMatchObject({ impact: 'native-module' });
    expect(report?.reasons.join(' ')).toContain('podspec');
  });

  it(`should classify a package shipping app.plugin.js as a config plugin`, async () => {
    writeProject({
      files: {
        [`${projectRoot}/node_modules/plugin-only/package.json`]: '{}',
        [`${projectRoot}/node_modules/plugin-only/app.plugin.js`]: '',
      },
    });

    const [report] = await classifyInstallImpactAsync(projectRoot, ['plugin-only']);

    expect(report).toMatchObject({ impact: 'config-plugin', action: 'prebuild-and-build' });
  });

  it(`should classify a package listed in the app config plugins as a config plugin`, async () => {
    writeProject({
      files: {
        [`${projectRoot}/app.json`]: JSON.stringify({ expo: { plugins: ['listed-plugin'] } }),
        [`${projectRoot}/node_modules/listed-plugin/package.json`]: '{}',
        [`${projectRoot}/node_modules/listed-plugin/index.js`]: '',
      },
    });

    const [report] = await classifyInstallImpactAsync(projectRoot, ['listed-plugin']);

    expect(report).toMatchObject({ impact: 'config-plugin' });
  });

  it(`should prefer native-module for a package that is both, keeping both reasons`, async () => {
    writeProject({
      files: {
        [`${projectRoot}/node_modules/both/package.json`]: '{}',
        [`${projectRoot}/node_modules/both/ios/Both.swift`]: '',
        [`${projectRoot}/node_modules/both/app.plugin.js`]: '',
      },
    });

    const [report] = await classifyInstallImpactAsync(projectRoot, ['both']);

    expect(report?.impact).toBe('native-module');
    expect(report?.reasons.join(' ')).toContain('ios');
    expect(report?.reasons.join(' ')).toContain('app.plugin.js');
  });

  it(`should only need a reload for a bundled module in an Expo Go project`, async () => {
    writeProject({
      bundled: { 'expo-camera': '~54.0.0' },
      files: {
        [`${projectRoot}/node_modules/expo-camera/package.json`]: '{}',
        [`${projectRoot}/node_modules/expo-camera/ios/Camera.swift`]: '',
      },
    });

    const [report] = await classifyInstallImpactAsync(projectRoot, ['expo-camera']);

    expect(report).toMatchObject({
      impact: 'native-module',
      expoGoBundled: true,
      action: 'reload',
    });
  });

  it(`should require a build for a bundled module in a dev client project`, async () => {
    writeProject({
      dependencies: { expo: '54.0.0', 'expo-dev-client': '~54.0.0' },
      bundled: { 'expo-camera': '~54.0.0' },
      files: {
        [`${projectRoot}/node_modules/expo-dev-client/package.json`]: '{}',
        [`${projectRoot}/node_modules/expo-dev-client/ios/DevClient.swift`]: '',
        [`${projectRoot}/node_modules/expo-camera/package.json`]: '{}',
        [`${projectRoot}/node_modules/expo-camera/ios/Camera.swift`]: '',
      },
    });

    const [report] = await classifyInstallImpactAsync(projectRoot, ['expo-camera']);

    expect(report).toMatchObject({ expoGoBundled: true, action: 'prebuild-and-build' });
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Sub-features
  describe('with the project fingerprint across the install', () => {
    const devClientDependencies = { expo: '54.0.0', 'expo-dev-client': '~54.0.0' };
    const writeInstalledProject = (dependencies: Record<string, string>) =>
      writeProject({
        dependencies,
        files: {
          [`${projectRoot}/node_modules/expo-file-system/package.json`]: '{}',
          [`${projectRoot}/node_modules/expo-file-system/ios/FileSystem.swift`]: '',
          [`${projectRoot}/node_modules/expo-plugged/package.json`]: '{}',
          [`${projectRoot}/node_modules/expo-plugged/ios/Plugged.swift`]: '',
          [`${projectRoot}/node_modules/expo-plugged/app.plugin.js`]: '',
          [`${projectRoot}/node_modules/lodash/package.json`]: '{}',
        },
      });
    const same = { before: 'aaaa', after: 'aaaa' };

    it.each([
      {
        name: 'unchanged, no build recorded',
        surface: { ...same, lastBuildHashes: [] },
        expected: { action: 'reload', fingerprint: 'unchanged', lastBuild: undefined },
      },
      {
        name: 'unchanged, the recorded builds match',
        surface: { ...same, lastBuildHashes: ['aaaa', 'aaaa'] },
        expected: { action: 'reload', fingerprint: 'unchanged', lastBuild: 'current' },
      },
      {
        name: 'unchanged, one recorded build is stale',
        surface: { ...same, lastBuildHashes: ['aaaa', 'old'] },
        expected: { action: 'prebuild-and-build', fingerprint: 'unchanged', lastBuild: 'stale' },
      },
      {
        name: 'changed',
        surface: { before: 'aaaa', after: 'bbbb', lastBuildHashes: ['aaaa'] },
        expected: { action: 'prebuild-and-build', fingerprint: 'changed', lastBuild: undefined },
      },
      {
        name: 'not measured',
        surface: null,
        expected: { action: 'prebuild-and-build', fingerprint: undefined, lastBuild: undefined },
      },
    ])(
      `should answer $expected.action for a native package: $name`,
      async ({ surface, expected }) => {
        writeInstalledProject(devClientDependencies);

        const [report] = await classifyInstallImpactAsync(projectRoot, ['expo-file-system'], {
          fingerprintAcrossInstallAsync: async () => surface,
        });

        expect(report).toMatchObject({ action: expected.action });
        expect(report?.fingerprint).toBe(expected.fingerprint);
        expect(report?.lastBuild).toBe(expected.lastBuild);
      }
    );

    // The hash does not see a config plugin until the app config lists it, so the build stays owed.
    it(`should keep the build for a native package that ships a config plugin`, async () => {
      writeInstalledProject(devClientDependencies);

      const [report] = await classifyInstallImpactAsync(projectRoot, ['expo-plugged'], {
        fingerprintAcrossInstallAsync: async () => ({ ...same, lastBuildHashes: [] }),
      });

      expect(report).toMatchObject({ action: 'prebuild-and-build' });
      expect(report?.fingerprint).toBeUndefined();
    });

    it.each([
      {
        name: 'an Expo Go project',
        dependencies: { expo: '54.0.0' },
        packageName: 'expo-file-system',
      },
      {
        name: 'a JavaScript-only install',
        dependencies: devClientDependencies,
        packageName: 'lodash',
      },
    ])(`should not measure the fingerprint for $name`, async ({ dependencies, packageName }) => {
      writeInstalledProject(dependencies);
      const fingerprintAcrossInstallAsync = vi.fn(async () => ({ ...same, lastBuildHashes: [] }));

      const [report] = await classifyInstallImpactAsync(projectRoot, [packageName], {
        fingerprintAcrossInstallAsync,
      });

      expect(fingerprintAcrossInstallAsync).not.toHaveBeenCalled();
      expect(report?.fingerprint).toBeUndefined();
    });
  });

  it(`should require a native sync for a bundled module in a bare project`, async () => {
    writeProject({
      nativeDirs: true,
      bundled: { 'expo-camera': '~54.0.0' },
      files: {
        [`${projectRoot}/node_modules/expo-camera/package.json`]: '{}',
        [`${projectRoot}/node_modules/expo-camera/ios/Camera.swift`]: '',
      },
    });

    const [report] = await classifyInstallImpactAsync(projectRoot, ['expo-camera']);

    expect(report).toMatchObject({ expoGoBundled: true, action: 'native-sync' });
  });

  it(`should strip the version range from a package spec`, async () => {
    writeProject({
      bundled: { '@expo/ui': '~54.0.0' },
      files: {
        [`${projectRoot}/node_modules/@expo/ui/package.json`]: '{}',
        [`${projectRoot}/node_modules/@expo/ui/ios/UI.swift`]: '',
      },
    });

    const [report] = await classifyInstallImpactAsync(projectRoot, ['@expo/ui@~54.0.0']);

    expect(report).toMatchObject({
      packageName: '@expo/ui',
      impact: 'native-module',
      expoGoBundled: true,
    });
  });

  it(`should classify a package that is not installed as js-only`, async () => {
    writeProject({});

    const [report] = await classifyInstallImpactAsync(projectRoot, ['ghost']);

    expect(report).toMatchObject({ packageName: 'ghost', impact: 'js-only', action: 'reload' });
    expect(report?.reasons.join(' ')).toContain('node_modules');
  });

  it(`should classify every requested package, in order`, async () => {
    writeProject({
      files: {
        [`${projectRoot}/node_modules/a/package.json`]: '{}',
        [`${projectRoot}/node_modules/a/index.js`]: '',
        [`${projectRoot}/node_modules/b/package.json`]: '{}',
        [`${projectRoot}/node_modules/b/ios/B.swift`]: '',
      },
    });

    const reports = await classifyInstallImpactAsync(projectRoot, ['a', 'b']);

    expect(reports.map((report) => report.packageName)).toEqual(['a', 'b']);
    expect(reports.map((report) => report.impact)).toEqual(['js-only', 'native-module']);
  });

  it(`should return an empty report list for no packages`, async () => {
    writeProject({});

    await expect(classifyInstallImpactAsync(projectRoot, [])).resolves.toEqual([]);
  });

  it(`should still classify when expo is not installed`, async () => {
    vol.fromJSON({
      [`${projectRoot}/package.json`]: '{"name":"app"}',
      [`${projectRoot}/node_modules/react-native-fancy/package.json`]: '{}',
      [`${projectRoot}/node_modules/react-native-fancy/ios/Fancy.m`]: '',
    });

    const [report] = await classifyInstallImpactAsync(projectRoot, ['react-native-fancy']);

    expect(report).toMatchObject({
      impact: 'native-module',
      expoGoBundled: false,
      action: 'prebuild-and-build',
    });
  });
});
