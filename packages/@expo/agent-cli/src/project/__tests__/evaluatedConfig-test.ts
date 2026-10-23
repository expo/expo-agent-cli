import { getConfig } from '@expo/config';
import { vol } from 'memfs';

import { evaluateExpoConfig } from '../evaluatedConfig';

vi.mock('@expo/config', () => ({ getConfig: vi.fn() }));

const projectRoot = '/project';

function mockConfig(
  exp: Record<string, unknown>,
  files: Partial<{ static: string; dynamic: string }> = {}
) {
  vi.mocked(getConfig).mockReturnValue({
    exp,
    pkg: {},
    rootConfig: {},
    staticConfigPath: files.static ? `${projectRoot}/${files.static}` : null,
    dynamicConfigPath: files.dynamic ? `${projectRoot}/${files.dynamic}` : null,
    hasUnusedStaticConfig: false,
  } as never);
}

beforeEach(() => {
  vol.reset();
  vi.mocked(getConfig).mockReset();
  delete process.env.NODE_ENV;
  delete process.env.BABEL_ENV;
});

describe(evaluateExpoConfig, () => {
  it(`should evaluate with the options expo config uses, for the mode the caller names`, () => {
    mockConfig({ slug: 'demo', scheme: 'demoapp' }, { dynamic: 'app.config.ts' });

    const result = evaluateExpoConfig(projectRoot, {
      mode: 'production',
      isPublicConfig: true,
      skipPlugins: true,
    });

    expect(result).toEqual({
      ok: true,
      exp: { slug: 'demo', scheme: 'demoapp' },
      staticConfigFile: null,
      dynamicConfigFile: 'app.config.ts',
    });
    expect(getConfig).toHaveBeenCalledWith(projectRoot, {
      skipSDKVersionRequirement: true,
      isPublicConfig: true,
      skipPlugins: true,
    });
  });

  // The env files are loaded for the evaluation only: what `expo start` would serve is this
  // process's own environment, and a later subprocess inherits that one.
  it(`should set the mode for the evaluation and put the environment back afterwards`, () => {
    process.env.BABEL_ENV = 'inherited';
    let seen: { NODE_ENV?: string; BABEL_ENV?: string } = {};
    vi.mocked(getConfig).mockImplementation(() => {
      seen = { NODE_ENV: process.env.NODE_ENV, BABEL_ENV: process.env.BABEL_ENV };
      return { exp: {}, pkg: {}, staticConfigPath: null, dynamicConfigPath: null } as never;
    });

    evaluateExpoConfig(projectRoot, { mode: 'development' });

    expect(seen).toEqual({ NODE_ENV: 'development', BABEL_ENV: undefined });
    expect(process.env.NODE_ENV).toBeUndefined();
    expect(process.env.BABEL_ENV).toBe('inherited');
    expect(process.env.__EXPO_ENV_LOADED).toBeUndefined();
  });

  // Project code runs here, and a `--json` run owns stdout (llp/0006 §Output contract).
  it(`should send what the config prints to stderr`, () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      vi.mocked(getConfig).mockImplementation(() => {
        process.stdout.write('hello from app.config.js\n');
        return { exp: {}, pkg: {}, staticConfigPath: null, dynamicConfigPath: null } as never;
      });

      evaluateExpoConfig(projectRoot, { mode: 'development' });

      expect(stderr).toHaveBeenCalledWith('hello from app.config.js\n');
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it(`should answer ok: false with the first line of what the config threw`, () => {
    vi.mocked(getConfig).mockImplementation(() => {
      throw new Error('Cannot resolve app config\n  at app.config.ts:3');
    });

    expect(evaluateExpoConfig(projectRoot, { mode: 'development' })).toEqual({
      ok: false,
      error: 'Cannot resolve app config',
    });
    expect(process.env.NODE_ENV).toBeUndefined();
  });
});
