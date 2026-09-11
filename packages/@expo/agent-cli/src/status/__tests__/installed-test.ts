// @ref llp/0028-installed-app-check.rfc.md §Reported by status
// The `installed` section is the one part of `status` that reads a device, so the two things worth
// pinning are that it reads none without `--explain`, and that it never asks a phone unasked.
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
  it(`reads no device without --explain`, async () => {
    await expect(
      readInstalledStatusAsync(projectRoot, { lookUp: false })
    ).resolves.toBeNull();

    expect(checkInstalledAppAsync).not.toHaveBeenCalled();
  });

  it(`asks every platform this host can reach`, async () => {
    await readInstalledStatusAsync(projectRoot, { lookUp: true, hostPlatform: 'darwin' });

    expect(checkInstalledAppAsync).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({ platforms: ['android', 'ios'] })
    );
  });

  it(`asks only Android off macOS, where no iOS simulator exists`, async () => {
    await readInstalledStatusAsync(projectRoot, { lookUp: true, hostPlatform: 'linux' });

    expect(checkInstalledAppAsync).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({ platforms: ['android'] })
    );
  });

  it(`names no device unless the caller did, which is what keeps a phone unprobed`, async () => {
    await readInstalledStatusAsync(projectRoot, { lookUp: true, hostPlatform: 'darwin' });

    expect(checkInstalledAppAsync).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({ device: null })
    );
  });

  it(`passes the device the caller named through`, async () => {
    await readInstalledStatusAsync(projectRoot, {
      lookUp: true,
      hostPlatform: 'darwin',
      device: "Ada's iPhone",
    });

    expect(checkInstalledAppAsync).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({ device: "Ada's iPhone" })
    );
  });

  it(`reports one row per platform that answered`, async () => {
    const status = await readInstalledStatusAsync(projectRoot, {
      lookUp: true,
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
