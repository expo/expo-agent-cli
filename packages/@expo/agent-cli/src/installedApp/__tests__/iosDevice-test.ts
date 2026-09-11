// @ref llp/0028-installed-app-check.rfc.md §Proof
// The probe with an injected launch that answers the way a device does: it reads the nonce and the
// callback out of the trigger URL and posts back over loopback. The callback server is real.
import type { IosDevice } from '../../device/devicectl';
import { startFingerprintCallbackServerAsync } from '../fingerprintCallbackServer';
import { CALLBACK_PARAM, NONCE_PARAM } from '../fingerprintCheckProtocol';
import { readInstalledFingerprintIosDeviceAsync } from '../iosDevice';

const appId = 'dev.expo.app';

function phone(overrides: Partial<IosDevice> = {}): IosDevice {
  return {
    udid: 'UDID-A',
    name: 'Ada’s iPhone',
    developerModeEnabled: true,
    reachable: true,
    ...overrides,
  };
}

const startServer: typeof startFingerprintCallbackServerAsync = (options) =>
  startFingerprintCallbackServerAsync({ ...options, lanHost: () => '192.168.1.50' });

/** Post `fingerprint` back to the callback in `url`, the way the dev-launcher responder does. */
async function respond(url: string, fingerprint: string | null, { badNonce = false } = {}) {
  const parsed = new URL(url);
  const nonce = badNonce ? 'wrong' : parsed.searchParams.get(NONCE_PARAM);
  const callback = new URL(parsed.searchParams.get(CALLBACK_PARAM)!);
  callback.hostname = '127.0.0.1';
  await fetch(callback, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce, fingerprint }),
  });
}

function respondingLaunch(fingerprint: string | null, options?: { badNonce?: boolean }) {
  return vi.fn(async (_udid: string, _bundleId: string, url: string) =>
    respond(url, fingerprint, options)
  );
}

function read(
  devices: IosDevice[],
  deps: Parameters<typeof readInstalledFingerprintIosDeviceAsync>[0]['deps'],
  overrides: Partial<Parameters<typeof readInstalledFingerprintIosDeviceAsync>[0]> = {}
) {
  return readInstalledFingerprintIosDeviceAsync({
    expectedHash: 'the-hash',
    appId,
    devices,
    scheme: 'myapp',
    timeoutMs: 2000,
    deps: { startFingerprintCallbackServerAsync: startServer, ...deps },
    ...overrides,
  });
}

describe(readInstalledFingerprintIosDeviceAsync, () => {
  it(`answers ok with the reported hash when the app responds`, async () => {
    const launch = respondingLaunch('the-hash');
    await expect(read([phone()], { launchAppWithPayloadUrlAsync: launch })).resolves.toMatchObject({
      status: 'ok',
      hash: 'the-hash',
      appId,
      device: { identifier: 'UDID-A', name: 'Ada’s iPhone' },
    });
    const url = new URL(launch.mock.calls[0]![2]);
    expect(url.protocol).toBe('myapp:');
    // Host-free: the marker parameter selects the channel, so no app route is claimed.
    expect(url.host).toBe('');
    expect(url.searchParams.get('__expo_fingerprint_check')).toBe('1');
    expect(url.searchParams.get('__expo_fingerprint_nonce')).toBeTruthy();
    expect(url.searchParams.get('__expo_fingerprint_callback')).toContain('/fingerprint-callback');
  });

  it(`falls back to a scheme of its own when the project declares none`, async () => {
    const launch = respondingLaunch('the-hash');
    await read([phone()], { launchAppWithPayloadUrlAsync: launch }, { scheme: null });
    expect(launch.mock.calls[0]![2]).toMatch(
      /^expo-fingerprint-check:\/\/\?__expo_fingerprint_check=1&/
    );
  });

  it(`reports a mismatching hash as ok with that hash`, async () => {
    await expect(
      read([phone()], { launchAppWithPayloadUrlAsync: respondingLaunch('other') })
    ).resolves.toMatchObject({ status: 'ok', hash: 'other' });
  });

  it(`answers no-embedded-fingerprint for a null fingerprint`, async () => {
    await expect(
      read([phone()], { launchAppWithPayloadUrlAsync: respondingLaunch(null) })
    ).resolves.toMatchObject({
      status: 'no-embedded-fingerprint',
      device: { identifier: 'UDID-A' },
    });
  });

  it(`answers no-response when nothing with the right nonce arrives in time`, async () => {
    await expect(
      read(
        [phone()],
        { launchAppWithPayloadUrlAsync: respondingLaunch('x', { badNonce: true }) },
        { timeoutMs: 200 }
      )
    ).resolves.toMatchObject({ status: 'no-response', device: { identifier: 'UDID-A' } });
  });

  it(`answers app-not-installed from the launch error, without trying openURL`, async () => {
    const openUrl = vi.fn();
    await expect(
      read([phone()], {
        launchAppWithPayloadUrlAsync: vi.fn(async () => {
          throw new Error('The requested application dev.expo.app is not installed.');
        }),
        openUrlWithDevicectlAsync: openUrl,
      })
    ).resolves.toMatchObject({ status: 'app-not-installed', appId });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it(`answers no-response with an unlock hint for a locked phone, without trying openURL`, async () => {
    const openUrl = vi.fn();
    await expect(
      read([phone()], {
        launchAppWithPayloadUrlAsync: vi.fn(async () => {
          throw new Error(
            'BSErrorCodeDescription = Locked\nUnable to launch dev.expo.app because the device was not, or could not be, unlocked.'
          );
        }),
        openUrlWithDevicectlAsync: openUrl,
      })
    ).resolves.toMatchObject({
      status: 'no-response',
      appId,
      hint: expect.stringContaining('is locked'),
    });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it(`falls back to openURL on any other launch error, and the answer flows normally`, async () => {
    const openUrl = vi.fn(async (_udid: string, url: string) => respond(url, 'reopened'));
    await expect(
      read(
        [phone()],
        {
          launchAppWithPayloadUrlAsync: vi.fn(async () => {
            throw new Error('Some future devicectl phrasing.');
          }),
          openUrlWithDevicectlAsync: openUrl,
        },
        { expectedHash: 'reopened' }
      )
    ).resolves.toMatchObject({ status: 'ok', hash: 'reopened' });
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it(`answers no-response instead of openURL when the project has no scheme`, async () => {
    const openUrl = vi.fn();
    await expect(
      read(
        [phone()],
        {
          launchAppWithPayloadUrlAsync: vi.fn(async () => {
            throw new Error('Application already running.');
          }),
          openUrlWithDevicectlAsync: openUrl,
        },
        { scheme: null, timeoutMs: 200 }
      )
    ).resolves.toMatchObject({ status: 'no-response' });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it(`rethrows the launch error when openURL fails too`, async () => {
    const launchError = new Error('Some future devicectl phrasing.');
    await expect(
      read([phone()], {
        launchAppWithPayloadUrlAsync: vi.fn(async () => {
          throw launchError;
        }),
        openUrlWithDevicectlAsync: vi.fn(async () => {
          throw new Error('openURL failed too.');
        }),
      })
    ).rejects.toBe(launchError);
  });

  it(`stops at the first device whose app matches`, async () => {
    const launch = respondingLaunch('the-hash');
    await expect(
      read([phone(), phone({ udid: 'UDID-B', name: 'Second Phone' })], {
        launchAppWithPayloadUrlAsync: launch,
      })
    ).resolves.toMatchObject({ status: 'ok', device: { identifier: 'UDID-A' } });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it.each([['UDID-B'], ['udid-b'], ['Second Phone'], ['SECOND PHONE']])(
    `probes only the device --device names, %s`,
    async (filter) => {
      const launch = respondingLaunch('the-hash');
      await expect(
        read(
          [phone(), phone({ udid: 'UDID-B', name: 'Second Phone' })],
          { launchAppWithPayloadUrlAsync: launch },
          { device: filter }
        )
      ).resolves.toMatchObject({ status: 'ok', device: { identifier: 'UDID-B' } });
      expect(launch).toHaveBeenCalledTimes(1);
    }
  );

  it(`skips unreachable devices, and answers no-device when none is left`, async () => {
    const launch = vi.fn();
    await expect(
      read([phone({ reachable: false })], { launchAppWithPayloadUrlAsync: launch })
    ).resolves.toEqual({ status: 'no-device' });
    expect(launch).not.toHaveBeenCalled();
  });

  it(`names a device with Developer Mode off instead of probing it`, async () => {
    const launch = vi.fn();
    const result = await read([phone({ developerModeEnabled: false })], {
      launchAppWithPayloadUrlAsync: launch,
    });
    expect(result).toMatchObject({ status: 'no-device' });
    expect(result.hint).toContain('Developer Mode');
    expect(result.hint).toContain('Ada’s iPhone');
    expect(launch).not.toHaveBeenCalled();
  });
});
