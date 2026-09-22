// @ref llp/0004-smart-start-and-project-state.rfc.md §Reported by status
// The `installed` section is the one part of `status` that reads a device, so what is pinned here
// is which platforms it asks, that it names no device the caller did not, and the section's shape.
import { checkInstalledAppAsync } from '../../installedApp/installedAppAsync';
import { readInstalledStatusAsync } from '../installed';

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
        prebuildStatus: 'fresh',
        prebuildChanges: [],
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
          prebuildStatus: 'fresh',
          prebuildChanges: [],
        },
      ],
    });
  });
});
