import { getConfig } from '@expo/config';
import { vol } from 'memfs';
import path from 'path';

import { readAppConfigPlugins, readEasProject, readExpoConfig, readPluginIds } from '../appConfig';

vi.mock('@expo/config', () => ({ getConfig: vi.fn() }));

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

describe(readExpoConfig, () => {
  // @expo/config resolves app.config.json before app.json.
  it(`should read app.config.json before app.json`, () => {
    writeFiles({
      'app.json': JSON.stringify({ expo: { runtimeVersion: 'from-app-json' } }),
      'app.config.json': JSON.stringify({ expo: { runtimeVersion: 'from-app-config-json' } }),
    });

    const result = readExpoConfig(projectRoot, { skipPlugins: true });

    expect(result).toMatchObject({ source: 'app.config.json', unreadable: false });
    expect(result.config?.runtimeVersion).toBe('from-app-config-json');
  });

  it.each(['app.config.mts', 'app.config.cts'])(`should count %s as a dynamic config`, (file) => {
    writeFiles({ [file]: 'export default {};' });
    vi.mocked(getConfig).mockReturnValue({
      exp: { slug: 'evaluated' },
      staticConfigPath: null,
      dynamicConfigPath: path.join(projectRoot, file),
    } as never);

    expect(readExpoConfig(projectRoot, { skipPlugins: true })).toMatchObject({
      source: file,
      config: { slug: 'evaluated' },
      dynamicConfigFile: file,
    });
  });

  it(`should keep the static read and say why when the dynamic config fails to evaluate`, () => {
    writeFiles({
      'app.json': JSON.stringify({ expo: { slug: 'static' } }),
      'app.config.js': 'module.exports = () => { throw new Error("boom"); };',
    });
    vi.mocked(getConfig).mockImplementation(() => {
      throw new Error('boom');
    });

    expect(readExpoConfig(projectRoot, { skipPlugins: true })).toMatchObject({
      source: 'app.json',
      config: { slug: 'static' },
      dynamicConfigFile: 'app.config.js',
      evaluationError: 'boom',
    });
  });

  it(`should report a static file that does not parse, without falling back`, () => {
    writeFiles({
      'app.config.json': '{ not json',
      'app.json': JSON.stringify({ expo: { name: 'app' } }),
    });

    expect(readExpoConfig(projectRoot, { skipPlugins: true })).toMatchObject({
      source: 'app.config.json',
      config: null,
      unreadable: true,
    });
  });
});

describe(readEasProject, () => {
  it(`should read the project id from app.config.json when app.json names none`, () => {
    writeFiles({
      'app.json': JSON.stringify({ expo: { name: 'app' } }),
      'app.config.json': JSON.stringify({ expo: { extra: { eas: { projectId: 'proj-1' } } } }),
    });

    expect(readEasProject(projectRoot)).toMatchObject({
      projectId: 'proj-1',
      source: 'app.config.json',
    });
  });
});

describe(readAppConfigPlugins, () => {
  it(`should name no source for a static file that does not parse`, () => {
    writeFiles({ 'app.json': '{ not json' });

    expect(readAppConfigPlugins(projectRoot)).toEqual({
      source: null,
      plugins: [],
      evaluationError: null,
    });
  });
});
