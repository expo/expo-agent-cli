import fs from 'fs';
import { vol } from 'memfs';

import { readLastDevRequest, recordLastDevRequest } from '../lastRequest';
import { resolveDevOptions } from '../resolveOptions';

const root = '/project';
const file = `${root}/.expo/agent-cli-last-dev.json`;
beforeEach(() => {
  vol.reset();
  vol.fromJSON({ [`${root}/package.json`]: '{}' });
});

it('retains only the parsed recovery choices from a real invocation', () => {
  recordLastDevRequest(
    root,
    resolveDevOptions([
      '--android',
      '--port',
      '19082',
      '--local',
      '--dev-client',
      '--device',
      'emulator-5556',
      '--detach',
      '--json',
    ])
  );
  expect(readLastDevRequest(root)).toEqual({
    platform: 'android',
    port: 19082,
    device: 'emulator-5556',
    buildBackend: 'local',
    runTarget: 'dev-build',
  });
  expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort()).toEqual([
    'buildBackend',
    'device',
    'platform',
    'port',
    'runTarget',
    'version',
  ]);
});

it('does not write a dry run or erase the preceding real request', () => {
  recordLastDevRequest(root, resolveDevOptions(['--ios', '--plan']));
  expect(fs.existsSync(file)).toBe(false);
  recordLastDevRequest(root, resolveDevOptions(['--android', '--port', '19082']));
  recordLastDevRequest(root, resolveDevOptions(['--ios', '--plan']));
  expect(readLastDevRequest(root)?.platform).toBe('android');
});

it('does not recreate a deleted root', () => {
  fs.rmSync(root, { recursive: true });
  recordLastDevRequest(root, resolveDevOptions(['--android']));
  expect(fs.existsSync(root)).toBe(false);
});

it.each([
  '{',
  'null',
  '{"version":2}',
  '{"version":1,"platform":"android","port":99999,"buildBackend":null,"runTarget":null}',
])('ignores unusable context: %s', (value) => {
  vol.fromJSON({ [file]: value });
  expect(readLastDevRequest(root)).toBeNull();
});

it('does not block development when writing fails', () => {
  vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
    throw new Error('read-only');
  });
  expect(() => recordLastDevRequest(root, resolveDevOptions(['--ios']))).not.toThrow();
});
