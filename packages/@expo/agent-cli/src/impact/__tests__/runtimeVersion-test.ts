import { vol } from 'memfs';

import { spawnExpoAsync } from '../../utils/expoCli';
import {
  parseLastJsonObject,
  readRuntimeVersion,
  resolveOtaSafety,
  resolveRuntimeVersionAsync,
} from '../runtimeVersion';
import type { RuntimeVersionInfo } from '../types';

vi.mock('../../utils/expoCli', () => ({ spawnExpoAsync: vi.fn() }));

const projectRoot = '/project';

function mockExpoConfig(config: unknown, { exitCode = 0 }: { exitCode?: number } = {}) {
  vi.mocked(spawnExpoAsync).mockResolvedValue({
    cli: { command: 'expo', args: [] },
    result: { exitCode, stdout: JSON.stringify(config), stderr: '' },
  });
}

function mockExpoConfigFailure() {
  vi.mocked(spawnExpoAsync).mockResolvedValue({
    cli: { command: 'expo', args: [] },
    result: { exitCode: 1, stdout: '', stderr: 'Cannot resolve app config' },
  });
}

beforeEach(() => {
  vol.reset();
  vi.mocked(spawnExpoAsync).mockReset();
});

describe(readRuntimeVersion, () => {
  it(`should read a policy object`, () => {
    expect(readRuntimeVersion({ policy: 'appVersion' }, 'app.json')).toEqual({
      policy: 'appVersion',
      literal: null,
      source: 'app.json',
    });
  });

  it(`should read a literal string`, () => {
    expect(readRuntimeVersion('1.2.0', 'app.json')).toEqual({
      policy: null,
      literal: '1.2.0',
      source: 'app.json',
    });
  });

  it(`should keep a policy it has never heard of, rather than dropping it`, () => {
    expect(readRuntimeVersion({ policy: 'someFuturePolicy' }, 'app.json').policy).toBe(
      'someFuturePolicy'
    );
  });

  it(`should report the source even when the config names no runtimeVersion`, () => {
    // "The config was read and it says nothing" is a different answer from "nothing was read",
    // and the two lead to different sentences.
    expect(readRuntimeVersion(undefined, 'app.json')).toEqual({
      policy: null,
      literal: null,
      source: 'app.json',
    });
  });

  it.each([[null], [42], [[]], [{}], [{ policy: 42 }], [''] as const])(
    `should read %p as no runtimeVersion`,
    (value) => {
      expect(readRuntimeVersion(value, 'app.json')).toMatchObject({ policy: null, literal: null });
    }
  );
});

describe(resolveRuntimeVersionAsync, () => {
  // A static config *is* the config the app sees, so spawning the CLI to be told what the file
  // says is a second spent to learn nothing.
  it(`should read a static app.json as a file, spawning nothing`, async () => {
    vol.fromJSON({
      [`${projectRoot}/app.json`]: JSON.stringify({
        expo: { name: 'app', runtimeVersion: { policy: 'appVersion' } },
      }),
    });

    await expect(resolveRuntimeVersionAsync(projectRoot)).resolves.toEqual({
      policy: 'appVersion',
      literal: null,
      source: 'app.json',
    });
    expect(spawnExpoAsync).not.toHaveBeenCalled();
  });

  it(`should read a bare config object without an expo key`, async () => {
    vol.fromJSON({
      [`${projectRoot}/app.json`]: JSON.stringify({ name: 'app', runtimeVersion: '3.0.0' }),
    });

    await expect(resolveRuntimeVersionAsync(projectRoot)).resolves.toMatchObject({
      literal: '3.0.0',
      source: 'app.json',
    });
    expect(spawnExpoAsync).not.toHaveBeenCalled();
  });

  it(`should report the source even when a static config names no runtimeVersion`, async () => {
    vol.fromJSON({ [`${projectRoot}/app.config.json`]: JSON.stringify({ name: 'app' }) });

    await expect(resolveRuntimeVersionAsync(projectRoot)).resolves.toEqual({
      policy: null,
      literal: null,
      source: 'app.config.json',
    });
  });

  describe('a dynamic config', () => {
    /** A project whose config is code, beside the static file the CLI merges it over. */
    function writeDynamicProject(appJson: unknown = { expo: { name: 'app' } }) {
      vol.fromJSON({
        [`${projectRoot}/package.json`]: '{"name":"app"}',
        [`${projectRoot}/app.json`]: JSON.stringify(appJson),
        [`${projectRoot}/app.config.js`]: 'module.exports = ({ config }) => config;',
      });
    }

    it(`should read the runtimeVersion from the expo config subprocess`, async () => {
      writeDynamicProject();
      mockExpoConfig({ name: 'app', runtimeVersion: { policy: 'fingerprint' } });

      await expect(resolveRuntimeVersionAsync(projectRoot)).resolves.toEqual({
        policy: 'fingerprint',
        literal: null,
        source: 'expo config --type public',
        cache: null,
      });
    });

    it(`should ask expo config for the public config as JSON`, async () => {
      writeDynamicProject();
      mockExpoConfig({ runtimeVersion: '1.0.0' });

      await resolveRuntimeVersionAsync(projectRoot);

      expect(spawnExpoAsync).toHaveBeenCalledWith(
        projectRoot,
        ['config', '--json', '--type', 'public'],
        { output: 'capture' }
      );
    });

    // @ref llp/0023-fingerprint-caching.rfc.md — the evaluated answer is remembered under `.expo`
    // and revalidated against the same pinned files, so the second `status` spawns nothing. The
    // cache module has its own suite; this pins that the resolver *uses* it and says so.
    it(`should answer the second call from the record, and say the answer is remembered`, async () => {
      writeDynamicProject();
      mockExpoConfig({ runtimeVersion: { policy: 'appVersion' } });
      await resolveRuntimeVersionAsync(projectRoot);
      vi.mocked(spawnExpoAsync).mockClear();

      const second = await resolveRuntimeVersionAsync(projectRoot);

      expect(spawnExpoAsync).not.toHaveBeenCalled();
      expect(second).toMatchObject({
        policy: 'appVersion',
        source: 'expo config --type public',
        cache: {
          keyKind: 'mtime+size',
          computedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      });
      expect(second.cache!.ageMs).toBeGreaterThanOrEqual(0);
      expect(second.cache!.revalidatedAgainst).toBeGreaterThan(0);
    });

    it(`should evaluate again when the record is refused`, async () => {
      writeDynamicProject();
      mockExpoConfig({ runtimeVersion: { policy: 'appVersion' } });
      await resolveRuntimeVersionAsync(projectRoot);
      vi.mocked(spawnExpoAsync).mockClear();

      const second = await resolveRuntimeVersionAsync(projectRoot, { cache: false });

      expect(spawnExpoAsync).toHaveBeenCalledTimes(1);
      expect(second.cache).toBeNull();
    });

    it(`should fall back to the static config beside it when the subprocess fails`, async () => {
      writeDynamicProject({ expo: { name: 'app', runtimeVersion: { policy: 'appVersion' } } });
      mockExpoConfigFailure();

      await expect(resolveRuntimeVersionAsync(projectRoot)).resolves.toEqual({
        policy: 'appVersion',
        literal: null,
        source: 'app.json',
      });
    });

    it(`should fall back when the subprocess printed something unparsable`, async () => {
      writeDynamicProject({ expo: { runtimeVersion: '2.0.0' } });
      vi.mocked(spawnExpoAsync).mockResolvedValue({
        cli: { command: 'expo', args: [] },
        result: { exitCode: 0, stdout: 'not json', stderr: '' },
      });

      await expect(resolveRuntimeVersionAsync(projectRoot)).resolves.toMatchObject({
        literal: '2.0.0',
        source: 'app.json',
      });
    });

    it(`should report no source when neither the subprocess nor a config file answered`, async () => {
      vol.fromJSON({
        [`${projectRoot}/package.json`]: '{}',
        [`${projectRoot}/app.config.ts`]: 'export default {};',
      });
      mockExpoConfigFailure();

      await expect(resolveRuntimeVersionAsync(projectRoot)).resolves.toEqual({
        policy: null,
        literal: null,
        source: null,
      });
    });
  });

  // A project with no app config at all is evaluated: the Expo CLI derives one from `package.json`,
  // and only it can say what.
  it(`should evaluate a project with no app config file`, async () => {
    vol.fromJSON({ [`${projectRoot}/package.json`]: '{"name":"app"}' });
    mockExpoConfig({ name: 'app' });

    await expect(resolveRuntimeVersionAsync(projectRoot)).resolves.toMatchObject({
      policy: null,
      literal: null,
      source: 'expo config --type public',
    });
  });
});

describe(resolveOtaSafety, () => {
  const from = (
    policy: string | null,
    literal: string | null = null,
    source: string | null = 'app.json'
  ): RuntimeVersionInfo => ({ policy, literal, source });

  describe('the policy decides, not the class', () => {
    it.each([
      // policy,          fingerprintChanged, safe
      ['fingerprint', true, true],
      ['fingerprint', false, true],
      ['fingerprint', null, true],
      ['appVersion', true, false],
      ['appVersion', false, true],
      ['appVersion', null, null],
      ['sdkVersion', true, false],
      ['sdkVersion', false, true],
      ['sdkVersion', null, null],
      ['nativeVersion', true, false],
      ['nativeVersion', false, true],
      ['nativeVersion', null, null],
    ] as [string, boolean | null, boolean | null][])(
      `should report policy %s with fingerprintChanged %p as safe %p`,
      (policy, changed, safe) => {
        expect(resolveOtaSafety(from(policy), changed).safe).toBe(safe);
      }
    );

    it.each([
      [true, false],
      [false, true],
      [null, null],
    ] as [boolean | null, boolean | null][])(
      `should report a literal runtimeVersion with fingerprintChanged %p as safe %p`,
      (changed, safe) => {
        expect(resolveOtaSafety(from(null, '1.2.0'), changed).safe).toBe(safe);
      }
    );
  });

  it(`should report unknown for a policy this CLI does not know`, () => {
    // Whether it tracks the native surface decides the answer, so nothing is claimed about it.
    const result = resolveOtaSafety(from('someFuturePolicy'), true);

    expect(result.safe).toBeNull();
    expect(result.why).toContain('does not know');
  });

  it(`should report unknown when nothing resolved the runtimeVersion`, () => {
    const result = resolveOtaSafety(from(null, null, null), true);

    expect(result.safe).toBeNull();
    expect(result.why).toContain('could not be resolved');
  });

  it(`should report unknown when the config named no runtimeVersion`, () => {
    const result = resolveOtaSafety(from(null, null, 'app.json'), false);

    expect(result.safe).toBeNull();
    expect(result.why).toContain('names no runtimeVersion');
  });

  it(`should name the crash an unsafe update causes`, () => {
    const result = resolveOtaSafety(from('appVersion'), true);

    expect(result.why).toContain('do not have the new native code');
    expect(result.why).toContain('"fingerprint"');
  });

  it(`should say why the fingerprint policy is safe even when the surface changed`, () => {
    const result = resolveOtaSafety(from('fingerprint'), true);

    expect(result.why).toContain('only offered to builds made from the same fingerprint');
  });

  it(`should carry the resolved runtimeVersion through into the report`, () => {
    const runtimeVersion = from('appVersion', null, 'expo config --type public');

    expect(resolveOtaSafety(runtimeVersion, true).runtimeVersion).toBe(runtimeVersion);
  });
});

describe(parseLastJsonObject, () => {
  it(`should read a single-line payload`, () => {
    expect(parseLastJsonObject('{"runtimeVersion":"1.0.0"}')).toEqual({ runtimeVersion: '1.0.0' });
  });

  it(`should read the last JSON line, past the CLI's own event lines`, () => {
    // The Expo CLI writes structured event lines to stdout ahead of the answer, so slicing from
    // the first `{` reads an event and then fails on the rest of the stream.
    const output = [
      '{"timestamp":1,"type":"stub_expo_start","command":"config"}',
      '{"name":"app","runtimeVersion":{"policy":"appVersion"}}',
      '',
    ].join('\n');

    expect(parseLastJsonObject(output)).toMatchObject({
      runtimeVersion: { policy: 'appVersion' },
    });
  });

  it(`should read a pretty-printed payload spanning many lines`, () => {
    expect(parseLastJsonObject(JSON.stringify({ runtimeVersion: '2.0.0' }, null, 2))).toEqual({
      runtimeVersion: '2.0.0',
    });
  });

  it(`should answer null for output with no object in it`, () => {
    expect(parseLastJsonObject('nothing here')).toBeNull();
    expect(parseLastJsonObject('[1, 2]')).toBeNull();
  });
});
