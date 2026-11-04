import { vol } from 'memfs';

import { buildInstallFollowUps } from '../../followups/install';
import { checkExpoGoCompatibilityAsync } from '../expoGo';
import { classifyInstallImpactAsync } from '../impact';

const projectRoot = '/project';

interface ProjectFixture {
  sdkVersion?: string;
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
  sdkVersion = '54.0.0',
  dependencies = { expo: '54.0.0' },
  bundled = {},
  nativeDirs = false,
  files = {},
}: ProjectFixture) {
  vol.fromJSON({
    [`${projectRoot}/package.json`]: JSON.stringify({ name: 'app', dependencies }),
    [`${projectRoot}/node_modules/expo/package.json`]: JSON.stringify({
      name: 'expo',
      version: sdkVersion,
    }),
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

  it.each([
    ['57.0.0', 'ios'],
    ['57.0.0', 'android'],
    ['58.0.0', 'ios'],
    ['58.0.0', 'android'],
  ])(
    `should use runtime membership for install advice on SDK %s (%s)`,
    async (sdkVersion, platform) => {
      writeProject({
        sdkVersion,
        dependencies: { expo: sdkVersion, 'expo-maps': '~58.0.0', 'expo-camera': '~58.0.0' },
        // A captured runtime does not need camera in the version catalog. An uncaptured
        // SDK may use the catalog only to corroborate a known runtime module.
        bundled: {
          'expo-maps': '~58.0.0',
          ...(sdkVersion.startsWith('58') ? { 'expo-camera': '~58.0.0' } : {}),
        },
        files: {
          [`${projectRoot}/node_modules/expo-camera/package.json`]: '{}',
          [`${projectRoot}/node_modules/expo-camera/${platform}/native`]: '',
          [`${projectRoot}/node_modules/expo-maps/package.json`]: '{}',
          [`${projectRoot}/node_modules/expo-maps/${platform}/native`]: '',
          [`${projectRoot}/node_modules/expo-maps/expo-module.config.json`]: '{}',
          [`${projectRoot}/node_modules/expo-maps/app.plugin.js`]: '',
          [`${projectRoot}/app.json`]: JSON.stringify({ expo: { plugins: ['expo-maps'] } }),
        },
      });

      const reports = await classifyInstallImpactAsync(projectRoot, ['expo-camera', 'expo-maps']);
      expect(reports).toMatchObject([
        {
          packageName: 'expo-camera',
          impact: 'native-module',
          expoGoBundled: true,
          action: 'reload',
        },
        {
          packageName: 'expo-maps',
          impact: 'native-module',
          expoGoBundled: false,
          action: 'prebuild-and-build',
        },
      ]);
      const followups = buildInstallFollowUps({ reports, packagesWithSkills: [] });
      expect(followups.map(({ id }) => id)).toEqual(['dev', 'typecheck']);
      expect(followups[0]?.why).toContain('expo-maps');
      expect(await checkExpoGoCompatibilityAsync(projectRoot)).toMatchObject({
        compatible: false,
        reasons: expect.arrayContaining([
          expect.objectContaining({ kind: 'unbundled-native-module', packageName: 'expo-maps' }),
        ]),
      });
    }
  );

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
