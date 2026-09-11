// @ref llp/0028-installed-app-check.rfc.md §Proof
// The Android reader over a fake `adb` that serves the stored fixture APK the way a device would:
// `stat` answers its size and `exec-out dd` answers byte ranges of it.
import fs from 'fs';
import path from 'path';

import type { AdbRawRunResult, AdbRunResult } from '../../device/adb';
import { readInstalledFingerprintAndroidAsync } from '../android';

const realFs = await vi.importActual<typeof import('fs')>('node:fs');
const APK = realFs.readFileSync(
  path.join(__dirname, '..', '..', '__fixtures__', 'zip', 'fixture-stored.zip')
);
const EMBEDDED_HASH = 'test-fingerprint-hash';
const APP_ID = 'com.example.app';
const APK_PATH = `/data/app/~~abc==/${APP_ID}-def==/base.apk`;

const adb = { bin: 'adb', source: 'PATH' as const, searched: [], fromPathOnly: false };

interface FakeDevice {
  serial: string;
  /** null when the app is not installed. */
  apk: Buffer | null;
  /** Fail `stat` and `dd`, so the reader falls back to `pull`. */
  noRangedTools?: boolean;
  offline?: boolean;
}

/** A fake `adb` serving the devices given, and recording every argv. */
function fakeAdb(devices: FakeDevice[]) {
  const calls: string[][] = [];
  const text = (stdout: string, exitCode = 0): AdbRunResult => ({
    stdout,
    stderr: '',
    exitCode,
    adb,
    notRunnable: false,
  });
  const find = (args: string[]) => devices.find((d) => d.serial === args[args.indexOf('-s') + 1]);

  const runAdbAsync = async (args: string[]): Promise<AdbRunResult> => {
    calls.push(args);
    if (args[0] === 'devices') {
      return text(
        [
          'List of devices attached',
          ...devices.map((d) => `${d.serial}\tdevice model:Pixel_9`),
          '',
        ].join('\n')
      );
    }
    const device = find(args);
    if (!device || device.offline) {
      return text('', 255);
    }
    if (args.includes('pm')) {
      return device.apk ? text(`package:${APK_PATH}\n`) : text('', 1);
    }
    if (args.includes('stat')) {
      return device.noRangedTools ? text('', 127) : text(`${device.apk!.length}\n`);
    }
    if (args.includes('pull')) {
      // The reader reads the pulled file through the (memfs) `fs` module, so the fake writes there.
      fs.mkdirSync(path.dirname(args[4]!), { recursive: true });
      fs.writeFileSync(args[4]!, device.apk!);
      return text('1 file pulled\n');
    }
    if (args.includes('emu')) {
      return text('', 1);
    }
    throw new Error(`unexpected adb ${args.join(' ')}`);
  };

  const runAdbRawAsync = async (args: string[]): Promise<AdbRawRunResult> => {
    calls.push(args);
    const device = find(args);
    const command = args[args.indexOf('exec-out') + 1] ?? '';
    const skip = Number(/skip=(\d+)/.exec(command)?.[1]);
    const count = Number(/count=(\d+)/.exec(command)?.[1]);
    const bs = Number(/bs=(\d+)/.exec(command)?.[1]);
    if (!device?.apk || device.noRangedTools) {
      return {
        stdout: Buffer.alloc(0),
        stderr: 'dd: not found',
        exitCode: 127,
        adb,
        notRunnable: false,
      };
    }
    return {
      stdout: device.apk.subarray(skip * bs, (skip + count) * bs),
      stderr: '',
      exitCode: 0,
      adb,
      notRunnable: false,
    };
  };

  return { calls, runAdbAsync, runAdbRawAsync, androidDeviceNameAsync: async () => null };
}

describe(readInstalledFingerprintAndroidAsync, () => {
  it(`reads the embedded hash through ranged reads, never pulling the APK`, async () => {
    const fake = fakeAdb([{ serial: 'emulator-5554', apk: APK }]);
    const result = await readInstalledFingerprintAndroidAsync({
      expectedHash: EMBEDDED_HASH,
      appId: APP_ID,
      ...fake,
    });
    expect(result).toEqual({
      status: 'ok',
      hash: EMBEDDED_HASH,
      appId: APP_ID,
      device: { name: 'Pixel_9', identifier: 'emulator-5554' },
    });
    expect(fake.calls.some((args) => args.includes('pull'))).toBe(false);
    const dd = fake.calls.filter((args) => args.includes('exec-out'));
    expect(dd.length).toBeGreaterThan(0);
    for (const args of dd) {
      expect(args[args.indexOf('exec-out') + 1]).toMatch(
        /^dd if='.*' bs=65536 skip=\d+ count=\d+ 2>\/dev\/null$/
      );
    }
  });

  it(`pulls the whole APK when the device has no dd`, async () => {
    const fake = fakeAdb([{ serial: 'emulator-5554', apk: APK, noRangedTools: true }]);
    const result = await readInstalledFingerprintAndroidAsync({
      expectedHash: EMBEDDED_HASH,
      appId: APP_ID,
      ...fake,
    });
    expect(result).toMatchObject({ status: 'ok', hash: EMBEDDED_HASH });
    expect(fake.calls.some((args) => args.includes('pull'))).toBe(true);
  });

  it(`answers app-not-installed when pm has no path for the app`, async () => {
    const fake = fakeAdb([{ serial: 'emulator-5554', apk: null }]);
    await expect(
      readInstalledFingerprintAndroidAsync({ expectedHash: 'x', appId: APP_ID, ...fake })
    ).resolves.toMatchObject({ status: 'app-not-installed', appId: APP_ID });
  });

  it(`answers no-embedded-fingerprint for an APK without the asset`, async () => {
    const deflated = realFs.readFileSync(
      path.join(__dirname, '..', '..', '__fixtures__', 'zip', 'fixture-deflated.zip')
    );
    // The deflated fixture holds the asset; swap its name so the entry is not found.
    const withoutAsset = Buffer.from(deflated);
    const nameOffset = withoutAsset.indexOf('assets/app.fingerprint');
    withoutAsset.write('assets/app.fingerprin_', nameOffset);
    withoutAsset.write(
      'assets/app.fingerprin_',
      withoutAsset.indexOf('assets/app.fingerprint', nameOffset + 1)
    );
    const fake = fakeAdb([{ serial: 'emulator-5554', apk: withoutAsset }]);
    await expect(
      readInstalledFingerprintAndroidAsync({ expectedHash: 'x', appId: APP_ID, ...fake })
    ).resolves.toMatchObject({ status: 'no-embedded-fingerprint' });
  });

  it(`skips an unreachable device and answers from the one that could be read`, async () => {
    const fake = fakeAdb([
      { serial: 'R58M1', apk: APK, offline: true },
      { serial: 'emulator-5554', apk: APK },
    ]);
    await expect(
      readInstalledFingerprintAndroidAsync({ expectedHash: EMBEDDED_HASH, appId: APP_ID, ...fake })
    ).resolves.toMatchObject({ status: 'ok', device: { identifier: 'emulator-5554' } });
  });

  it(`only reads the device --device names`, async () => {
    const fake = fakeAdb([
      { serial: 'R58M1', apk: null },
      { serial: 'emulator-5554', apk: APK },
    ]);
    await expect(
      readInstalledFingerprintAndroidAsync({
        expectedHash: EMBEDDED_HASH,
        appId: APP_ID,
        device: 'r58m1',
        ...fake,
      })
    ).resolves.toMatchObject({ status: 'app-not-installed', device: { identifier: 'R58M1' } });
    await expect(
      readInstalledFingerprintAndroidAsync({
        expectedHash: 'x',
        appId: APP_ID,
        device: 'nope',
        ...fake,
      })
    ).resolves.toEqual({ status: 'no-device' });
  });

  it(`answers no-device when adb lists none`, async () => {
    await expect(
      readInstalledFingerprintAndroidAsync({ expectedHash: 'x', appId: APP_ID, ...fakeAdb([]) })
    ).resolves.toEqual({ status: 'no-device' });
  });

  it(`throws the adb tool error when adb cannot run`, async () => {
    await expect(
      readInstalledFingerprintAndroidAsync({
        expectedHash: 'x',
        appId: APP_ID,
        runAdbAsync: async () => ({
          stdout: '',
          stderr: '',
          exitCode: null,
          adb: { ...adb, fromPathOnly: true },
          notRunnable: true,
          spawnError: Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' }),
        }),
      })
    ).rejects.toMatchObject({ code: 'ADB_NOT_RUNNABLE' });
  });
});
