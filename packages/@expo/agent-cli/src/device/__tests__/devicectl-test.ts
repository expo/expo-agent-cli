// @ref llp/0028-installed-app-check.rfc.md §Proof
import fs from 'fs';
import path from 'path';

import type { SpawnCaptureResult } from '../../utils/spawnCapture';
import {
  classifyDevicectlLaunchError,
  launchAppWithPayloadUrlAsync,
  listConnectedIosDevicesAsync,
  openUrlWithDevicectlAsync,
  parseDevicectlList,
} from '../devicectl';

const realFs = await vi.importActual<typeof import('fs')>('node:fs');
const fixture = JSON.parse(
  realFs.readFileSync(
    path.join(__dirname, '..', '..', '__fixtures__', 'devicectl', 'list.json'),
    'utf8'
  )
);

describe(parseDevicectlList, () => {
  it(`keeps the physical iOS devices, with reachability and Developer Mode`, () => {
    expect(parseDevicectlList(fixture)).toEqual([
      {
        udid: '00001110-001111110110101A',
        name: "Ada's iPhone",
        developerModeEnabled: true,
        reachable: true,
      },
      {
        udid: '00002220-002222220220202B',
        name: 'Test iPad',
        developerModeEnabled: false,
        reachable: false,
      },
    ]);
  });

  it.each([[null], [{}], [{ result: {} }], ['nonsense']])(`answers [] for %j`, (json) => {
    expect(parseDevicectlList(json)).toEqual([]);
  });
});

describe(listConnectedIosDevicesAsync, () => {
  it(`writes the list through --json-output and reads it back`, async () => {
    const calls: string[][] = [];
    const devices = await listConnectedIosDevicesAsync({
      spawnCaptureAsync: async (_command, args) => {
        calls.push(args);
        // The module reads through the mocked `fs`, so the fake devicectl writes there too.
        fs.writeFileSync(args[args.indexOf('--json-output') + 1]!, JSON.stringify(fixture));
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    expect(calls[0]!.slice(0, 3)).toEqual(['devicectl', 'list', 'devices']);
    expect(calls[0]).toContain('--timeout');
    expect(devices.map((device) => device.udid)).toEqual([
      '00001110-001111110110101A',
      '00002220-002222220220202B',
    ]);
  });

  // An old Xcode has no `devicectl`; the simulator path must not depend on it.
  it.each([
    [
      'xcrun cannot run',
      {
        stdout: '',
        stderr: '',
        exitCode: null,
        spawnError: Object.assign(new Error('spawn xcrun ENOENT'), { code: 'ENOENT' }),
      },
    ],
    [
      'devicectl is missing',
      { stdout: '', stderr: 'xcrun: error: unable to find utility "devicectl"', exitCode: 72 },
    ],
  ])(`answers [] when %s`, async (_case, result: SpawnCaptureResult) => {
    await expect(
      listConnectedIosDevicesAsync({ spawnCaptureAsync: async () => result })
    ).resolves.toEqual([]);
  });
});

describe('launch and openURL', () => {
  it(`spells the two devicectl commands`, async () => {
    const calls: string[][] = [];
    const spawnCaptureAsync = async (_command: string, args: string[]) => {
      calls.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    await launchAppWithPayloadUrlAsync('UDID', 'dev.expo.app', 'myapp://check?x=1', {
      spawnCaptureAsync,
    });
    await openUrlWithDevicectlAsync('UDID', 'myapp://check?x=1', { spawnCaptureAsync });
    expect(calls).toEqual([
      [
        'devicectl',
        'device',
        'process',
        'launch',
        '--payload-url',
        'myapp://check?x=1',
        '--device',
        'UDID',
        'dev.expo.app',
      ],
      ['devicectl', 'device', 'process', 'openURL', '--device', 'UDID', 'myapp://check?x=1'],
    ]);
  });

  it(`throws with devicectl's stderr on a non-zero exit`, async () => {
    await expect(
      launchAppWithPayloadUrlAsync('UDID', 'dev.expo.app', 'myapp://x', {
        spawnCaptureAsync: async () => ({
          stdout: '',
          stderr: 'The requested application dev.expo.app is not installed.',
          exitCode: 1,
        }),
      })
    ).rejects.toThrow(/is not installed/);
  });
});

describe(classifyDevicectlLaunchError, () => {
  it.each([
    ['The requested application dev.expo.app is not installed.', 'app-not-installed'],
    ['The application could not be found.', 'app-not-installed'],
    [
      'The request to open "dev.expo.app" failed.\n BSErrorCodeDescription = Locked\n Unable to launch dev.expo.app because the device was not, or could not be, unlocked.',
      'device-locked',
    ],
    ['Application already running.', 'already-running'],
    ['Some future devicectl phrasing.', 'unknown'],
  ])(`classifies %j as %s`, (message, expected) => {
    expect(classifyDevicectlLaunchError(new Error(message))).toBe(expected);
  });
});
