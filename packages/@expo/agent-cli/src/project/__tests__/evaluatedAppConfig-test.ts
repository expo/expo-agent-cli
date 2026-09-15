import fs from 'fs';
import { vol } from 'memfs';

import { spawnExpoAsync } from '../../utils/expoCli';
import {
  APP_CONFIG_CACHE_FILE_NAME,
  APP_CONFIG_CACHE_TTL_MS,
  clearEvaluatedAppConfigCache,
  readEvaluatedAppConfigAsync,
} from '../evaluatedAppConfig';

vi.mock('../../utils/expoCli', () => ({ spawnExpoAsync: vi.fn() }));

const projectRoot = '/project';
const recordPath = `${projectRoot}/.expo/${APP_CONFIG_CACHE_FILE_NAME}`;

/** A project whose config is code, with the sentinels a manifest pins. */
function writeProject(extra: Record<string, string> = {}) {
  vol.fromJSON({
    [`${projectRoot}/package.json`]: '{"name":"app"}',
    [`${projectRoot}/package-lock.json`]: '{"lockfileVersion":3}',
    [`${projectRoot}/app.json`]: '{"expo":{"name":"app"}}',
    [`${projectRoot}/app.config.js`]: 'module.exports = ({ config }) => config;',
    ...extra,
  });
}

function mockExpoConfig(config: unknown, stdoutPrefix = '') {
  vi.mocked(spawnExpoAsync).mockResolvedValue({
    cli: { command: 'expo', args: [] },
    result: { exitCode: 0, stdout: `${stdoutPrefix}${JSON.stringify(config)}\n`, stderr: '' },
  });
}

beforeEach(() => {
  vol.reset();
  vi.mocked(spawnExpoAsync).mockReset();
  writeProject();
});

describe(readEvaluatedAppConfigAsync, () => {
  it(`should evaluate with the public config as JSON, and say it was not remembered`, async () => {
    mockExpoConfig({ name: 'app', runtimeVersion: '1.0.0' });

    const answer = await readEvaluatedAppConfigAsync(projectRoot);

    expect(spawnExpoAsync).toHaveBeenCalledWith(
      projectRoot,
      ['config', '--json', '--type', 'public'],
      { output: 'capture' }
    );
    expect(answer).toEqual({
      config: { name: 'app', runtimeVersion: '1.0.0' },
      source: 'expo config --type public',
      cache: null,
    });
  });

  // The Expo CLI writes its own event lines to stdout ahead of the payload; the last one wins.
  it(`should read the last JSON line past the CLI's own event lines`, async () => {
    mockExpoConfig({ name: 'app' }, '{"type":"expo:start"}\nSome warning\n');

    const answer = await readEvaluatedAppConfigAsync(projectRoot);

    expect(answer?.config).toEqual({ name: 'app' });
  });

  it(`should remember the answer, and revalidate it on the next call without spawning`, async () => {
    mockExpoConfig({ name: 'app', runtimeVersion: { policy: 'appVersion' } });
    await readEvaluatedAppConfigAsync(projectRoot);
    vi.mocked(spawnExpoAsync).mockClear();

    const second = await readEvaluatedAppConfigAsync(projectRoot);

    expect(spawnExpoAsync).not.toHaveBeenCalled();
    expect(second).toMatchObject({
      config: { name: 'app', runtimeVersion: { policy: 'appVersion' } },
      source: 'expo config --type public',
      cache: {
        keyKind: 'mtime+size',
        computedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    });
    expect(second!.cache!.ageMs).toBeGreaterThanOrEqual(0);
    // Every pinned file, the dynamic config among them.
    expect(second!.cache!.revalidatedAgainst).toBeGreaterThanOrEqual(4);
    expect(fs.existsSync(recordPath)).toBe(true);
  });

  it(`should evaluate again once the dynamic config changes`, async () => {
    mockExpoConfig({ name: 'app' });
    await readEvaluatedAppConfigAsync(projectRoot);
    vi.mocked(spawnExpoAsync).mockClear();
    // A different length, because an in-memory write can land in the same millisecond and a
    // same-length rewrite moves neither half of the stamp (llp/0023 §Proof).
    fs.writeFileSync(
      `${projectRoot}/app.config.js`,
      'module.exports = ({ config }) => ({ ...config, extra: { changed: true } });'
    );
    mockExpoConfig({ name: 'app', extra: { changed: true } });

    const answer = await readEvaluatedAppConfigAsync(projectRoot);

    expect(spawnExpoAsync).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({ config: { extra: { changed: true } }, cache: null });
  });

  it(`should evaluate again once a pinned file the config may read changes`, async () => {
    mockExpoConfig({ name: 'app' });
    await readEvaluatedAppConfigAsync(projectRoot);
    vi.mocked(spawnExpoAsync).mockClear();
    fs.writeFileSync(`${projectRoot}/package.json`, '{"name":"app","version":"2.0.0"}');

    await readEvaluatedAppConfigAsync(projectRoot);

    expect(spawnExpoAsync).toHaveBeenCalledTimes(1);
  });

  it(`should evaluate again once the record is older than its bound`, async () => {
    mockExpoConfig({ name: 'app' });
    await readEvaluatedAppConfigAsync(projectRoot);
    vi.mocked(spawnExpoAsync).mockClear();
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    record.computedAt = new Date(Date.now() - APP_CONFIG_CACHE_TTL_MS - 1000).toISOString();
    fs.writeFileSync(recordPath, JSON.stringify(record));

    await readEvaluatedAppConfigAsync(projectRoot);

    expect(spawnExpoAsync).toHaveBeenCalledTimes(1);
  });

  // The flag is about what the caller will accept. A refusing run still writes what it evaluated,
  // because a measurement is the truest thing the record can hold.
  it(`should evaluate again when the record is refused, and still write it`, async () => {
    mockExpoConfig({ name: 'app' });
    await readEvaluatedAppConfigAsync(projectRoot);
    vi.mocked(spawnExpoAsync).mockClear();
    mockExpoConfig({ name: 'app', version: '2' });

    const answer = await readEvaluatedAppConfigAsync(projectRoot, { cache: false });

    expect(spawnExpoAsync).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({ config: { version: '2' }, cache: null });
    expect(JSON.parse(fs.readFileSync(recordPath, 'utf8')).config).toEqual({
      name: 'app',
      version: '2',
    });
  });

  it.each([
    ['unparsable JSON', '{ not json'],
    [
      'another schema version',
      JSON.stringify({ version: 0, config: {}, computedAt: 'x', keyManifest: { files: {} } }),
    ],
    [
      'a record with no config',
      JSON.stringify({ version: 1, computedAt: 'x', keyManifest: { files: {} } }),
    ],
    ['a record with no manifest', JSON.stringify({ version: 1, config: {}, computedAt: 'x' })],
  ])(`should evaluate again over %s rather than trusting it`, async (_name, contents) => {
    vol.fromJSON({ [recordPath]: contents });
    mockExpoConfig({ name: 'fresh' });

    const answer = await readEvaluatedAppConfigAsync(projectRoot);

    expect(spawnExpoAsync).toHaveBeenCalledTimes(1);
    expect(answer?.config).toEqual({ name: 'fresh' });
  });

  it(`should answer null, and write nothing, when the subprocess fails`, async () => {
    vi.mocked(spawnExpoAsync).mockResolvedValue({
      cli: { command: 'expo', args: [] },
      result: { exitCode: 1, stdout: '', stderr: 'Cannot resolve app config' },
    });

    await expect(readEvaluatedAppConfigAsync(projectRoot)).resolves.toBeNull();
    expect(fs.existsSync(recordPath)).toBe(false);
  });

  it(`should answer null when the subprocess printed no object`, async () => {
    vi.mocked(spawnExpoAsync).mockResolvedValue({
      cli: { command: 'expo', args: [] },
      result: { exitCode: 0, stdout: 'not json', stderr: '' },
    });

    await expect(readEvaluatedAppConfigAsync(projectRoot)).resolves.toBeNull();
  });

  it(`should not remember an answer for a project that moved while it was evaluated`, async () => {
    vi.mocked(spawnExpoAsync).mockImplementation(async () => {
      fs.writeFileSync(`${projectRoot}/app.config.js`, 'module.exports = { name: "moved-app" };');
      return {
        cli: { command: 'expo', args: [] },
        result: { exitCode: 0, stdout: JSON.stringify({ name: 'app' }), stderr: '' },
      };
    });

    const answer = await readEvaluatedAppConfigAsync(projectRoot);

    // The answer is still reported — it is what was measured — but not written against a key the
    // project no longer matches.
    expect(answer?.config).toEqual({ name: 'app' });
    expect(fs.existsSync(recordPath)).toBe(false);
  });

  it(`should not fail the caller when the record cannot be written`, async () => {
    mockExpoConfig({ name: 'app' });
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('EROFS'));
    try {
      await expect(readEvaluatedAppConfigAsync(projectRoot)).resolves.toMatchObject({
        config: { name: 'app' },
      });
    } finally {
      rename.mockRestore();
    }
  });
});

describe(clearEvaluatedAppConfigCache, () => {
  it(`should drop the record`, async () => {
    mockExpoConfig({ name: 'app' });
    await readEvaluatedAppConfigAsync(projectRoot);
    expect(fs.existsSync(recordPath)).toBe(true);

    clearEvaluatedAppConfigCache(projectRoot);

    expect(fs.existsSync(recordPath)).toBe(false);
  });

  it(`should not throw for a project with no record`, () => {
    expect(() => clearEvaluatedAppConfigCache('/nowhere')).not.toThrow();
  });
});
