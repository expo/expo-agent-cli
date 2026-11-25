import fs from 'fs';
import path from 'path';

import {
  buildFromSourceNames,
  isNativeConfigFile,
  nativePlatformsOfFile,
  planBuildFromSource,
} from '../buildFromSource';

describe(nativePlatformsOfFile, () => {
  it.each([
    ['ios/ImageView.swift', ['ios']],
    ['android/src/main/java/expo/modules/image/ImageModule.kt', ['android']],
    // The directory decides before the extension.
    ['android/src/main/cpp/NativeProxy.h', ['android']],
    ['apple/Sources/Proxy.hpp', ['ios']],
    // A header or C++ file outside a platform directory is compiled into both.
    ['Common/cpp/Shared.h', ['ios', 'android']],
    ['Common/cpp/Shared.cpp', ['ios', 'android']],
    ['ExpoImage.podspec', ['ios']],
    ['build.gradle', ['android']],
    ['src/index.ts', []],
    ['build/index.js', []],
  ])('%s → %j', (file, platforms) => {
    expect(nativePlatformsOfFile(file)).toEqual(platforms);
  });
});

describe(isNativeConfigFile, () => {
  it.each([
    ['app.plugin.js', true],
    ['plugin/build/index.js', true],
    ['expo-module.config.json', true],
    ['package.json', true],
    ['build/index.js', false],
    ['src/package.json', false],
  ])('%s → %s', (file, expected) => {
    expect(isNativeConfigFile(file)).toBe(expected);
  });
});

describe(buildFromSourceNames, () => {
  // `fs` is memfs in unit tests. Android matches the Gradle project name, made by
  // expo-modules-autolinking `convertPackageToProjectName` unless the module config names it.
  const dir = path.resolve('/pkg');
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    {
      name: 'react-native-reanimated',
      platform: 'ios',
      config: {},
      names: ['react-native-reanimated', 'react-native-worklets'],
    },
    {
      name: 'react-native-reanimated',
      platform: 'android',
      config: {},
      names: ['react-native-reanimated'],
    },
    { name: '@expo/ui', platform: 'ios', config: {}, names: ['@expo/ui'] },
    { name: '@expo/ui', platform: 'android', config: {}, names: ['expo-ui'] },
    { name: 'foo.bar', platform: 'android', config: {}, names: ['foo-bar'] },
    {
      name: '@scope/mod',
      platform: 'android',
      config: {
        android: {
          name: 'custom',
          projects: [
            { name: 'extra', path: 'x', publication: {} },
            { name: 'plain', path: 'y' },
          ],
        },
      },
      names: ['custom', 'extra'],
    },
  ] as const)('$name on $platform → $names', ({ name, platform, config, names }) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'expo-module.config.json'), JSON.stringify(config));
    expect(buildFromSourceNames(name, dir, platform)).toEqual(names);
  });
});

describe(planBuildFromSource, () => {
  // The rules are those of expo-modules-autolinking 58.0.9 `parsePackageJsonOptions`: iOS reads
  // `apple` before `ios`, and a platform list replaces the top-level one.
  it.each([
    { name: 'no config', autolinking: undefined, after: { ios: { buildFromSource: ['x'] } } },
    {
      name: 'an `apple` object, which iOS reads first',
      autolinking: { apple: { exclude: [] }, ios: { buildFromSource: ['y'] } },
      after: { apple: { exclude: [], buildFromSource: ['x'] }, ios: { buildFromSource: ['y'] } },
    },
    {
      name: 'a top-level list, copied into the new platform list',
      autolinking: { buildFromSource: ['y'] },
      after: { buildFromSource: ['y'], ios: { buildFromSource: ['y', 'x'] } },
    },
    {
      name: 'a top-level entry that already matches',
      autolinking: { buildFromSource: ['.*'] },
      after: { buildFromSource: ['.*'] },
    },
    {
      name: 'a platform list, which replaces the top-level one',
      autolinking: { buildFromSource: ['.*'], ios: { buildFromSource: ['y'] } },
      after: { buildFromSource: ['.*'], ios: { buildFromSource: ['y', 'x'] } },
    },
  ])('$name', ({ autolinking, after }) => {
    const pkg: Record<string, any> = { name: 'app', expo: autolinking && { autolinking } };
    const { edit } = planBuildFromSource(structuredClone(pkg), [{ platform: 'ios', names: ['x'] }]);
    edit(pkg);
    expect(pkg.expo?.autolinking).toEqual(after);
  });
});
