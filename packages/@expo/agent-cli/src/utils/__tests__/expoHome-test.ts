import os from 'os';
import path from 'path';

import { expoHomeDirectory } from '../expoHome';

const home = os.homedir();

describe(expoHomeDirectory, () => {
  it('is ~/.expo by default', () => {
    expect(expoHomeDirectory({})).toBe(path.join(home, '.expo'));
  });

  it('follows EXPO_STAGING, then EXPO_LOCAL', () => {
    expect(expoHomeDirectory({ EXPO_STAGING: '1', EXPO_LOCAL: '1' })).toBe(
      path.join(home, '.expo-staging')
    );
    expect(expoHomeDirectory({ EXPO_LOCAL: 'true' })).toBe(path.join(home, '.expo-local'));
    expect(expoHomeDirectory({ EXPO_STAGING: '0' })).toBe(path.join(home, '.expo'));
  });

  it('lets __UNSAFE_EXPO_HOME_DIRECTORY win over everything', () => {
    expect(expoHomeDirectory({ __UNSAFE_EXPO_HOME_DIRECTORY: '/custom', EXPO_STAGING: '1' })).toBe(
      '/custom'
    );
  });
});
