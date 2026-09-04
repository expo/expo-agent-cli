import { vol } from 'memfs';

import {
  gitignoreIgnoresNativeDir,
  listLocalModulePackagesAsync,
  readProjectNativeDirsAsync,
} from '../nativeCode';

const projectRoot = '/project';

afterEach(() => {
  vol.reset();
});

describe(gitignoreIgnoresNativeDir, () => {
  it(`should match the Expo template patterns`, () => {
    const gitignore = ['node_modules/', '/ios', '/android', '.expo/'].join('\n');
    expect(gitignoreIgnoresNativeDir(gitignore, 'ios')).toBe(true);
    expect(gitignoreIgnoresNativeDir(gitignore, 'android')).toBe(true);
  });

  it(`should not match unrelated paths`, () => {
    expect(gitignoreIgnoresNativeDir('node_modules/\n.expo/\n', 'ios')).toBe(false);
  });
});

describe(readProjectNativeDirsAsync, () => {
  it(`should treat present native directories as checked in when nothing ignores them`, async () => {
    vol.fromJSON({
      [`${projectRoot}/ios/Podfile`]: '',
      [`${projectRoot}/android/build.gradle`]: '',
    });

    await expect(readProjectNativeDirsAsync(projectRoot)).resolves.toEqual({
      ios: true,
      android: true,
    });
  });

  it(`should ignore prebuild output listed in .gitignore`, async () => {
    vol.fromJSON({
      [`${projectRoot}/.gitignore`]: '/ios\n/android\n',
      [`${projectRoot}/ios/Podfile`]: '',
      [`${projectRoot}/android/build.gradle`]: '',
    });

    await expect(readProjectNativeDirsAsync(projectRoot)).resolves.toEqual({
      ios: false,
      android: false,
    });
  });

  it(`should report missing directories as absent`, async () => {
    vol.fromJSON({ [`${projectRoot}/app.json`]: '{}' });

    await expect(readProjectNativeDirsAsync(projectRoot)).resolves.toEqual({
      ios: false,
      android: false,
    });
  });
});

describe(listLocalModulePackagesAsync, () => {
  it(`should list packages under modules/ that have a package.json`, async () => {
    vol.fromJSON({
      [`${projectRoot}/modules/local-native/package.json`]: '{"name":"local-native"}',
      [`${projectRoot}/modules/local-native/ios/Module.swift`]: '',
      [`${projectRoot}/modules/notes.txt`]: 'not a package',
    });

    await expect(listLocalModulePackagesAsync(projectRoot)).resolves.toEqual([
      { name: 'local-native', root: `${projectRoot}/modules/local-native` },
    ]);
  });

  it(`should return nothing when modules/ is missing`, async () => {
    vol.fromJSON({ [`${projectRoot}/app.json`]: '{}' });

    await expect(listLocalModulePackagesAsync(projectRoot)).resolves.toEqual([]);
  });
});
