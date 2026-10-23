import { spawn } from 'child_process';
import path from 'path';

import { evaluateExpoConfigAsync } from '../evaluatedConfig';
import { lastSpawn, mockConfigLoader } from './fakeConfigLoader';

/**
 * A project that resolves `expo/config`: the e2e fixture, whose stub `expo` package ships a
 * `config.js`. Resolution goes through Node's own loader, so it needs a real directory.
 */
const PROJECT_ROOT = path.resolve(__dirname, '../../../e2e/fixtures/go-app');

const CONFIG = {
  exp: { slug: 'demo', scheme: 'demoapp' },
  staticConfigPath: null,
  dynamicConfigPath: `${PROJECT_ROOT}/app.config.ts`,
};

beforeEach(() => {
  vi.mocked(spawn).mockReset();
});

describe(evaluateExpoConfigAsync, () => {
  it(`should spawn nothing for a project that cannot resolve expo/config`, async () => {
    await expect(
      evaluateExpoConfigAsync('/no/such/project', { mode: 'development' })
    ).resolves.toEqual({
      ok: false,
      error: 'expo/config is not installed in the project',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it(`should run the loader with node, in the project, in the mode the caller names`, async () => {
    mockConfigLoader({ messages: [JSON.stringify(CONFIG)] });

    const result = await evaluateExpoConfigAsync(PROJECT_ROOT, {
      mode: 'development',
      isPublicConfig: true,
    });

    expect(result).toEqual({
      ok: true,
      exp: CONFIG.exp,
      staticConfigFile: null,
      dynamicConfigFile: 'app.config.ts',
    });
    const { command, args, options } = lastSpawn();
    expect(command).toBe(process.execPath);
    expect(args[0]).toMatch(/[/\\]configLoader[/\\]index\.js$/);
    expect(args.slice(1)).toEqual([PROJECT_ROOT, '--mode', 'development', '--public']);
    expect(options).toMatchObject({
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: expect.objectContaining({ NODE_ENV: 'development', __EXPO_CONFIG_MODE: 'development' }),
    });
    // This process keeps its own environment: the mode is set on the child's copy only.
    expect(process.env.__EXPO_CONFIG_MODE).toBeUndefined();
  });

  // A release flow such as `deploy` reads the config a production build sees.
  it(`should evaluate in production mode when the caller says so, and pass --skip-plugins through`, async () => {
    mockConfigLoader({ messages: [JSON.stringify(CONFIG)] });

    await evaluateExpoConfigAsync(PROJECT_ROOT, { mode: 'production', skipPlugins: true });

    const { args, options } = lastSpawn();
    expect(args.slice(1)).toEqual([PROJECT_ROOT, '--mode', 'production', '--skip-plugins']);
    expect(options.env).toMatchObject({ NODE_ENV: 'production', __EXPO_CONFIG_MODE: 'production' });
  });

  it.each([
    {
      name: 'the config throws',
      run: {
        exitCode: 1,
        stderr: 'Error: Cannot resolve app config\n    at load (config.js:1:2)\n',
      },
      error: 'Error: Cannot resolve app config',
    },
    {
      name: 'the loader exits without a word',
      run: { exitCode: 1 },
      error: 'expo/config exited with code 1',
    },
    {
      name: 'node could not be started',
      run: { spawnError: Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }) },
      error: 'node could not be started (ENOENT)',
    },
    {
      name: 'the loader sends nothing',
      run: { exitCode: 0 },
      error: 'expo/config printed no config',
    },
    {
      name: 'the loader sends something that is not a config',
      run: { messages: ['{"hello":1}'] },
      error: 'expo/config printed no config',
    },
  ])(`should answer ok: false when $name`, async ({ run, error }) => {
    mockConfigLoader(run);

    await expect(evaluateExpoConfigAsync(PROJECT_ROOT, { mode: 'development' })).resolves.toEqual({
      ok: false,
      error,
    });
  });

  it(`should kill a loader that outlives its budget and say so`, async () => {
    vi.useFakeTimers();
    try {
      const { kill } = mockConfigLoader({ hang: true });
      const pending = evaluateExpoConfigAsync(PROJECT_ROOT, {
        mode: 'development',
        timeoutMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      // The kill lands as a close with a signal, which is what the real child reports.
      expect(kill).toHaveBeenCalledWith('SIGKILL');
      const calls = vi.mocked(spawn).mock.results;
      (calls[calls.length - 1]!.value as NodeJS.EventEmitter).emit('close', null, 'SIGKILL');

      await expect(pending).resolves.toEqual({
        ok: false,
        error: 'expo/config did not answer within 5s',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
