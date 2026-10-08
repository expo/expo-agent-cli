// @ref llp/0031-ios-binding.plan.md §smoke
// The boot dependency smoke hands its phases: iOS binds through the registry and keeps the device;
// Android still boots and shuts down an emulator of its own.
import { bootDeviceAsync } from '../../device/bootDevice';
import { acquireDeviceAsync } from '../../deviceBinding';
import { resolveSmokeOptions } from '../resolveOptions';
import { buildSmokeDeps } from '../smokeAsync';

vi.mock('../../log');
vi.mock('../../device/bootDevice', () => ({
  bootDeviceAsync: vi.fn(),
  shutdownDeviceAsync: vi.fn(),
  BOOT_DEVICE_TIMEOUT_MS: { ios: 1, android: 1 },
}));
vi.mock('../../deviceBinding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../deviceBinding')>()),
  acquireDeviceAsync: vi.fn(),
}));

const projectRoot = '/project';

afterEach(() => {
  vi.resetAllMocks();
});

describe('bootDevice', () => {
  // smoke-acquires-without-bootDevice
  it(`binds this worktree's simulator on iOS and boots nothing itself`, async () => {
    vi.mocked(acquireDeviceAsync).mockResolvedValue({
      device: {
        backend: 'local-ios',
        platform: 'ios',
        udid: 'SIM-1',
        name: 'agent-cli 0000',
        origin: 'created',
      },
      justBooted: true,
      action: 'created',
    });
    const register = vi.fn();

    const result = await buildSmokeDeps(projectRoot, resolveSmokeOptions(['--ios'])).bootDevice(
      register
    );

    expect(acquireDeviceAsync).toHaveBeenCalledWith(projectRoot, 'ios');
    expect(bootDeviceAsync).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      deviceId: 'SIM-1',
      backend: 'local-ios',
      choice: 'agent-cli 0000',
      installNeeded: true,
      reason: null,
    });
    // smoke-registers-no-shutdown: the device stays bound after the run (llp/0033 releases it).
    expect(register).not.toHaveBeenCalled();
  });

  it(`reports the registry's refusal as a boot that failed`, async () => {
    vi.mocked(acquireDeviceAsync).mockRejectedValue(
      Object.assign(new Error('No iOS runtime with an iPhone is installed.\nHow: install one.'), {
        code: 'DEVICE_UNAVAILABLE',
      })
    );

    const result = await buildSmokeDeps(projectRoot, resolveSmokeOptions(['--ios'])).bootDevice(
      vi.fn()
    );

    expect(result).toMatchObject({
      ok: false,
      deviceId: null,
      reason: 'No iOS runtime with an iPhone is installed. How: install one.',
    });
  });

  it(`still boots an emulator on Android, registering it for the shutdown`, async () => {
    vi.mocked(bootDeviceAsync).mockImplementation(async (_platform, { onBooting }) => {
      onBooting?.({ deviceId: 'emulator-5554', backend: 'local-android' });
      return {
        ok: true,
        deviceId: 'emulator-5554',
        backend: 'local-android',
        name: 'Pixel',
        reason: null,
        choice: 'the only AVD',
      };
    });
    const register = vi.fn();

    const result = await buildSmokeDeps(projectRoot, resolveSmokeOptions(['--android'])).bootDevice(
      register
    );

    expect(acquireDeviceAsync).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith({ deviceId: 'emulator-5554', backend: 'local-android' });
    expect(result).toMatchObject({ ok: true, deviceId: 'emulator-5554', backend: 'local-android' });
  });
});
