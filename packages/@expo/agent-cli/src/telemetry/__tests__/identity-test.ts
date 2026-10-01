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

it.each(['', 'not-a-uuid'])('repairs a corrupt anonymous ID and reuses it: %j', async (value) => {
  const filename = path.join(expoHome, 'agent-cli-telemetry-id');
  vol.fromJSON({ [filename]: value });

  const identity = await getTelemetryIdentityAsync();

  expect(identity).toEqual({ anonymousId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  expect(await getTelemetryIdentityAsync()).toEqual(identity);
  expect(await fs.readFile(filename, 'utf8')).toBe(identity.anonymousId);
  expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
  expect(await fs.readdir(expoHome)).toEqual(['agent-cli-telemetry-id']);
});

it('uses one repaired identity when workers encounter the same corrupt ID concurrently', async () => {
  const filename = path.join(expoHome, 'agent-cli-telemetry-id');
  vol.fromJSON({ [filename]: 'corrupt' });
  const unlink = vi.spyOn(fs, 'unlink');

  const identities = await Promise.all(
    Array.from({ length: 8 }, () => getTelemetryIdentityAsync())
  );

  expect(identities).toEqual(Array.from({ length: 8 }, () => identities[0]));
  expect(await fs.readFile(filename, 'utf8')).toBe(identities[0]!.anonymousId);
  expect(unlink.mock.calls.filter(([file]) => file === filename)).toHaveLength(1);
  expect(await fs.readdir(expoHome)).toEqual(['agent-cli-telemetry-id']);
});

it('preserves an identity published by a new worker while a corrupt ID is being repaired', async () => {
  const filename = path.join(expoHome, 'agent-cli-telemetry-id');
  vol.fromJSON({ [filename]: 'corrupt' });
  const unlink = fs.unlink;
  let winner: Awaited<ReturnType<typeof getTelemetryIdentityAsync>> | undefined;
  vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
    await unlink(file);
    if (file === filename) winner = await getTelemetryIdentityAsync();
  });

  const identity = await getTelemetryIdentityAsync();

  expect(winner).toBeDefined();
  expect(identity).toEqual(winner);
  expect(await fs.readFile(filename, 'utf8')).toBe(winner!.anonymousId);
  expect(await fs.readdir(expoHome)).toEqual(['agent-cli-telemetry-id']);
});

it('waits for repair when a publication collision is followed by a temporarily missing ID', async () => {
  const filename = path.join(expoHome, 'agent-cli-telemetry-id');
  vol.fromJSON({ [filename]: 'corrupt' });
  const link = fs.link;
  let repairStarted = false;
  vi.spyOn(fs, 'link').mockImplementationOnce(async (...args) => {
    try {
      await link(...args);
    } catch (error) {
      await fs.unlink(filename);
      repairStarted = true;
      throw error;
    }
  });
  const readFile = fs.readFile;
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    try {
      return await readFile(...args);
    } catch (error) {
      if (args[0] === filename && repairStarted) {
        await fs.writeFile(filename, anonymousId);
      }
      throw error;
    }
  });

  expect(await getTelemetryIdentityAsync()).toEqual({ anonymousId });
  expect(await fs.readFile(filename, 'utf8')).toBe(anonymousId);
  expect(await fs.readdir(expoHome)).toEqual(['agent-cli-telemetry-id']);
});

it('does not treat an unreadable identity as corrupt or attempt to replace it', async () => {
  const filename = path.join(expoHome, 'agent-cli-telemetry-id');
  vol.fromJSON({ [filename]: anonymousId });
  const readFile = fs.readFile;
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    if (args[0] === filename) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
    return readFile(...args);
  });
  const link = vi.spyOn(fs, 'link');

  expect(await getTelemetryIdentityAsync()).toEqual({
    anonymousId: expect.stringMatching(/^[a-f0-9-]{36}$/),
  });

  expect(link).not.toHaveBeenCalled();
  expect(await readFile(filename, 'utf8')).toBe(anonymousId);
  expect(await fs.readdir(expoHome)).toEqual(['agent-cli-telemetry-id']);
});

it('falls back without stealing a repair lock left by an interrupted worker', async () => {
  const filename = path.join(expoHome, 'agent-cli-telemetry-id');
  vol.fromJSON({ [filename]: 'corrupt' });
  await fs.mkdir(`${filename}.lock`);

  expect(await getTelemetryIdentityAsync()).toEqual({
    anonymousId: expect.stringMatching(/^[a-f0-9-]{36}$/),
  });
  expect(await fs.readFile(filename, 'utf8')).toBe('corrupt');
  expect(await fs.readdir(expoHome)).toEqual([
    'agent-cli-telemetry-id',
    'agent-cli-telemetry-id.lock',
  ]);
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
