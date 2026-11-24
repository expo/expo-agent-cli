import fs from 'fs';
import path from 'path';

import {
  addBuildFromSource,
  buildFromSourceGroup,
  nativePlatformsOfFile,
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

describe(buildFromSourceGroup, () => {
  it.each([
    ['react-native-reanimated', 'ios', ['react-native-reanimated', 'react-native-worklets']],
    ['react-native-worklets', 'ios', ['react-native-reanimated', 'react-native-worklets']],
    // The pair is an iOS rule: on Android each builds on its own.
    ['react-native-reanimated', 'android', ['react-native-reanimated']],
    ['expo-image', 'ios', ['expo-image']],
  ] as const)('%s on %s → %j', (packageName, platform, group) => {
    expect(buildFromSourceGroup(packageName, platform)).toEqual(group);
  });
});

describe(addBuildFromSource, () => {
  // `fs` is memfs in unit tests. The rules are those of expo-modules-autolinking 58.0.9
  // `parsePackageJsonOptions`: iOS reads `apple` before `ios`, and a platform list replaces the
  // top-level one.
  const root = path.resolve('/project');
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

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
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'package.json');
    fs.writeFileSync(file, JSON.stringify({ name: 'app', expo: autolinking && { autolinking } }));

    addBuildFromSource(root, ['x'], ['ios']);

    expect(JSON.parse(fs.readFileSync(file, 'utf8')).expo?.autolinking).toEqual(after);
  });
});
