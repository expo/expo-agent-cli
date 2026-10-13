// @ref llp/0035-one-device-per-worktree.rfc.md §iOS smoke
// @ref llp/0035-one-device-per-worktree.rfc.md §Wiring
// Smoke binds and releases only its own platform through the registry.
import {
  acquireDeviceAsync,
  deviceIdOf,
  deviceNameOf,
  releaseWorktreeDevicesAsync,
} from '../../deviceBinding';
import { androidBindingFor, bindingFor } from '../../deviceBinding/__tests__/fakeTools';
import { resolveSmokeOptions } from '../resolveOptions';
import { buildSmokeDeps, deviceBoundByStart } from '../smokeAsync';

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
      bound: { name: 'agent-cli 0000', action: 'created' },
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

  it.each([
    [
      'emulator-5556',
      { kind: 'spawned', avd: 'Pixel_9', port: 5556, emulatorPid: 4242 } as const,
      'Pixel_9',
    ],
    ['R58N123', { kind: 'explicit' } as const, null],
  ])(
    'names the AVD of a spawned instance as the choice, and nothing for an explicit serial: %s',
    async (serial, origin, choice) => {
      vi.mocked(acquireDeviceAsync).mockResolvedValue({
        device: { backend: 'local-android', platform: 'android', serial, origin },
        justBooted: true,
        action: 'reused',
      });

      const result = await buildSmokeDeps(
        projectRoot,
        resolveSmokeOptions(['--android'])
      ).bootDevice();

      expect(result).toMatchObject({ ok: true, deviceId: serial, choice });
    }
  );

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

it('smoke releases only its acquired platform and binding', async () => {
  const { androidBindingFor } = await import('../../deviceBinding/__tests__/fakeTools');
  const binding = androidBindingFor(projectRoot, 'emulator-5554', { kind: 'explicit' });
  vi.mocked(acquireDeviceAsync).mockResolvedValue({
    binding,
    device: binding.device,
    action: 'reused',
    justBooted: false,
  });
  vi.mocked(releaseWorktreeDevicesAsync).mockResolvedValue([]);
  const deps = buildSmokeDeps(projectRoot, resolveSmokeOptions(['--android']));
  await deps.bootDevice();
  await deps.releaseDevice();
  expect(releaseWorktreeDevicesAsync).toHaveBeenCalledWith(projectRoot, {
    platform: 'android',
    expected: binding,
  });
});

describe(deviceBoundByStart, () => {
  it.each([
    ['created', null, bindingFor(projectRoot, 'SIM-NEW', { name: 'agent-cli 0000' })],
    ['reused', bindingFor(projectRoot, 'SIM-OLD'), bindingFor(projectRoot, 'SIM-OLD')],
    [
      'spawned',
      null,
      androidBindingFor(projectRoot, 'emulator-5556', {
        kind: 'spawned',
        avd: 'Pixel_9',
        port: 5556,
        emulatorPid: 4242,
      }),
    ],
  ] as const)(
    'reads a %s device from the binding the detached dev wrote',
    (action, before, after) => {
      expect(deviceBoundByStart(before, after)).toEqual({
        id: deviceIdOf(after.device),
        name: deviceNameOf(after.device),
        action,
      });
    }
  );

  it('reads no device when the start left no binding', () => {
    expect(deviceBoundByStart(bindingFor(projectRoot, 'SIM-OLD'), null)).toBeUndefined();
  });
});
