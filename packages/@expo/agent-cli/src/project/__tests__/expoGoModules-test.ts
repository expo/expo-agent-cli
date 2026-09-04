import {
  dumpCoversSdk,
  EXPO_GO_MODULES_DUMP,
  isExpoGoNativeModule,
  sdkMajor,
} from '../expoGoModules';

describe('the vendored Expo Go module dump', () => {
  it(`should name a default SDK and keep modules sorted unique`, () => {
    expect(EXPO_GO_MODULES_DUMP.defaultSdk).toMatch(/^\d+$/);
    const entry = EXPO_GO_MODULES_DUMP.bySdk[EXPO_GO_MODULES_DUMP.defaultSdk];
    expect(entry).toBeDefined();
    expect(entry?.modules).toEqual([...new Set(entry?.modules ?? [])].sort());
  });

  it(`should include modules compiled into Expo Go`, () => {
    const modules = new Set(EXPO_GO_MODULES_DUMP.bySdk[EXPO_GO_MODULES_DUMP.defaultSdk]?.modules);
    expect(modules.has('expo-camera')).toBe(true);
    expect(modules.has('react-native-reanimated')).toBe(true);
  });

  it(`should not include packages Expo Go does not compile`, () => {
    const modules = new Set(EXPO_GO_MODULES_DUMP.bySdk[EXPO_GO_MODULES_DUMP.defaultSdk]?.modules);
    expect(modules.has('expo-dev-client')).toBe(false);
    expect(modules.has('react-native-mmkv')).toBe(false);
  });

  it(`should list template packages Go hosts without autolinking them`, () => {
    expect(EXPO_GO_MODULES_DUMP.alsoCompatible).toEqual(
      expect.arrayContaining(['expo-splash-screen', 'expo-status-bar'])
    );
  });
});

describe(sdkMajor, () => {
  it(`should read the leading integer of an SDK version`, () => {
    expect(sdkMajor('57.0.9')).toBe('57');
    expect(sdkMajor('54.0.0')).toBe('54');
  });

  it(`should return null when there is no version`, () => {
    expect(sdkMajor(null)).toBeNull();
    expect(sdkMajor('')).toBeNull();
  });
});

describe(dumpCoversSdk, () => {
  it(`should cover the captured default SDK`, () => {
    expect(dumpCoversSdk(`${EXPO_GO_MODULES_DUMP.defaultSdk}.0.0`)).toBe(true);
  });

  it(`should not cover an SDK this CLI has not recaptured`, () => {
    expect(dumpCoversSdk('99.0.0')).toBe(false);
  });
});

describe(isExpoGoNativeModule, () => {
  const dumpSdk = `${EXPO_GO_MODULES_DUMP.defaultSdk}.0.0`;

  it(`should answer from the dump when this CLI captured that SDK`, () => {
    expect(
      isExpoGoNativeModule('expo-camera', { sdkVersion: dumpSdk, bundledNativeModules: null })
    ).toBe(true);
    expect(
      isExpoGoNativeModule('react-native-mmkv', { sdkVersion: dumpSdk, bundledNativeModules: null })
    ).toBe(false);
  });

  it(`should ignore the catalog when the dump covers the SDK`, () => {
    expect(
      isExpoGoNativeModule('expo-dev-client', {
        sdkVersion: dumpSdk,
        bundledNativeModules: { 'expo-dev-client': '~57.0.0' },
      })
    ).toBe(false);
  });

  it(`should fall back to bundledNativeModules.json when the dump has no entry for that SDK`, () => {
    expect(
      isExpoGoNativeModule('expo-camera', {
        sdkVersion: '99.0.0',
        bundledNativeModules: { 'expo-camera': '~99.0.0' },
      })
    ).toBe(true);
    expect(
      isExpoGoNativeModule('react-native-mmkv', {
        sdkVersion: '99.0.0',
        bundledNativeModules: { 'expo-camera': '~99.0.0' },
      })
    ).toBe(false);
  });

  it(`should treat expo-splash-screen as compatible on both paths`, () => {
    expect(
      isExpoGoNativeModule('expo-splash-screen', { sdkVersion: dumpSdk, bundledNativeModules: null })
    ).toBe(true);
    expect(
      isExpoGoNativeModule('expo-splash-screen', {
        sdkVersion: '99.0.0',
        bundledNativeModules: {},
      })
    ).toBe(true);
  });

  it(`should treat expo-status-bar as compatible on both paths`, () => {
    expect(
      isExpoGoNativeModule('expo-status-bar', { sdkVersion: dumpSdk, bundledNativeModules: null })
    ).toBe(true);
  });

  it(`should treat the expo package as the runtime itself`, () => {
    expect(isExpoGoNativeModule('expo', { sdkVersion: '99.0.0', bundledNativeModules: {} })).toBe(
      true
    );
  });

  it(`should treat react-native as the runtime itself`, () => {
    expect(
      isExpoGoNativeModule('react-native', { sdkVersion: dumpSdk, bundledNativeModules: null })
    ).toBe(true);
  });

  it(`should ignore expo-modules-autolinking, whose android/ is a Gradle plugin`, () => {
    expect(
      isExpoGoNativeModule('expo-modules-autolinking', {
        sdkVersion: dumpSdk,
        bundledNativeModules: null,
      })
    ).toBe(true);
  });
});
