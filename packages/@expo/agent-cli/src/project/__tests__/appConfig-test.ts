import { getConfig } from '@expo/config';
import { vol } from 'memfs';
import path from 'path';

import {
  forgetExpoConfigReads,
  readAppConfigPlugins,
  readEasProject,
  readExpoConfig,
  readPluginIds,
} from '../appConfig';

// The declared plugins are read off the loaded module, which these tests do not load.
vi.mock('@expo/config', () => ({
  getConfig: vi.fn(),
  getConfigFilePaths: () => ({ staticConfigPath: null, dynamicConfigPath: null }),
}));

const projectRoot = path.resolve('/project');

afterEach(() => {
  vol.reset();
  forgetExpoConfigReads();
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

  it.each([[[]], [['', [''], 42, null]], [undefined], ['expo-camera']])(
    `should answer an empty list for %j`,
    (plugins) => {
      expect(readPluginIds(plugins)).toEqual([]);
    }
  );
});

describe(readExpoConfig, () => {
  // @expo/config resolves app.config.json before app.json.
  it(`should read app.config.json before app.json`, () => {
    writeFiles({
      'app.json': JSON.stringify({ expo: { runtimeVersion: 'from-app-json' } }),
      'app.config.json': JSON.stringify({ expo: { runtimeVersion: 'from-app-config-json' } }),
    });

    expect(readExpoConfig(projectRoot)).toEqual({
      kind: 'static',
      file: 'app.config.json',
      config: { runtimeVersion: 'from-app-config-json' },
    });
  });

  it.each(['app.config.mts', 'app.config.cts'])(`should count %s as a dynamic config`, (file) => {
    writeFiles({ [file]: 'export default {};' });
    vi.mocked(getConfig).mockReturnValue({
      exp: { slug: 'evaluated' },
      staticConfigPath: null,
      dynamicConfigPath: path.join(projectRoot, file),
    } as never);

    expect(readExpoConfig(projectRoot)).toEqual({
      kind: 'evaluated',
      file,
      config: { slug: 'evaluated' },
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

    expect(readExpoConfig(projectRoot)).toEqual({
      kind: 'evaluation-failed',
      file: 'app.config.js',
      error: 'boom',
      fallback: { kind: 'static', file: 'app.json', config: { slug: 'static' } },
    });
  });

  it(`should report a static file that does not parse, without falling back`, () => {
    writeFiles({
      'app.config.json': '{ not json',
      'app.json': JSON.stringify({ expo: { name: 'app' } }),
    });

    expect(readExpoConfig(projectRoot)).toEqual({ kind: 'unreadable', file: 'app.config.json' });
  });
});

describe(readEasProject, () => {
  it(`should read the project id from app.config.json when app.json names none`, () => {
    writeFiles({
      'app.json': JSON.stringify({ expo: { name: 'app' } }),
      'app.config.json': JSON.stringify({ expo: { extra: { eas: { projectId: 'proj-1' } } } }),
    });

    expect(readEasProject(projectRoot)).toEqual({
      kind: 'linked',
      projectId: 'proj-1',
      source: 'app.config.json',
    });
  });
});

describe('Reading the EAS project link', () => {
  it.each([
    [
      'a config that names no id',
      { 'app.json': '{"expo":{}}' },
      null,
      { kind: 'unlinked', source: 'app.json' },
    ],
    ['no config at all', {}, null, { kind: 'unlinked', source: null }],
    [
      'a static file that does not parse',
      { 'app.json': '{ not json' },
      null,
      { kind: 'unreadable', source: 'app.json' },
    ],
    [
      'a dynamic config that fails to evaluate',
      { 'app.json': '{"expo":{}}', 'app.config.js': 'module.exports = {};' },
      'boom',
      {
        kind: 'unknown',
        source: 'app.config.js',
        why: 'app.config.js could not be evaluated (boom)',
      },
    ],
  ])(`should read %s`, (_name, files, thrown, expected) => {
    writeFiles(files);
    vi.mocked(getConfig).mockImplementation(() => {
      throw new Error(thrown ?? 'not evaluated');
    });

    expect(readEasProject(projectRoot)).toEqual(expected);
  });
});

describe(readAppConfigPlugins, () => {
  it(`should name no source for a static file that does not parse`, () => {
    writeFiles({ 'app.json': '{ not json' });

    expect(readAppConfigPlugins(projectRoot)).toEqual({
      source: null,
      plugins: [],
      unknownBecause: null,
    });
  });
});
