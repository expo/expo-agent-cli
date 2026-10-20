import { vol } from 'memfs';
import path from 'path';

import {
  readPluginIds,
  readStaticAppConfigAsync,
  readStaticEasProjectAsync,
  readStaticExpoConfigAsync,
} from '../appConfig';

const projectRoot = path.resolve('/project');

afterEach(() => {
  vol.reset();
});

function writeFiles(files: Record<string, string>) {
  vol.fromJSON(
    Object.fromEntries(
      Object.entries(files).map(([name, body]) => [path.join(projectRoot, name), body])
    )
  );
}

describe(readPluginIds, () => {
  it(`should read a module path and the path of a [path, options] entry`, () => {
    expect(readPluginIds(['expo-camera', ['expo-build-properties', { ios: {} }]])).toEqual([
      'expo-camera',
      'expo-build-properties',
    ]);
  });

  it(`should answer an empty list for an empty array`, () => {
    expect(readPluginIds([])).toEqual([]);
  });

  it(`should skip an entry that names no module`, () => {
    expect(readPluginIds(['', [''], 42, null])).toEqual([]);
  });

  it(`should answer null when the value is not an array`, () => {
    expect(readPluginIds(undefined)).toBeNull();
    expect(readPluginIds('expo-camera')).toBeNull();
  });
});

describe(readStaticExpoConfigAsync, () => {
  // @expo/config resolves app.config.json before app.json.
  it(`should read app.config.json before app.json`, async () => {
    writeFiles({
      'app.json': JSON.stringify({ expo: { runtimeVersion: 'from-app-json' } }),
      'app.config.json': JSON.stringify({ expo: { runtimeVersion: 'from-app-config-json' } }),
    });

    const result = await readStaticExpoConfigAsync(projectRoot);

    expect(result).toMatchObject({ source: 'app.config.json', unreadable: false });
    expect(result.config?.runtimeVersion).toBe('from-app-config-json');
  });

  it.each(['app.config.mts', 'app.config.cts'])(
    `should count %s as a dynamic config`,
    async (file) => {
      writeFiles({ [file]: 'export default {};' });

      expect(await readStaticExpoConfigAsync(projectRoot)).toMatchObject({
        source: null,
        dynamic: true,
      });
    }
  );

  it(`should report a static file that does not parse, without falling back`, async () => {
    writeFiles({
      'app.config.json': '{ not json',
      'app.json': JSON.stringify({ expo: { name: 'app' } }),
    });

    expect(await readStaticExpoConfigAsync(projectRoot)).toMatchObject({
      source: 'app.config.json',
      config: null,
      unreadable: true,
    });
  });
});

describe(readStaticEasProjectAsync, () => {
  it(`should read the project id from app.config.json when app.json names none`, async () => {
    writeFiles({
      'app.json': JSON.stringify({ expo: { name: 'app' } }),
      'app.config.json': JSON.stringify({ expo: { extra: { eas: { projectId: 'proj-1' } } } }),
    });

    expect(await readStaticEasProjectAsync(projectRoot)).toMatchObject({
      projectId: 'proj-1',
      source: 'app.config.json',
    });
  });
});

describe(readStaticAppConfigAsync, () => {
  it(`should name no source for a static file that does not parse`, async () => {
    writeFiles({ 'app.json': '{ not json' });

    expect(await readStaticAppConfigAsync(projectRoot)).toEqual({
      source: null,
      plugins: [],
      dynamic: false,
    });
  });
});
