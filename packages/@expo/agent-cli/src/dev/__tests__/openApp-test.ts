import { checkExpoGoVersionAsync } from '../../device/expoGoVersion';
import { installExpoGoAsync } from '../../device/installExpoGo';
import { simulatorHasAppAsync } from '../../device/installedApps';
import { androidHasAppAsync } from '../../device/androidApps';
import type { BoundDevice } from '../../deviceBinding';
import { openRouteAsync } from '../../navigate/openRoute';
import { CommandError } from '../../utils/errors';
import { openAppOnDeviceAsync } from '../openApp';

vi.mock('../../log');
vi.mock('../events', () => ({ event: vi.fn(), debugEvent: vi.fn() }));
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

const BOUND_EMULATOR: BoundDevice = {
  backend: 'local-android',
  platform: 'android',
  serial: 'emulator-5554',
  origin: { kind: 'spawned', avd: 'Pixel_9', port: 5554, emulatorPid: 4242 },
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

  it.each([
    ['ios', 'iOS simulator'],
    ['android', 'Android emulator instance'],
  ] as const)(`stops on %s with no bound device`, async (platform, noun) => {
    const report = await openAppOnDeviceAsync(projectRoot, {
      platform,
      expoGo: true,
      devServerUrl: DEV_SERVER,
    });

    expect(report).toMatchObject({ opened: false, reason: `no ${noun} is bound to this worktree` });
    expect(openRouteAsync).not.toHaveBeenCalled();
  });

  it(`opens on the bound emulator instance, asking adb through the same door`, async () => {
    vi.mocked(androidHasAppAsync).mockResolvedValue(true);

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'android',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      device: BOUND_EMULATOR,
      justBooted: true,
    });

    expect(report).toMatchObject({ opened: true, deviceId: 'emulator-5554', booted: true });
    expect(androidHasAppAsync).toHaveBeenCalledWith('emulator-5554', 'host.exp.exponent');
    expect(openRouteAsync).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({ platform: 'android', device: BOUND_EMULATOR })
    );
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
