// @ref llp/0031-ios-binding.plan.md §smoke
// @ref llp/0032-android-instance.plan.md §Wiring
// Smoke binds and releases only its own platform through the registry.
import { acquireDeviceAsync, releaseWorktreeDevicesAsync } from '../../deviceBinding';
import { resolveSmokeOptions } from '../resolveOptions';
import { buildSmokeDeps } from '../smokeAsync';

vi.mock('../../log');
vi.mock('../../deviceBinding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../deviceBinding')>()),
  acquireDeviceAsync: vi.fn(),
  releaseWorktreeDevicesAsync: vi.fn(async () => []),
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

    const result = await buildSmokeDeps(projectRoot, resolveSmokeOptions(['--ios'])).bootDevice();

    expect(acquireDeviceAsync).toHaveBeenCalledWith(projectRoot, 'ios');
    expect(result).toEqual({
      ok: true,
      deviceId: 'SIM-1',
      backend: 'local-ios',
      choice: 'agent-cli 0000',
      installNeeded: true,
      reason: null,
    });
  });

  it(`binds this worktree's emulator instance on Android, which needs the app installed`, async () => {
    vi.mocked(acquireDeviceAsync).mockResolvedValue({
      device: {
        backend: 'local-android',
        platform: 'android',
        serial: 'emulator-5556',
        origin: { kind: 'spawned', avd: 'Pixel_9', port: 5556, emulatorPid: 4242 },
      },
      justBooted: true,
      action: 'spawned',
    });

    const result = await buildSmokeDeps(
      projectRoot,
      resolveSmokeOptions(['--android'])
    ).bootDevice();

    expect(acquireDeviceAsync).toHaveBeenCalledWith(projectRoot, 'android');
    expect(result).toMatchObject({
      ok: true,
      deviceId: 'emulator-5556',
      backend: 'local-android',
      installNeeded: true,
    });
  });

  it(`reports the registry's refusal as a boot that failed`, async () => {
    vi.mocked(acquireDeviceAsync).mockRejectedValue(
      Object.assign(new Error('No iOS runtime with an iPhone is installed.\nHow: install one.'), {
        code: 'DEVICE_UNAVAILABLE',
      })
    );

    const result = await buildSmokeDeps(projectRoot, resolveSmokeOptions(['--ios'])).bootDevice();

    expect(result).toMatchObject({
      ok: false,
      deviceId: null,
      reason: 'No iOS runtime with an iPhone is installed. How: install one.',
    });
  });

  it(`binds nothing under AGENT_CLI_NO_DEVICE and says so`, async () => {
    process.env.AGENT_CLI_NO_DEVICE = '1';
    try {
      const result = await buildSmokeDeps(
        projectRoot,
        resolveSmokeOptions(['--android'])
      ).bootDevice();

      expect(acquireDeviceAsync).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('android') });
    } finally {
      delete process.env.AGENT_CLI_NO_DEVICE;
    }
  });
});

it('smoke-releases-own-platform-only', async () => {
  vi.mocked(releaseWorktreeDevicesAsync).mockResolvedValue([]);
  await buildSmokeDeps(projectRoot, resolveSmokeOptions(['--android'])).releaseDevice();
  expect(releaseWorktreeDevicesAsync).toHaveBeenCalledWith(projectRoot, { platform: 'android' });
});
