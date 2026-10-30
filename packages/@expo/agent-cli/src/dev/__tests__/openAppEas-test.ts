// @ref llp/0027-everything-on-eas.rfc.md §The open is a session
import fs from 'fs';
import {
  probeCloudSessionAsync,
  readCloudSessionIdSync,
  type CloudSessionProbe,
} from '../../device/cloudSimulator';
import { cloudProbe } from '../../device/__tests__/fakeCloudProbe';
import { acquireCloudBindingAsync } from '../../deviceBinding/cloud';
import { writeCloudBinding } from '../../deviceBinding/__tests__/fakeCloudBinding';
import { registryDirectory } from '../../deviceBinding/registry';
import { openRouteAsync } from '../../navigate/openRoute';
import { resolveRouteUrlAsync } from '../../navigate/routeResolution';
import { resolveEasCli } from '../../utils/easCli';
import { ensureGitExcludedAsync } from '../../utils/gitExclude';
import { spawnCaptureAsync } from '../../utils/spawnCapture';
import { fetchAdvertisedUrlAsync } from '../advertisedUrl';
import { lookUpEasSimulatorBuildAsync } from '../../plan/easBuildLookup';
import {
  buildLatestSimulatorBuildArgs,
  findLatestSimulatorBuildIdAsync,
  openAppOnEasAsync,
  otherPlatformSessionAsync,
} from '../openAppEas';
import { buildSessionStartArgs, readSessionId, readSessionUrl } from '../easSession';

vi.mock('../../log');
vi.mock('../events', () => ({ event: vi.fn(), debugEvent: vi.fn() }));
vi.mock('../advertisedUrl', () => ({ fetchAdvertisedUrlAsync: vi.fn() }));
vi.mock('../../device/cloudSimulator', async () => {
  const actual = await vi.importActual<typeof import('../../device/cloudSimulator')>(
    '../../device/cloudSimulator'
  );
  return {
    ...actual,
    probeCloudSessionAsync: vi.fn(),
    readCloudSessionIdSync: vi.fn(actual.readCloudSessionIdSync),
  };
});
vi.mock('../../deviceBinding/cloud', async () => {
  const actual = await vi.importActual<typeof import('../../deviceBinding/cloud')>(
    '../../deviceBinding/cloud'
  );
  return {
    ...actual,
    acquireCloudBindingAsync: vi.fn(actual.acquireCloudBindingAsync),
  };
});
vi.mock('../../navigate/openRoute', () => ({ openRouteAsync: vi.fn() }));
vi.mock('../../navigate/routeResolution', () => ({ resolveRouteUrlAsync: vi.fn() }));
vi.mock('../../utils/easCli', async () => {
  const actual = await vi.importActual<typeof import('../../utils/easCli')>('../../utils/easCli');
  return { ...actual, resolveEasCli: vi.fn() };
});
vi.mock('../../utils/spawnCapture', () => ({ spawnCaptureAsync: vi.fn() }));
vi.mock('../../plan/easBuildLookup', () => ({ lookUpEasSimulatorBuildAsync: vi.fn() }));
// No test here runs real git.
vi.mock('../../utils/gitExclude', () => ({
  ensureGitExcludedAsync: vi.fn(async () => ({ result: 'skipped' })),
}));

const projectRoot = '/project/my-app';
const DEV_SERVER = 'http://127.0.0.1:8081';
const EAS_CLI = {
  command: '/usr/bin/npx',
  prefixArgs: ['--yes', 'eas-cli'],
  source: 'npx --yes eas-cli',
} as any;

function mockTunnel(host: string | null) {
  vi.mocked(fetchAdvertisedUrlAsync).mockResolvedValue(
    host ? { url: `https://${host}`, host, hostType: 'tunnel' } : null
  );
}

function mockConnectUrls() {
  vi.mocked(resolveRouteUrlAsync).mockResolvedValue({
    connect: [
      { target: 'expo-go', url: 'exp://abc.tunnel.example', label: 'Expo Go' },
      {
        target: 'dev-build',
        url: 'myapp://?__expo_url=https%3A%2F%2Fabc.tunnel.example',
        label: 'the development build',
      },
    ],
    resolution: 'tunnel',
  } as any);
}

function mockNoSession() {
  vi.mocked(probeCloudSessionAsync).mockResolvedValue(cloudProbe.none());
}

beforeEach(() => {
  fs.rmSync(registryDirectory(), { recursive: true, force: true });
  vi.mocked(resolveEasCli).mockReturnValue(EAS_CLI);
  mockTunnel('abc.tunnel.example');
  mockConnectUrls();
  mockNoSession();
  vi.mocked(spawnCaptureAsync).mockResolvedValue({
    stdout:
      'Simulator session created (id: 11111111-2222-3333-4444-555555555555) https://expo.dev/accounts/e2e/projects/app/simulator-sessions/11111111-2222-3333-4444-555555555555\n',
    stderr: '',
    exitCode: 0,
    spawnError: null,
  } as any);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe(buildSessionStartArgs, () => {
  it(`names Expo Go and the URL to open, on the eas simulator command`, () => {
    expect(
      buildSessionStartArgs({
        platform: 'ios',
        app: { expoGo: true },
        openUrl: 'exp://abc.tunnel.example',
        name: 'my-app — agent-cli dev',
      })
    ).toEqual([
      'simulator',
      '--platform',
      'ios',
      '--type',
      'agent-device',
      '--expo-go',
      '--open-url',
      'exp://abc.tunnel.example',
      '--non-interactive',
      '--name',
      'my-app — agent-cli dev',
      '--max-idle-time-minutes',
      '30',
    ]);
  });

  it(`names a build by id for a development build`, () => {
    const args = buildSessionStartArgs({
      platform: 'android',
      app: { expoGo: false, buildId: 'build-1' },
      openUrl: 'myapp://?__expo_url=x',
      name: 'n',
    });
    expect(args).toContain('--build-id');
    expect(args[args.indexOf('--build-id') + 1]).toBe('build-1');
    expect(args).not.toContain('--expo-go');
  });
});

describe(buildLatestSimulatorBuildArgs, () => {
  it(`asks for the newest finished build of the simulator profile`, () => {
    expect(buildLatestSimulatorBuildArgs('ios')).toEqual([
      'build:list',
      '--platform',
      'ios',
      '--build-profile',
      'development-simulator',
      '--status',
      'finished',
      '--limit',
      '1',
      '--json',
      '--non-interactive',
    ]);
  });
});

describe(readSessionId, () => {
  it(`reads the id out of the created line, which comes before the readiness wait`, () => {
    expect(readSessionId('🚀 Simulator session created (id: abc-123) https://expo.dev/x\n')).toBe(
      'abc-123'
    );
  });
  it(`reads the line the dotenv-writing form prints, which carries a suffix after the id`, () => {
    // [observed — live, expo-ci, 2026-09-08]
    expect(
      readSessionId(
        '✔ Simulator session created (id: 01a08318-958d-7369-a88e-ab94a2c55fae, saved to .env.eas-simulator) https://expo.dev/accounts/expo-ci/projects/expo-agent-cli/simulator-sessions/01a08318-958d-7369-a88e-ab94a2c55fae\n'
      )
    ).toBe('01a08318-958d-7369-a88e-ab94a2c55fae');
  });
  it('ignores an older session named by an overwrite warning', () => {
    const warning = 'Overwriting previous simulator session (id: sess-old).';
    expect(
      readSessionId(
        `${warning}\nSimulator session created (id: sess-new, saved to .env.eas-simulator)`
      )
    ).toBe('sess-new');
    expect(readSessionId(warning)).toBeNull();
  });
  it(`falls back to the id in the session page's URL`, () => {
    expect(
      readSessionId('see https://expo.dev/accounts/e/projects/p/simulator-sessions/abc-1 for it\n')
    ).toBe('abc-1');
  });
  it(`reads the --json form`, () => {
    expect(readSessionId('progress\n{"id":"sess-json","type":"agent-device"}\n')).toBe('sess-json');
  });
  it(`answers null for output with no session in it`, () => {
    expect(readSessionId('Error: not logged in\n')).toBeNull();
  });
});

describe(readSessionUrl, () => {
  it(`finds the session page`, () => {
    expect(
      readSessionUrl(
        'created (id: a) https://expo.dev/accounts/e/projects/p/simulator-sessions/a\n'
      )
    ).toBe('https://expo.dev/accounts/e/projects/p/simulator-sessions/a');
  });
});

describe(findLatestSimulatorBuildIdAsync, () => {
  it(`answers null for an empty list, a refusal, or no CLI`, async () => {
    vi.mocked(spawnCaptureAsync).mockResolvedValue({
      stdout: '[]',
      stderr: '',
      exitCode: 0,
      spawnError: null,
    } as any);
    await expect(findLatestSimulatorBuildIdAsync(projectRoot, 'ios', EAS_CLI)).resolves.toBeNull();
    vi.mocked(spawnCaptureAsync).mockResolvedValue({
      stdout: '',
      stderr: 'refused',
      exitCode: 1,
      spawnError: null,
    } as any);
    await expect(findLatestSimulatorBuildIdAsync(projectRoot, 'ios', EAS_CLI)).resolves.toBeNull();
    await expect(findLatestSimulatorBuildIdAsync(projectRoot, 'ios', null)).resolves.toBeNull();
  });
});

describe(openAppOnEasAsync, () => {
  it(`refuses to start a session for a development build it cannot name, and says how to build one`, async () => {
    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: false,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
    });

    expect(report.opened).toBe(false);
    expect(report.reason).toContain(
      'npx --yes eas-cli build --platform ios --profile development-simulator'
    );
    expect(lookUpEasSimulatorBuildAsync).toHaveBeenCalledTimes(1);
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
  });

  it(`looks up the build of a development build with no id only when it starts a session`, async () => {
    vi.mocked(lookUpEasSimulatorBuildAsync).mockResolvedValue({
      id: 'found-build',
      profile: 'development-simulator',
    });

    await openAppOnEasAsync(projectRoot, {
      platform: 'android',
      expoGo: false,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
      fingerprintCache: false,
    });

    expect(lookUpEasSimulatorBuildAsync).toHaveBeenCalledWith(projectRoot, 'android', {
      fingerprintCache: false,
    });
    const args = vi.mocked(spawnCaptureAsync).mock.calls[0]![1];
    expect(args[args.indexOf('--build-id') + 1]).toBe('found-build');
  });

  it.each([
    ['a named build', { expoGo: false, buildId: 'build-1' }, 'none'],
    ['Expo Go', { expoGo: true, buildId: null }, 'none'],
    ['a reused session', { expoGo: false, buildId: null }, 'active'],
  ] as const)(`looks up no build for %s`, async (_case, app, state) => {
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(
      state === 'active' ? cloudProbe.active({ id: 'sess-up', platform: 'ios' }) : cloudProbe.none()
    );
    vi.mocked(openRouteAsync).mockResolvedValue({ exitCode: 0, command: 'x' } as any);

    await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      devServerUrl: DEV_SERVER,
      keepSession: true,
      ...app,
    });

    expect(lookUpEasSimulatorBuildAsync).not.toHaveBeenCalled();
  });

  it('does not send a bare route when a reused development build has no connection URL', async () => {
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(
      cloudProbe.active({ id: 'sess-up', platform: 'ios' })
    );
    vi.mocked(resolveRouteUrlAsync).mockResolvedValue({ connect: [], resolution: 'scheme' } as any);

    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: false,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
    });

    expect(report).toMatchObject({ opened: false, sessionId: 'sess-up', started: false });
    expect(report.reason).toContain('no URL to point the development build at this dev server');
    expect(openRouteAsync).not.toHaveBeenCalled();
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
  });

  it.each(['http://127.0.0.1:8081', 'http://192.168.1.2:8081', 'https://old.tunnel.example'])(
    'refuses a reused development-client URL pointing at %s instead of the current tunnel',
    async (origin) => {
      vi.mocked(probeCloudSessionAsync).mockResolvedValue(
        cloudProbe.active({ id: 'sess-up', platform: 'ios' })
      );
      vi.mocked(resolveRouteUrlAsync).mockResolvedValue({
        connect: [
          {
            target: 'dev-build',
            url: `myapp://?__expo_url=${encodeURIComponent(origin)}`,
          },
        ],
      } as any);
      const report = await openAppOnEasAsync(projectRoot, {
        platform: 'ios',
        expoGo: false,
        devServerUrl: DEV_SERVER,
        buildId: null,
        keepSession: true,
      });
      expect(report.opened).toBe(false);
      expect(report.reason).toContain('does not point at the current tunnel');
      expect(report.reason).not.toContain('retry');
      expect(openRouteAsync).not.toHaveBeenCalled();
      expect(spawnCaptureAsync).not.toHaveBeenCalled();
    }
  );

  // The wait is injected: the real one is two minutes, which no e2e run can afford.
  it.each([
    ['a session that is up', cloudProbe.active({ id: 'sess-up', platform: 'ios' })],
    ['no session', cloudProbe.none()],
  ])('gives up when the dev server advertises no tunnel inside the wait (%s)', async (_, probe) => {
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(probe);
    mockTunnel(null);

    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
      waits: { tunnelMs: 1 },
    });

    expect(report).toMatchObject({ opened: false, started: false });
    expect(report.reason).toContain('advertised no tunnel host');
    expect(openRouteAsync).not.toHaveBeenCalled();
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
  });

  it(`stops quietly when the dev server is gone before the tunnel came up`, async () => {
    mockTunnel(null);
    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
      stillWanted: () => false,
    });
    expect(report.reason).toContain('dev server stopped');
  });

  it(`says when no eas can be run at all`, async () => {
    vi.mocked(resolveEasCli).mockReturnValue(null);
    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
    });
    expect(report.reason).toContain('no package runner');
  });
});

describe('the session half on its own', () => {
  const { ensureEasSessionAsync } = require('../easSession') as typeof import('../easSession');
  const { stopEasSessionAsync } = require('../../device/eas') as typeof import('../../device/eas');

  it(`says no session can be stopped when no eas can be run`, async () => {
    await expect(stopEasSessionAsync(projectRoot, 'sess-1', null)).resolves.toMatchObject({
      ok: false,
    });
  });

  // The renewal before the probe protects a live session from a reap. A session the listing does
  // not show is not one, so a failed open must not leave its binding renewed for another hour.
  it(`puts back the lease it renewed when the probe does not list that session`, async () => {
    const { bindingPathFor, readBindingFile } = await import('../../deviceBinding/registry');
    const root = '/project/stale-claim-app';
    const file = bindingPathFor(root, 'ios', 'cloud');
    const expiresAt = new Date(Date.now() - 30 * 60_000).toISOString();
    writeCloudBinding(root, 'ios', 'OLD', {
      boundAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      expiresAt,
    });
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(cloudProbe.inactive('OLD'));
    mockTunnel(null);

    const report = await ensureEasSessionAsync(root, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
      waits: { tunnelMs: 1 },
    });

    expect(report.ok).toBe(false);
    const read = readBindingFile(file);
    expect(read.kind === 'binding' && read.binding.expiresAt).toBe(expiresAt);
  });

  it(`ends its own session when a concurrent start in this worktree owns the dotenv`, async () => {
    const fs = await import('fs');
    const { acquireCloudBindingAsync } = await import('../../deviceBinding/cloud');
    const { bindingPathFor, readBindingFile } = await import('../../deviceBinding/registry');
    const root = '/project/race-app';
    fs.mkdirSync(root, { recursive: true });
    vi.mocked(spawnCaptureAsync).mockImplementation((async (_command: string, args: string[]) => {
      if (args.includes('simulator')) {
        await acquireCloudBindingAsync(root, { platform: 'ios', id: 'A', origin: 'started' });
        fs.writeFileSync(`${root}/.env.eas-simulator`, 'EAS_SIMULATOR_SESSION_ID=A\n');
        return { stdout: 'Simulator session created (id: B)', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }) as any);
    const report = await ensureEasSessionAsync(root, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
    });
    expect(report).toMatchObject({ ok: false, sessionId: null, started: false });
    expect(report.reason).toContain('session A');
    expect(readBindingFile(bindingPathFor(root, 'ios', 'cloud'))).toMatchObject({
      binding: { device: { id: 'A' } },
    });
    expect(
      vi.mocked(spawnCaptureAsync).mock.calls.some(([, args]) => args.includes('simulator:stop'))
    ).toBe(true);
  });

  // @ref llp/0035-one-device-per-worktree.rfc.md §Session binding — a session no binding records belongs to no run
  describe('a session this run started and could not record', () => {
    const started = '11111111-2222-3333-4444-555555555555';
    const options = {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
    } as const;
    const stopCalls = () =>
      vi.mocked(spawnCaptureAsync).mock.calls.filter(([, args]) => args.includes('simulator:stop'));

    beforeEach(() => {
      vi.mocked(acquireCloudBindingAsync).mockRejectedValue(new Error('lock wait timed out'));
    });

    it(`stops it when no binding in this worktree records it`, async () => {
      const report = await ensureEasSessionAsync(projectRoot, options);
      expect(stopCalls()).toHaveLength(1);
      expect(stopCalls()[0]![1]).toEqual(
        expect.arrayContaining(['simulator:stop', '--id', started])
      );
      expect(report).toMatchObject({ ok: false, started: false, sessionId: null });
      expect(report.reason).toContain('stopped it');
    });

    it(`keeps it started, and names the stop, when the stop fails`, async () => {
      vi.mocked(spawnCaptureAsync).mockImplementation((async (_command: string, args: string[]) =>
        args.includes('simulator:stop')
          ? { stdout: '', stderr: 'boom', exitCode: 1, spawnError: null }
          : {
              stdout: `Simulator session created (id: ${started})`,
              stderr: '',
              exitCode: 0,
              spawnError: null,
            }) as any);
      const report = await ensureEasSessionAsync(projectRoot, options);
      expect(report).toMatchObject({ ok: false, started: true, sessionId: started });
      expect(report.reason).toContain(`simulator:stop --id ${started}`);
    });

    it(`keeps it when another run in this worktree bound it before the stop`, async () => {
      vi.mocked(acquireCloudBindingAsync).mockImplementation(async () => {
        writeCloudBinding(projectRoot, 'ios', started, { origin: 'dotenv' });
        throw new Error('lock wait timed out');
      });
      const report = await ensureEasSessionAsync(projectRoot, options);
      expect(stopCalls()).toHaveLength(0);
      expect(report).toMatchObject({ ok: false, started: false, sessionId: started });
      expect(report.reason).toContain('another run in this worktree recorded it, so it stays');
      expect(report.reason).not.toContain('simulator:stop');
    });
  });

  // @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
  describe('a session start that returns after Metro stopped', () => {
    const root = '/project/late-app';
    const id = '11111111-2222-3333-4444-555555555555';
    let wanted: boolean;
    const options = {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
      stillWanted: () => wanted,
    } as const;
    const bound = async () => {
      const { bindingPathFor, readBindingFile } = await import('../../deviceBinding/registry');
      return readBindingFile(bindingPathFor(root, 'ios', 'cloud')).kind === 'binding';
    };
    const listingAfterStart = (probe: CloudSessionProbe) =>
      vi
        .mocked(probeCloudSessionAsync)
        .mockResolvedValueOnce(cloudProbe.none())
        .mockResolvedValueOnce(probe);

    beforeEach(() => {
      wanted = true;
      vi.mocked(spawnCaptureAsync).mockImplementation((async () => {
        wanted = false;
        return { stdout: `Simulator session created (id: ${id})`, stderr: '', exitCode: 0 };
      }) as any);
    });

    it(`binds nothing when the listing no longer shows the session`, async () => {
      listingAfterStart(cloudProbe.inactive(id));
      const report = await ensureEasSessionAsync(root, options);
      expect(probeCloudSessionAsync).toHaveBeenLastCalledWith(
        expect.objectContaining({ boundIds: [id] })
      );
      expect(report).toMatchObject({ ok: false });
      expect(report.reason).toContain('nothing is bound');
      expect(await bound()).toBe(false);
    });

    it(`still keeps the env file the start wrote out of git`, async () => {
      listingAfterStart(cloudProbe.inactive(id));
      await ensureEasSessionAsync(root, options);
      expect(ensureGitExcludedAsync).toHaveBeenCalledWith(root, '.env.eas-simulator');
    });

    it(`binds the session when the listing cannot be read`, async () => {
      listingAfterStart(cloudProbe.unknown());
      const report = await ensureEasSessionAsync(root, options);
      expect(report).toMatchObject({ ok: true, sessionId: id });
      expect(await bound()).toBe(true);
    });

    it(`binds the session when the listing still shows it`, async () => {
      listingAfterStart(cloudProbe.queued({ id, platform: 'ios' }));
      const report = await ensureEasSessionAsync(root, options);
      expect(report).toMatchObject({ ok: true, sessionId: id });
      expect(await bound()).toBe(true);
    });

    it(`lists nothing more while the run is still wanted`, async () => {
      vi.mocked(spawnCaptureAsync).mockResolvedValue({
        stdout: `Simulator session created (id: ${id})`,
        stderr: '',
        exitCode: 0,
      } as any);
      const report = await ensureEasSessionAsync(root, options);
      expect(report).toMatchObject({ ok: true, sessionId: id });
      expect(probeCloudSessionAsync).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(spawnCaptureAsync).mock.calls.some(([, args]) => args.includes('simulator:list'))
      ).toBe(false);
      expect(await bound()).toBe(true);
    });
  });
});

// @ref llp/0035-one-device-per-worktree.rfc.md §One session per worktree
describe(otherPlatformSessionAsync, () => {
  it(`asks nothing when this worktree has no binding and no dotenv`, async () => {
    vi.mocked(readCloudSessionIdSync).mockReturnValue(null);
    await expect(otherPlatformSessionAsync(projectRoot, 'android')).resolves.toBeNull();
    expect(probeCloudSessionAsync).not.toHaveBeenCalled();
  });

  it(`asks nothing when the only binding and the dotenv are on the asked platform`, async () => {
    writeCloudBinding(projectRoot, 'android', 'a1');
    vi.mocked(readCloudSessionIdSync).mockReturnValue('a1');
    await expect(otherPlatformSessionAsync(projectRoot, 'android')).resolves.toBeNull();
    expect(probeCloudSessionAsync).not.toHaveBeenCalled();
  });

  it(`names a session that reports no platform, as the open refuses it`, async () => {
    vi.mocked(readCloudSessionIdSync).mockReturnValue('x1');
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(cloudProbe.active({ id: 'x1' }));
    await expect(otherPlatformSessionAsync(projectRoot, 'android')).resolves.toEqual({
      sessionId: 'x1',
      platform: null,
    });

    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'android',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
    });
    expect(report.refusal).toMatchObject({
      code: 'CLOUD_SIMULATOR_PLATFORM_MISMATCH',
      data: { sessionId: 'x1', platform: null },
    });
    expect(report.refusal!.message).toContain('did not report its platform');
  });

  it(`leaves the answer to the child when discovery is unsure`, async () => {
    writeCloudBinding(projectRoot, 'ios', 'i1', { expiresAt: '2999-01-01T00:00:00.000Z' });
    vi.mocked(readCloudSessionIdSync).mockReturnValue(null);
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(cloudProbe.unknown());
    await expect(otherPlatformSessionAsync(projectRoot, 'android')).resolves.toBeNull();
  });
});
