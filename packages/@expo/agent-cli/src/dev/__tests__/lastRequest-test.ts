import fs from 'fs';
import { vol } from 'memfs';

import { readLastDevRequest, recordLastDevRequest } from '../lastRequest';
import { resolveDevOptions } from '../resolveOptions';
import { startupRequestFrom } from '../startupRequest';

const root = '/project';
const file = `${root}/.expo/agent-cli-last-dev.json`;
beforeEach(() => {
  vol.reset();
  vol.fromJSON({ [`${root}/package.json`]: '{}' });
});

it('stores the accepted canonical request without observer-only choices', () => {
  const options = resolveDevOptions([
    '--android',
    '--port',
    '19082',
    '--local',
    '--dev-client',
    '--tunnel',
    '--device',
    'emulator-5556',
    '--detach',
    '--json',
  ]);
  const request = startupRequestFrom(options);
  recordLastDevRequest(root, options, request);
  expect(readLastDevRequest(root)).toEqual(request);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 2, request });
});

it.each(
  (['ios', 'android'] as const).flatMap((platform) =>
    ([null, 'local', 'eas'] as const).map((backend) => ({ platform, backend }))
  )
)(
  'keeps published recovery preferences for $platform with $backend builds',
  ({ platform, backend }) => {
    const options = resolveDevOptions([
      `--${platform}`,
      '--port',
      '19082',
      '--dev-client',
      ...(backend ? [`--${backend}`] : []),
      ...(backend === 'eas' ? [] : ['--device', 'Saved device']),
    ]);
    const { port, device, buildBackend, runTarget } = options;
    vol.fromJSON({
      [file]: JSON.stringify({ version: 1, platform, port, device, buildBackend, runTarget }),
    });
    const expected = startupRequestFrom(options);
    expect(readLastDevRequest(root)).toMatchObject({
      platform: expected.platform,
      port: expected.port,
      device: expected.device,
      build: expected.build,
      deviceBackend: expected.deviceBackend,
      target: expected.target,
    });
  }
);

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
