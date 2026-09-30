import { resolveClaimedDeviceAsync } from '../../device/claimedDevice';
import { checkExpoGoVersionAsync } from '../../device/expoGoVersion';
import { installExpoGoAsync } from '../../device/installExpoGo';
import { simulatorHasAppAsync } from '../../device/installedApps';
import { androidHasAppAsync } from '../../device/androidApps';
import { openRouteAsync } from '../../navigate/openRoute';
import { CommandError } from '../../utils/errors';
import { openAppOnDeviceAsync } from '../openApp';

vi.mock('../../log');
vi.mock('../events', () => ({ event: vi.fn(), debugEvent: vi.fn() }));
vi.mock('../../device/claimedDevice', () => ({ resolveClaimedDeviceAsync: vi.fn() }));
vi.mock('../../device/expoGoVersion', () => ({ checkExpoGoVersionAsync: vi.fn() }));
vi.mock('../../device/installExpoGo', () => ({ installExpoGoAsync: vi.fn() }));
vi.mock('../../device/installedApps', () => ({ simulatorHasAppAsync: vi.fn() }));
vi.mock('../../device/androidApps', () => ({ androidHasAppAsync: vi.fn() }));
vi.mock('../../navigate/openRoute', () => ({ openRouteAsync: vi.fn() }));
vi.mock('../../project/nodeModules', () => ({ readSdkVersionAsync: vi.fn(async () => '54.0.0') }));

const projectRoot = '/project';
const DEV_SERVER = 'http://127.0.0.1:8081';

function mockClaimed({
  id = 'UDID-1',
  booted = false,
  backend = 'local-ios' as 'local-ios' | 'local-android',
} = {}) {
  vi.mocked(resolveClaimedDeviceAsync).mockResolvedValue({
    ok: true,
    backend,
    id,
    name: 'iPhone',
    claim: {} as any,
    booted,
    choice: 'this worktree claimed it already',
    hasApp: null,
    adb: null,
  });
}

function mockBootedSimulator(udid = 'UDID-1') {
  mockClaimed({ id: udid });
}

function mockRefused(
  kind: 'no-device' | 'no-tool' | 'boot-failed',
  reason: string,
  message = reason
) {
  vi.mocked(resolveClaimedDeviceAsync).mockResolvedValue({
    ok: false,
    kind,
    reason,
    error: new CommandError('X', message),
    deviceId: null,
    name: null,
    holders: [],
  });
}

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
  it(`opens on the simulator this worktree claims`, async () => {
    mockBootedSimulator();

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
    });

    expect(report).toMatchObject({ opened: true, deviceId: 'UDID-1', booted: false, reason: null });
    expect(resolveClaimedDeviceAsync).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'ios', projectRoot, allowBoot: true })
    );
    expect(openRouteAsync).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({
        route: '/',
        platform: 'ios',
        devServerUrl: DEV_SERVER,
        devServerUrlSource: 'discovered',
      })
    );
  });

  it(`reports the boot when the claimed device had to be booted`, async () => {
    mockClaimed({ id: 'UDID-2', booted: true });

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
    });

    expect(report).toMatchObject({ opened: true, deviceId: 'UDID-2', booted: true });
  });

  it(`stops with the claim's own reason when no device comes up`, async () => {
    mockRefused('boot-failed', 'no simulator runtime is installed');

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
    });

    expect(report).toMatchObject({ opened: false, reason: 'no simulator runtime is installed' });
    expect(openRouteAsync).not.toHaveBeenCalled();
  });

  it(`stops on a missing device tool with the tool's headline`, async () => {
    mockRefused(
      'no-tool',
      'could not run "xcrun simctl"',
      'Could not run "xcrun simctl".\nWhy: not found.'
    );

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
    });

    expect(report.opened).toBe(false);
    expect(report.reason).toBe('Could not run "xcrun simctl".');
  });

  it(`installs Expo Go when the device has not got it`, async () => {
    mockBootedSimulator();
    vi.mocked(simulatorHasAppAsync).mockResolvedValue(false);

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
    });

    expect(installExpoGoAsync).toHaveBeenCalledWith('UDID-1', 'ios', '54.0.0');
    expect(report).toMatchObject({ opened: true, installedExpoGo: true });
  });

  it(`replaces an Expo Go whose version does not match the SDK's release`, async () => {
    mockBootedSimulator();
    vi.mocked(checkExpoGoVersionAsync).mockResolvedValue({ verdict: 'mismatch' } as any);

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
    });

    expect(installExpoGoAsync).toHaveBeenCalled();
    expect(report.opened).toBe(true);
  });

  it(`installs nothing for a development build, whose install is a build`, async () => {
    mockBootedSimulator();

    await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: false,
      devServerUrl: DEV_SERVER,
    });

    expect(simulatorHasAppAsync).not.toHaveBeenCalled();
    expect(installExpoGoAsync).not.toHaveBeenCalled();
    expect(openRouteAsync).toHaveBeenCalled();
  });

  it(`asks adb on Android, through the same door`, async () => {
    mockClaimed({ id: 'emulator-5554', backend: 'local-android' });
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
    mockBootedSimulator();

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      stillWanted: () => false,
    });

    expect(report.opened).toBe(false);
    expect(report.reason).toContain('dev server stopped');
    expect(openRouteAsync).not.toHaveBeenCalled();
  });

  it(`reports a refused deep link instead of throwing`, async () => {
    mockBootedSimulator();
    vi.mocked(openRouteAsync).mockResolvedValue({
      exitCode: 1,
      command: 'xcrun simctl openurl',
    } as any);

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
    });

    expect(report.opened).toBe(false);
    expect(report.reason).toContain('refused the deep link');
  });

  it(`turns a thrown open into a reason, never a rejection`, async () => {
    mockBootedSimulator();
    vi.mocked(openRouteAsync).mockRejectedValue(
      new CommandError('NO_IOS_DEVICE', 'No booted iOS simulator was found.\nWhy: gone.')
    );

    const report = await openAppOnDeviceAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
    });

    expect(report.opened).toBe(false);
    expect(report.reason).toContain('No booted iOS simulator');
  });
});
