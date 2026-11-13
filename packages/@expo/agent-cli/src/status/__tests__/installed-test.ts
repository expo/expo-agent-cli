// @ref llp/0004-smart-start-and-project-state.rfc.md §Reported by status
// The `installed` section is the one part of `status` that reads a device, so what is pinned here
// is which platforms it asks, that it names no device the caller did not, and the section's shape.
import { checkInstalledAppAsync } from '../../installedApp/installedAppAsync';
import { readInstalledStatusAsync, withCloudSessions } from '../installed';

vi.mock('../../installedApp/installedAppAsync', () => ({ checkInstalledAppAsync: vi.fn() }));

const projectRoot = '/app';

beforeEach(() => {
  vi.mocked(checkInstalledAppAsync).mockResolvedValue({
    outcome: 'up-to-date',
    platforms: {
      ios: {
        status: 'up-to-date',
        reason: 'hash-match',
        recommendation: 'The app matches the project.',
        commands: [],
        device: { name: 'iPhone 17', identifier: 'UDID-1' },
        installedHash: 'h',
        currentHash: 'h',
        fingerprintSource: 'computed',
      },
    },
  });
});

afterEach(() => vi.clearAllMocks());

describe(readInstalledStatusAsync, () => {
  it(`asks every platform this host can reach`, async () => {
    await readInstalledStatusAsync(projectRoot, { device: null, hostPlatform: 'darwin' });

    expect(checkInstalledAppAsync).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({ platforms: ['android', 'ios'] })
    );
  });

  it(`asks only Android off macOS, where no iOS simulator exists`, async () => {
    await readInstalledStatusAsync(projectRoot, { device: null, hostPlatform: 'linux' });

    expect(checkInstalledAppAsync).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({ platforms: ['android'] })
    );
  });

  it(`passes the device the caller named through, and names none otherwise`, async () => {
    await readInstalledStatusAsync(projectRoot, { device: null, hostPlatform: 'darwin' });
    expect(checkInstalledAppAsync).toHaveBeenLastCalledWith(
      projectRoot,
      expect.objectContaining({ device: null })
    );

    await readInstalledStatusAsync(projectRoot, { device: 'Pixel_9', hostPlatform: 'darwin' });
    expect(checkInstalledAppAsync).toHaveBeenLastCalledWith(
      projectRoot,
      expect.objectContaining({ device: 'Pixel_9' })
    );
  });

  it(`reports one row per platform that answered`, async () => {
    const status = await readInstalledStatusAsync(projectRoot, {
      device: null,
      hostPlatform: 'darwin',
    });

    expect(status).toEqual({
      outcome: 'up-to-date',
      platforms: [
        {
          platform: 'ios',
          status: 'up-to-date',
          reason: 'hash-match',
          recommendation: 'The app matches the project.',
          commands: [],
          deviceName: 'iPhone 17',
          installedHash: 'h',
          currentHash: 'h',
        },
      ],
    });
  });
});

// @ref llp/0035-one-device-per-worktree.rfc.md §Session binding
describe(withCloudSessions, () => {
  const noDevice = (platform: 'ios' | 'android') => ({
    platform,
    status: 'unknown' as const,
    reason: 'no-device',
    recommendation: 'No device is booted.',
    commands: [`npx @expo/agent-cli dev --${platform}`],
    deviceName: null,
    installedHash: null,
    currentHash: null,
  });

  it(`marks the no-device row of the session's own platform only`, () => {
    const status = withCloudSessions(
      { outcome: 'unknown', platforms: [noDevice('ios'), noDevice('android')] },
      [{ platform: 'android', id: 'sess-1' }]
    );

    expect(status.platforms).toEqual([
      noDevice('ios'),
      {
        ...noDevice('android'),
        reason: 'cloud-session',
        recommendation:
          'not checked; this check reads local devices, and the app runs on EAS Simulator session sess-1',
        commands: [],
      },
    ]);
  });

  it(`keeps a row that read a local device`, () => {
    const stale = {
      ...noDevice('ios'),
      status: 'rebuild-required' as const,
      reason: 'hash-mismatch',
    };

    expect(
      withCloudSessions({ outcome: 'rebuild-required', platforms: [stale] }, [
        { platform: 'ios', id: 'sess-1' },
      ]).platforms
    ).toEqual([stale]);
  });
});
