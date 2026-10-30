import { releaseWorktreeDevicesAsync } from '../../deviceBinding';
import { keptDevices, unreadableBindingFiles } from '../../deviceBinding/records';
import { reapDevicesAsync } from '../../deviceBinding/reap';
import { readDevServerLockAsync } from '../../devLock';
import { PROGRAM_PREFIX } from '../../programName';
import { isPortInUseAsync } from '../portListener';
import { resolveDevStopOptions } from '../resolveStopOptions';
import { devStopAsync } from '../stopAsync';
import { lockInfo } from '../../devLock/__tests__/fakeLock';
import { mockPlatform } from '../../utils/__tests__/mockPlatform';

vi.mock('../../deviceBinding', () => ({
  devicesDisabled: () => false,
  releaseWorktreeDevicesAsync: vi.fn(async () => []),
}));
vi.mock('../../deviceBinding/records', () => ({
  keptDevices: vi.fn(() => []),
  unreadableBindingFiles: vi.fn(() => []),
}));
vi.mock('../../deviceBinding/reap', () => ({
  reapDevicesAsync: vi.fn(async () => ({ reports: [], error: null })),
}));
vi.mock('../../devLock', () => {
  const readDevServerLockAsync = vi.fn(async (_projectRoot: string): Promise<unknown> => null);
  return {
    readDevServerLockAsync,
    isDevServerLockHeldAsync: vi.fn(
      async (projectRoot: string) => (await readDevServerLockAsync(projectRoot)) != null
    ),
  };
});
vi.mock('../portListener', () => ({
  isPortInUseAsync: vi.fn(async () => false),
  findPortListenerAsync: vi.fn(async () => null),
}));

const root = '/work/app';
const lock = lockInfo({
  pid: 4141,
  port: 8081,
  url: 'http://127.0.0.1:8081',
  projectRoot: root,
  startedAt: '2026-10-08T10:00:00Z',
});
const device = {
  backend: 'local-ios' as const,
  platform: 'ios' as const,
  id: 'SIM',
  name: 'sim',
  released: null,
  shutDown: false,
  reason: null,
};
let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as unknown as typeof fetch;
  vi.mocked(readDevServerLockAsync).mockResolvedValue(null);
  vi.mocked(keptDevices).mockReturnValue([device]);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
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

it.each([
  [
    'releases when no own lock is held and the listener is not a dev server',
    '8081',
    null,
    false,
    [
      [root, { platform: 'ios' }],
      [root, { platform: 'android' }],
    ],
    null,
  ],
  [
    "keeps devices while this worktree's lock is on another port",
    '8082',
    lock,
    false,
    [],
    expect.stringContaining("this worktree's dev server is still running"),
  ],
  [
    'keeps devices when the listener answers as an Expo dev server',
    '8081',
    null,
    true,
    [],
    expect.stringContaining('a dev server this worktree did not lock answers on port 8081'),
  ],
])(
  'release beside a listener on --port %s',
  async (_case, port, ownLock, answers, releases, deviceError) => {
    vi.mocked(readDevServerLockAsync).mockResolvedValue(ownLock);
    if (answers) {
      globalThis.fetch = (async () =>
        new Response('packager-status:running')) as unknown as typeof fetch;
    } else {
      vi.mocked(isPortInUseAsync).mockResolvedValueOnce(true);
    }
    vi.mocked(releaseWorktreeDevicesAsync).mockImplementation(async (_root, options) =>
      options?.platform === 'ios' ? [{ ...device, released: true, shutDown: true }] : []
    );
    const onReport = vi.fn();
    await devStopAsync(
      root,
      resolveDevStopOptions(['--port', port, '--release', '--no-followups']),
      { print: false, onReport }
    );
    expect(vi.mocked(releaseWorktreeDevicesAsync).mock.calls).toEqual(releases);
    expect(onReport).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'foreign-dev-server', deviceError })
    );
  }
);

it('release-keeps-devices-when-server-is-replaced after a successful stop', async () => {
  vi.mocked(readDevServerLockAsync)
    .mockResolvedValueOnce(lock)
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ ...lock, pid: 4242 });
  // The fixture mocks process.kill, so exercise the Unix signalling branch on every CI host.
  mockPlatform('darwin');
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

it('release reports an unreadable binding file instead of succeeding', async () => {
  vi.mocked(unreadableBindingFiles).mockReturnValueOnce([
    { platform: 'ios', backend: 'local-ios', file: '/expo-home/agent-cli/bindings/x.json' },
  ]);
  const onReport = vi.fn();
  const code = await devStopAsync(root, resolveDevStopOptions(['--release', '--no-followups']), {
    print: false,
    onReport,
  });
  expect(code).toBe(20);
  expect(onReport.mock.calls[0]![0].deviceError).toContain(
    '/expo-home/agent-cli/bindings/x.json does not parse'
  );
});

it('release keeps an earlier platform released when a later one throws', async () => {
  const android = {
    ...device,
    backend: 'local-android' as const,
    platform: 'android' as const,
    id: 'emulator-5554',
    name: 'emulator-5554',
  };
  vi.mocked(keptDevices).mockReturnValue([device, android]);
  vi.mocked(releaseWorktreeDevicesAsync).mockImplementation(async (_root, options) => {
    if (options?.platform === 'android') throw new Error('the registry lock stayed busy');
    return [{ ...device, released: true, shutDown: true }];
  });
  const onReport = vi.fn();
  await devStopAsync(root, resolveDevStopOptions(['--release', '--no-followups']), {
    print: false,
    onReport,
  });
  const report = onReport.mock.calls[0]![0];
  expect(report.devices).toEqual([
    expect.objectContaining({ id: 'SIM', released: true, shutDown: true }),
    expect.objectContaining({ id: 'emulator-5554', released: null }),
  ]);
  expect(report.deviceError).toBe('the registry lock stayed busy');
});

it('tells a device it could not release from one it kept, in JSON and on the human line', async () => {
  const android = {
    ...device,
    backend: 'local-android' as const,
    platform: 'android' as const,
    id: 'emulator-5554',
    name: 'emulator-5554',
  };
  vi.mocked(keptDevices).mockReturnValue([device, android]);
  vi.mocked(releaseWorktreeDevicesAsync).mockImplementation(async (_root, options) =>
    options?.platform === 'ios' ? [{ ...device, released: false, reason: 'shutdown failed' }] : []
  );
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const onReport = vi.fn();
  try {
    await devStopAsync(root, resolveDevStopOptions(['--release', '--no-followups']), {
      print: true,
      onReport,
    });
    const report = onReport.mock.calls[0]![0];
    expect(report.devices).toEqual([
      expect.objectContaining({ id: 'SIM', released: false, reason: 'shutdown failed' }),
      expect.objectContaining({ id: 'emulator-5554', released: null }),
    ]);
    const lines = [
      ...out.mock.calls.map((call) => call.join(' ')),
      ...stdout.mock.calls.map((call) => String(call[0]).trimEnd()),
    ];
    expect(lines).toContain('Could not release sim: shutdown failed');
    expect(lines).toContain('Kept emulator-5554.');
  } finally {
    out.mockRestore();
    stdout.mockRestore();
    errors.mockRestore();
  }
});

it.each([
  [
    "the stop's when the stop failed",
    () => vi.mocked(readDevServerLockAsync).mockResolvedValue(lock),
    'How: run this command again with a longer --timeout',
    'Devices were kept',
  ],
  [
    "the release's when only the release failed",
    () =>
      vi
        .mocked(releaseWorktreeDevicesAsync)
        .mockImplementation(async (_root, options) =>
          options?.platform === 'ios'
            ? [{ ...device, released: false, reason: 'shutdown failed' }]
            : []
        ),
    `How: run "${PROGRAM_PREFIX} dev:stop --release" again.`,
    'Some devices could not be released',
  ],
])(
  'dev:stop --release ends stderr with one How line, %s',
  async (_case, arrange, expectedHow, sentence) => {
    arrange();
    mockPlatform('darwin');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await devStopAsync(root, {
        ...resolveDevStopOptions(['--release', '--no-followups']),
        timeoutMs: 200,
      });
      expect(code).toBe(20);
      const stderr = errors.mock.calls.map((call) => call.join(' ')).join('\n');
      const how = stderr.split('\n').filter((line) => line.startsWith('How:'));
      expect(how).toEqual([expect.stringContaining(expectedHow)]);
      expect(stderr).toContain(sentence);
    } finally {
      errors.mockRestore();
      out.mockRestore();
      kill.mockRestore();
    }
  }
);

it.each(['cleanup', 'registry'])(
  'reports a %s reap failure and preserves its device results',
  async (failure) => {
    const error = 'reap failed';
    const reaped = [
      {
        ...device,
        released: failure === 'registry',
        shutDown: failure === 'registry',
        ...(failure === 'cleanup' ? { error } : {}),
      },
    ];
    vi.mocked(reapDevicesAsync).mockResolvedValueOnce({
      reports: reaped,
      error: failure === 'registry' ? error : null,
    });
    const onReport = vi.fn();
    const code = await devStopAsync(root, resolveDevStopOptions(['--no-followups']), {
      print: false,
      onReport,
    });
    expect(code).toBe(20);
    expect(onReport).toHaveBeenCalledWith(expect.objectContaining({ reaped, deviceError: error }));
  }
);
