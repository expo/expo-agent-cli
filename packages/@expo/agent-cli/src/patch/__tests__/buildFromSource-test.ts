import { buildFromSourceGroup, nativePlatformsOfFile } from '../buildFromSource';

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
