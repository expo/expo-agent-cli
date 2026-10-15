import path from 'path';

import { buildLogPath, buildStepPlatform } from '../buildLog';

describe(buildLogPath, () => {
  it(`should keep one log per platform under .expo/dev/logs`, () => {
    expect(buildLogPath('/app', 'ios')).toBe(
      path.join('/app', '.expo', 'dev', 'logs', 'build-ios.log')
    );
    expect(buildLogPath('/app', 'android')).toBe(
      path.join('/app', '.expo', 'dev', 'logs', 'build-android.log')
    );
  });
});

describe(buildStepPlatform, () => {
  it.each([
    [['run:ios'], 'ios'],
    [['run:android', '--no-bundler'], 'android'],
  ] as const)(`should read %j as a %s build`, (args, platform) => {
    expect(buildStepPlatform([...args])).toBe(platform);
  });

  // A plain `expo start` builds nothing, so it writes no build log.
  it.each([[['start']], [['prebuild', '--platform', 'ios']], [[]]])(
    `should answer null for %j`,
    (args) => {
      expect(buildStepPlatform([...args])).toBeNull();
    }
  );
});
