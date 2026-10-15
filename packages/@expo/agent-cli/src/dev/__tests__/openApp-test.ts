import { bootDeviceAsync } from '../../device/bootDevice';
import { checkExpoGoVersionAsync } from '../../device/expoGoVersion';
import { installExpoGoAsync } from '../../device/installExpoGo';
import { simulatorHasAppAsync } from '../../device/installedApps';
import { androidHasAppAsync } from '../../device/androidApps';
import type { BoundDevice } from '../../deviceBinding';
import { probeAndroidDeviceAsync } from '../../navigate/device';
import { openRouteAsync } from '../../navigate/openRoute';
import { CommandError } from '../../utils/errors';
import { openAppOnDeviceAsync } from '../openApp';

vi.mock('../../log');
vi.mock('../events', () => ({ event: vi.fn(), debugEvent: vi.fn() }));
vi.mock('../../navigate/device', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../navigate/device')>()),
  probeAndroidDeviceAsync: vi.fn(),
}));
vi.mock('../../device/bootDevice', () => ({
  bootDeviceAsync: vi.fn(),
  BOOT_DEVICE_TIMEOUT_MS: { ios: 1, android: 1 },
}));
vi.mock('../../device/expoGoVersion', () => ({ checkExpoGoVersionAsync: vi.fn() }));
vi.mock('../../device/installExpoGo', () => ({ installExpoGoAsync: vi.fn() }));
vi.mock('../../device/installedApps', () => ({ simulatorHasAppAsync: vi.fn() }));
vi.mock('../../device/androidApps', () => ({ androidHasAppAsync: vi.fn() }));
vi.mock('../../navigate/openRoute', () => ({ openRouteAsync: vi.fn() }));
vi.mock('../../project/nodeModules', () => ({ readSdkVersionAsync: vi.fn(async () => '54.0.0') }));

const projectRoot = '/project';
const DEV_SERVER = 'http://127.0.0.1:8081';

const BOUND: BoundDevice = {
  backend: 'local-ios',
  platform: 'ios',
  udid: 'UDID-1',
  name: 'agent-cli 0000',
  origin: 'created',
};

function mockOpenOk() {
  vi.mocked(openRouteAsync).mockResolvedValue({
    exitCode: 0,
    command: 'xcrun simctl openurl',
  } as any);
}

beforeEach(() => {
  vi.mocked(simulatorHasAppAsync).mockResolvedValue(true);
  vi.mocked(checkExpoGoVersionAsync).mockResolvedValue({ verdict: 'match' } as any);
  vi.mocked(installExpoGoAsync).mockResolvedValue({
    ok: true,
    version: '2.33.0',
    replaced: null,
    reason: null,
  });
  mockOpenOk();
});

afterEach(() => {
  vi.resetAllMocks();
});

describe(openAppOnDeviceAsync, () => {
  it(`opens on the bound simulator, probes nothing and boots nothing`, async () => {
    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      device: BOUND,
    });

    expect(report).toMatchObject({ opened: true, deviceId: 'UDID-1', booted: false, reason: null });
    expect(bootDeviceAsync).not.toHaveBeenCalled();
    expect(probeAndroidDeviceAsync).not.toHaveBeenCalled();
    expect(openRouteAsync).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({
        route: '/',
        platform: 'ios',
        devServerUrl: DEV_SERVER,
        devServerUrlSource: 'discovered',
        device: BOUND,
      })
    );
  });

  it(`reports the boot the registry did`, async () => {
    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      device: BOUND,
      justBooted: true,
    });

    expect(report).toMatchObject({ opened: true, booted: true });
  });

  it(`stops on iOS with no bound device`, async () => {
    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
    });

    expect(report).toMatchObject({ opened: false, reason: expect.stringContaining('bound') });
    expect(openRouteAsync).not.toHaveBeenCalled();
  });

  it(`boots an emulator when none is up`, async () => {
    vi.mocked(probeAndroidDeviceAsync).mockResolvedValue({ device: null, reason: 'none' });
    vi.mocked(bootDeviceAsync).mockResolvedValue({
      ok: true,
      deviceId: 'emulator-5554',
      backend: 'local-android',
      name: 'Pixel',
      reason: null,
      choice: 'the only AVD',
    });
    vi.mocked(androidHasAppAsync).mockResolvedValue(true);

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'android',
      expoGo: true,
      devServerUrl: DEV_SERVER,
    });

    expect(report).toMatchObject({ opened: true, deviceId: 'emulator-5554', booted: true });
  });

  it(`stops with the boot's own reason when no emulator comes up`, async () => {
    vi.mocked(probeAndroidDeviceAsync).mockResolvedValue({ device: null, reason: 'none' });
    vi.mocked(bootDeviceAsync).mockResolvedValue({
      ok: false,
      deviceId: null,
      backend: null,
      name: null,
      reason: 'no Android virtual device exists',
      choice: null,
    });

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'android',
      expoGo: true,
      devServerUrl: DEV_SERVER,
    });

    expect(report).toMatchObject({ opened: false, reason: 'no Android virtual device exists' });
    expect(openRouteAsync).not.toHaveBeenCalled();
  });

  it(`stops on a missing device tool without booting anything`, async () => {
    vi.mocked(probeAndroidDeviceAsync).mockResolvedValue({
      device: null,
      reason: 'could not run "adb"',
      toolError: new CommandError('ADB_NOT_RUNNABLE', 'Could not run "adb".\nWhy: not found.'),
    });

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'android',
      expoGo: true,
      devServerUrl: DEV_SERVER,
    });

    expect(report.opened).toBe(false);
    expect(report.reason).toContain('adb');
    expect(bootDeviceAsync).not.toHaveBeenCalled();
  });

  it(`installs Expo Go when the device has not got it`, async () => {
    vi.mocked(simulatorHasAppAsync).mockResolvedValue(false);

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      device: BOUND,
    });

    expect(installExpoGoAsync).toHaveBeenCalledWith('UDID-1', 'ios', '54.0.0');
    expect(report).toMatchObject({ opened: true, installedExpoGo: true });
  });

  it(`replaces an Expo Go whose version does not match the SDK's release`, async () => {
    vi.mocked(checkExpoGoVersionAsync).mockResolvedValue({ verdict: 'mismatch' } as any);

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      device: BOUND,
    });

    expect(installExpoGoAsync).toHaveBeenCalled();
    expect(report.opened).toBe(true);
  });

  it(`installs nothing for a development build, whose install is a build`, async () => {
    await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: false,
      devServerUrl: DEV_SERVER,
      device: BOUND,
    });

    expect(simulatorHasAppAsync).not.toHaveBeenCalled();
    expect(installExpoGoAsync).not.toHaveBeenCalled();
    expect(openRouteAsync).toHaveBeenCalled();
  });

  it(`asks adb on Android, through the same door`, async () => {
    vi.mocked(probeAndroidDeviceAsync).mockResolvedValue({
      device: { backend: 'local-android', platform: 'android', deviceId: 'emulator-5554' },
    });
    vi.mocked(androidHasAppAsync).mockResolvedValue(true);
    vi.mocked(checkExpoGoVersionAsync).mockResolvedValue({ verdict: 'match' } as any);

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'android',
      expoGo: true,
      devServerUrl: DEV_SERVER,
    });

    expect(report).toMatchObject({ opened: true, deviceId: 'emulator-5554' });
    expect(androidHasAppAsync).toHaveBeenCalledWith('emulator-5554', 'host.exp.exponent');
  });

  it(`goes no further once the dev server is gone`, async () => {
    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      device: BOUND,
      stillWanted: () => false,
    });

    expect(report.opened).toBe(false);
    expect(report.reason).toContain('dev server stopped');
    expect(openRouteAsync).not.toHaveBeenCalled();
  });

  it(`reports a refused deep link instead of throwing`, async () => {
    vi.mocked(openRouteAsync).mockResolvedValue({
      exitCode: 1,
      command: 'xcrun simctl openurl',
    } as any);

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      device: BOUND,
    });

    expect(report.opened).toBe(false);
    expect(report.reason).toContain('refused the deep link');
  });

  it(`turns a thrown open into a reason, never a rejection`, async () => {
    vi.mocked(openRouteAsync).mockRejectedValue(
      new CommandError('NO_BOUND_DEVICE', 'The bound ios device is gone.\nWhy: gone.')
    );

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      device: BOUND,
    });

    expect(report.opened).toBe(false);
    expect(report.reason).toContain('The bound ios device is gone');
  });
});
