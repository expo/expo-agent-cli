import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { vol } from 'memfs';

import { getTelemetryIdentityAsync } from '../identity';

vi.mock('node:os', () => ({ homedir: () => '/home' }));

const expoHome = path.join('/home', '.expo');
const anonymousId = 'b2c8200b-aee2-4470-afc7-a30ad3157683';

beforeEach(() => {
  vol.reset();
  for (const name of ['EXPO_STAGING', 'EXPO_LOCAL', 'EXPO_TOKEN', '__UNSAFE_EXPO_HOME_DIRECTORY']) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('reuses Expo identity, hashes the user ID, and does not modify authentication state', async () => {
  const state = JSON.stringify({
    uuid: anonymousId,
    auth: { userId: 'user-id', sessionSecret: 'secret', username: 'person' },
  });
  vol.fromJSON({ [path.join(expoHome, 'state.json')]: state });

  expect(await getTelemetryIdentityAsync()).toEqual({
    anonymousId,
    userHash: createHash('sha256').update('user-id').digest('hex'),
  });
  expect(await fs.readFile(path.join(expoHome, 'state.json'), 'utf8')).toBe(state);
  expect(await fs.readdir(expoHome)).toEqual(['state.json']);
});

it('does not associate cached login identity when EXPO_TOKEN supplies authentication', async () => {
  vi.stubEnv('EXPO_TOKEN', 'token');
  vol.fromJSON({
    [path.join(expoHome, 'state.json')]: JSON.stringify({
      uuid: anonymousId,
      auth: { userId: 'another-user' },
    }),
  });
  expect(await getTelemetryIdentityAsync()).toEqual({ anonymousId });
});

it.each([
  ['EXPO_STAGING', '1', path.join('/home', '.expo-staging')],
  ['EXPO_LOCAL', 'true', path.join('/home', '.expo-local')],
  ['__UNSAFE_EXPO_HOME_DIRECTORY', '/custom-expo', '/custom-expo'],
])('reads the configured Expo home for %s', async (name, value, home) => {
  vi.stubEnv(name, value);
  vol.fromJSON({ [path.join(home, 'state.json')]: JSON.stringify({ uuid: anonymousId }) });
  expect(await getTelemetryIdentityAsync()).toEqual({ anonymousId });
});

it('treats false environment flags as disabled and prefers staging over local', async () => {
  vi.stubEnv('EXPO_STAGING', 'false');
  vi.stubEnv('EXPO_LOCAL', '0');
  vol.fromJSON({ [path.join(expoHome, 'state.json')]: JSON.stringify({ uuid: anonymousId }) });
  expect(await getTelemetryIdentityAsync()).toEqual({ anonymousId });

  vi.stubEnv('EXPO_STAGING', 'true');
  vi.stubEnv('EXPO_LOCAL', 'true');
  vol.fromJSON({
    [path.join('/home', '.expo-staging', 'state.json')]: JSON.stringify({ uuid: anonymousId }),
  });
  expect(await getTelemetryIdentityAsync()).toEqual({ anonymousId });
});

it.each([undefined, '{broken json', 'null', '{"uuid":42,"auth":{"userId":42}}'])(
  'persists its own anonymous identity without creating or repairing Expo state: %s',
  async (state) => {
    if (state !== undefined) vol.fromJSON({ [path.join(expoHome, 'state.json')]: state });

    const identity = await getTelemetryIdentityAsync();
    expect(identity).toEqual({ anonymousId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    expect(await getTelemetryIdentityAsync()).toEqual(identity);
    expect(await fs.readFile(path.join(expoHome, 'agent-cli-telemetry-id'), 'utf8')).toBe(
      identity.anonymousId
    );
    expect((await fs.stat(path.join(expoHome, 'agent-cli-telemetry-id'))).mode & 0o777).toBe(0o600);
    if (state === undefined) {
      await expect(fs.stat(path.join(expoHome, 'state.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } else {
      expect(await fs.readFile(path.join(expoHome, 'state.json'), 'utf8')).toBe(state);
    }
  }
);

it('uses the winning identity when two workers initialize it concurrently', async () => {
  const identities = await Promise.all([getTelemetryIdentityAsync(), getTelemetryIdentityAsync()]);
  expect(identities[0]).toEqual(identities[1]);
  expect(await fs.readdir(expoHome)).toEqual(['agent-cli-telemetry-id']);
});

it('does not publish an incomplete ID when writing fails after file creation', async () => {
  const writeFile = fs.writeFile;
  vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (file, _data, options) => {
    await writeFile(file, '', options);
    throw Object.assign(new Error('write failed'), { code: 'EIO' });
  });

  expect(await getTelemetryIdentityAsync()).toEqual({
    anonymousId: expect.stringMatching(/^[a-f0-9-]{36}$/),
  });
  expect(await fs.readdir(expoHome)).toEqual([]);
});

it('uses a per-run ID and cleans up when the filesystem cannot publish a hard link', async () => {
  vi.spyOn(fs, 'link').mockRejectedValueOnce(
    Object.assign(new Error('unsupported'), { code: 'ENOTSUP' })
  );

  expect(await getTelemetryIdentityAsync()).toEqual({
    anonymousId: expect.stringMatching(/^[a-f0-9-]{36}$/),
  });
  expect(await fs.readdir(expoHome)).toEqual([]);
});

it('still returns anonymous identity when the home cannot be written', async () => {
  vi.stubEnv('__UNSAFE_EXPO_HOME_DIRECTORY', '/not-a-directory');
  vol.fromJSON({ '/not-a-directory': 'file' });
  expect(await getTelemetryIdentityAsync()).toEqual({
    anonymousId: expect.stringMatching(/^[a-f0-9-]{36}$/),
  });
});
