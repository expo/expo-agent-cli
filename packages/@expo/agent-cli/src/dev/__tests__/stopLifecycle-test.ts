import { releaseWorktreeDevicesAsync } from '../../deviceBinding';
import { keptDevices } from '../../deviceBinding/records';
import { reapDevicesAsync } from '../../deviceBinding/reap';
import { readDevServerLockAsync } from '../../devLock';
import { resolveDevStopOptions } from '../resolveStopOptions';
import { devStopAsync } from '../stopAsync';

vi.mock('../../deviceBinding', () => ({
  devicesDisabled: () => false,
  releaseWorktreeDevicesAsync: vi.fn(async () => []),
}));
vi.mock('../../deviceBinding/records', () => ({ keptDevices: vi.fn(() => []) }));
vi.mock('../../deviceBinding/reap', () => ({ reapDevicesAsync: vi.fn(async () => []) }));
vi.mock('../../devLock', () => ({ readDevServerLockAsync: vi.fn(async () => null) }));
vi.mock('../portListener', () => ({
  isPortInUseAsync: vi.fn(async () => false),
  findPortListenerAsync: vi.fn(async () => null),
}));

const root = '/work/app';
const host = process.platform;
const lock = {
  pid: 4141,
  port: 8081,
  url: 'http://127.0.0.1:8081',
  projectRoot: root,
  startedAt: '2026-10-08T10:00:00Z',
};
const device = {
  backend: 'local-ios' as const,
  platform: 'ios' as const,
  id: 'SIM',
  name: 'sim',
  released: false,
  shutDown: false,
  reason: null,
};
beforeEach(() => {
  vi.mocked(readDevServerLockAsync).mockResolvedValue(null);
  vi.mocked(keptDevices).mockReturnValue([device]);
});

it('release-keeps-devices-when-own-server-runs-on-another-port', async () => {
  vi.mocked(readDevServerLockAsync).mockResolvedValue(lock);
  const onReport = vi.fn();
  const code = await devStopAsync(
    root,
    resolveDevStopOptions(['--port', '8082', '--release', '--no-followups']),
    { print: false, onReport }
  );
  expect(code).toBe(20);
  expect(releaseWorktreeDevicesAsync).not.toHaveBeenCalled();
  expect(onReport).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: 'not-running',
      devices: [device],
      deviceError: expect.stringContaining('still running'),
    })
  );
  expect(reapDevicesAsync).toHaveBeenCalledTimes(1);
});

it('release-keeps-devices-when-server-is-replaced after a successful stop', async () => {
  vi.mocked(readDevServerLockAsync)
    .mockResolvedValueOnce(lock)
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ ...lock, pid: 4242 });
  // The fixture mocks process.kill, so exercise the Unix signalling branch on every CI host.
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  const onReport = vi.fn();
  try {
    expect(
      await devStopAsync(root, resolveDevStopOptions(['--release', '--no-followups']), {
        print: false,
        onReport,
      })
    ).toBe(20);
    expect(onReport).toHaveBeenCalledWith(
      expect.objectContaining({ stopped: true, devices: [device] })
    );
    expect(releaseWorktreeDevicesAsync).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
    Object.defineProperty(process, 'platform', { value: host });
  }
});

it('dev-stop-keeps-without-release and dev-stop-reaps-once', async () => {
  const onReport = vi.fn();
  expect(
    await devStopAsync(root, resolveDevStopOptions(['--no-followups']), { print: false, onReport })
  ).toBe(0);
  expect(onReport).toHaveBeenCalledWith(expect.objectContaining({ devices: [device] }));
  expect(releaseWorktreeDevicesAsync).not.toHaveBeenCalled();
  expect(reapDevicesAsync).toHaveBeenCalledTimes(1);
});

it('releases only the requested internal platform once its own server is absent', async () => {
  vi.mocked(releaseWorktreeDevicesAsync).mockResolvedValue([
    { ...device, released: true, shutDown: true },
  ]);
  const options = {
    ...resolveDevStopOptions(['--release', '--no-followups']),
    platform: 'ios' as const,
  };
  expect(await devStopAsync(root, options, { print: false })).toBe(0);
  expect(releaseWorktreeDevicesAsync).toHaveBeenCalledWith(root, { platform: 'ios' });
  expect(reapDevicesAsync).toHaveBeenCalledTimes(1);
});
