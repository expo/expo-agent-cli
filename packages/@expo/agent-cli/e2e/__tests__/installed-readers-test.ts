// @ref llp/0005-runtime-loop-tools.rfc.md §Proof
//
// The two readers against real subprocesses. The unit tests inject the tool runners, so they prove
// the reader agrees with itself; this proves the protocol crosses a process: the one-argument
// `exec-out dd` an `adb` receives, the APK bytes that come back through a pipe (and through a `.cmd`
// shim on Windows), and the container path `simctl` prints.
import fs from 'node:fs';
import path from 'node:path';

import { listConnectedIosDevicesAsync } from '../../src/device/devicectl';
import { readInstalledFingerprintAndroidAsync } from '../../src/installedApp/android';
import { readInstalledFingerprintIosAsync } from '../../src/installedApp/ios';
import { readInstalledFingerprintIosDeviceAsync } from '../../src/installedApp/iosDevice';
import { readInstalledFingerprintIosSimulatorAsync } from '../../src/installedApp/iosSimulator';
import { getTemporaryPath, pathEnvVars } from '../utils';
import {
  EMBEDDED_HASH,
  EMULATOR_NAME,
  PHONE_NAME,
  PHONE_UDID,
  SIMULATOR_NAME,
  SIMULATOR_UDID,
  installStubAdbAsync,
  installStubXcrunAsync,
} from './installedAppStubs';

const APP_ID = 'com.example.installedapp';

/** The readers resolve their tools from this process's environment, so the stubs go there. */
function withEnv(overrides: Record<string, string | undefined>): () => void {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

describe('the Android reader over a stub adb', () => {
  let root: string;
  let adb: Awaited<ReturnType<typeof installStubAdbAsync>>;
  let restore: () => void;

  beforeEach(async () => {
    root = getTemporaryPath();
    await fs.promises.mkdir(root, { recursive: true });
    adb = await installStubAdbAsync(root, APP_ID);
    restore = withEnv({ ...adb.env, STUB_ADB_NO_DD: undefined });
  });
  afterEach(() => restore());

  it('reads the fingerprint through ranged dd reads, each spelled as one exec-out argument', async () => {
    const result = await readInstalledFingerprintAndroidAsync({
      appId: APP_ID,
      expectedHash: EMBEDDED_HASH,
    });

    expect(result).toMatchObject({
      status: 'ok',
      hash: EMBEDDED_HASH,
      fingerprintVersion: '0.20.0',
      device: { name: EMULATOR_NAME },
    });
    const ranged = adb.calls().filter((args) => args[2] === 'exec-out');
    expect(ranged.length).toBeGreaterThan(0);
    for (const args of ranged) {
      expect(args).toHaveLength(4);
      expect(args[3]).toMatch(
        /^dd if='\/data\/app\/.*base\.apk' bs=65536 skip=\d+ count=\d+ 2>\/dev\/null$/
      );
    }
    expect(adb.calls().some((args) => args[2] === 'pull')).toBe(false);
  });

  it('pulls the whole APK when the device cannot serve ranges', async () => {
    process.env.STUB_ADB_NO_DD = '1';
    const result = await readInstalledFingerprintAndroidAsync({
      appId: APP_ID,
      expectedHash: EMBEDDED_HASH,
    });

    expect(result).toMatchObject({ status: 'ok', hash: EMBEDDED_HASH });
    expect(adb.calls().some((args) => args[2] === 'pull')).toBe(true);
    expect(adb.calls().some((args) => args[2] === 'exec-out')).toBe(false);
  });
});

describe('the simulator reader over a stub xcrun', () => {
  let root: string;
  let restore: () => void;

  beforeEach(async () => {
    root = getTemporaryPath();
    await fs.promises.mkdir(root, { recursive: true });
  });
  afterEach(() => restore());

  it('asks simctl for the app container and reads the file inside it', async () => {
    const xcrun = await installStubXcrunAsync(root, { booted: { fingerprint: EMBEDDED_HASH } });
    restore = withEnv(
      pathEnvVars(`${xcrun.binDir}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`)
    );

    const result = await readInstalledFingerprintIosSimulatorAsync({
      appId: APP_ID,
      expectedHash: EMBEDDED_HASH,
    });

    expect(result).toMatchObject({
      status: 'ok',
      hash: EMBEDDED_HASH,
      device: { name: SIMULATOR_NAME, identifier: SIMULATOR_UDID },
    });
    expect(xcrun.calls()).toEqual([
      ['simctl', 'list', 'devices', 'booted', '-j'],
      ['simctl', 'get_app_container', SIMULATOR_UDID, APP_ID],
    ]);
  });

  it('answers no-device when no simulator is booted', async () => {
    const xcrun = await installStubXcrunAsync(root);
    restore = withEnv(
      pathEnvVars(`${xcrun.binDir}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`)
    );

    await expect(
      readInstalledFingerprintIosSimulatorAsync({ appId: APP_ID, expectedHash: EMBEDDED_HASH })
    ).resolves.toEqual({ status: 'no-device' });
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §How the file is read — iOS device
// The phone probe over a real socket: the stub `devicectl` receives the launch, reads the callback
// URL and nonce out of the payload URL, and POSTs the way the dev-launcher responder does.
describe('the phone probe over a stub devicectl', () => {
  let root: string;
  let restore: () => void;

  beforeEach(async () => {
    root = getTemporaryPath();
    await fs.promises.mkdir(root, { recursive: true });
  });
  afterEach(() => restore());

  async function stubPhoneAsync(phone: { fingerprint: string | null; postDelayMs?: number }) {
    const xcrun = await installStubXcrunAsync(root, { phone });
    restore = withEnv(
      pathEnvVars(`${xcrun.binDir}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`)
    );
    return xcrun;
  }

  it('lists the phones, launches the named one with the trigger URL, and reads what it posts back', async () => {
    const xcrun = await stubPhoneAsync({ fingerprint: EMBEDDED_HASH });
    const devices = await listConnectedIosDevicesAsync();
    expect(devices.map((device) => device.name)).toContain(PHONE_NAME);

    const result = await readInstalledFingerprintIosDeviceAsync({
      appId: APP_ID,
      expectedHash: EMBEDDED_HASH,
      device: PHONE_NAME,
      devices,
      scheme: 'installedapp',
      timeoutMs: 15_000,
    });

    expect(result).toMatchObject({
      status: 'ok',
      hash: EMBEDDED_HASH,
      fingerprintVersion: '0.20.0',
      device: { name: PHONE_NAME, identifier: PHONE_UDID },
    });
    const launch = xcrun.calls().find((args) => args[3] === 'launch');
    expect(launch).toEqual([
      'devicectl',
      'device',
      'process',
      'launch',
      '--payload-url',
      expect.stringMatching(/^installedapp:\/\/\?__expo_fingerprint_check=1&/),
      '--device',
      PHONE_UDID,
      APP_ID,
    ]);
  });

  it('reads a phone whose build embeds no fingerprint as no-embedded-fingerprint', async () => {
    await stubPhoneAsync({ fingerprint: null });
    const result = await readInstalledFingerprintIosDeviceAsync({
      appId: APP_ID,
      expectedHash: EMBEDDED_HASH,
      device: PHONE_NAME,
      devices: await listConnectedIosDevicesAsync(),
      scheme: 'installedapp',
      timeoutMs: 15_000,
    });
    expect(result).toMatchObject({
      status: 'no-embedded-fingerprint',
      device: { name: PHONE_NAME },
    });
  });

  // The answer clock starts once the launch returned, and `--device-timeout` is that clock.
  it('answers no-response when the phone posts back after its time', async () => {
    await stubPhoneAsync({ fingerprint: EMBEDDED_HASH, postDelayMs: 3000 });
    const result = await readInstalledFingerprintIosDeviceAsync({
      appId: APP_ID,
      expectedHash: EMBEDDED_HASH,
      device: PHONE_NAME,
      devices: await listConnectedIosDevicesAsync(),
      scheme: 'installedapp',
      timeoutMs: 500,
    });
    expect(result).toMatchObject({ status: 'no-response', device: { name: PHONE_NAME } });
  });

  // The router: no simulator is booted, a phone is connected, and nothing named it.
  it('names a connected phone in a hint and leaves it alone until --device names it', async () => {
    const xcrun = await stubPhoneAsync({ fingerprint: EMBEDDED_HASH });
    const unnamed = await readInstalledFingerprintIosAsync({
      appId: APP_ID,
      expectedHash: EMBEDDED_HASH,
      scheme: 'installedapp',
      timeoutMs: 15_000,
    });
    expect(unnamed).toMatchObject({
      status: 'no-device',
      hint: expect.stringContaining(`A physical iOS device is connected (${PHONE_NAME})`),
    });
    expect(xcrun.calls().some((args) => args[3] === 'launch')).toBe(false);

    const named = await readInstalledFingerprintIosAsync({
      appId: APP_ID,
      expectedHash: EMBEDDED_HASH,
      device: PHONE_NAME,
      scheme: 'installedapp',
      timeoutMs: 15_000,
    });
    expect(named).toMatchObject({ status: 'ok', hash: EMBEDDED_HASH });
  });
});
