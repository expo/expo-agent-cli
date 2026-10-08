// @ref llp/0027-everything-on-eas.rfc.md §The open is a session
import * as Log from '../../log';
import { probeCloudSessionAsync } from '../../device/cloudSimulator';
import { openRouteAsync, resolveRouteUrlAsync } from '../../navigate/openRoute';
import { resolveEasCli } from '../../utils/easCli';
import { spawnCaptureAsync } from '../../utils/spawnCapture';
import { fetchAdvertisedUrlAsync } from '../advertisedUrl';
import {
  buildLatestSimulatorBuildArgs,
  buildSessionStartArgs,
  findLatestSimulatorBuildIdAsync,
  openAppOnEasAsync,
  readSessionId,
  readSessionUrl,
} from '../openAppEas';

vi.mock('../../log');
vi.mock('../events', () => ({ event: vi.fn(), debugEvent: vi.fn() }));
vi.mock('../advertisedUrl', () => ({ fetchAdvertisedUrlAsync: vi.fn() }));
vi.mock('../../device/cloudSimulator', async () => {
  const actual = await vi.importActual<typeof import('../../device/cloudSimulator')>(
    '../../device/cloudSimulator'
  );
  return { ...actual, probeCloudSessionAsync: vi.fn() };
});
vi.mock('../../navigate/openRoute', () => ({
  openRouteAsync: vi.fn(),
  resolveRouteUrlAsync: vi.fn(),
}));
vi.mock('../../utils/easCli', async () => {
  const actual = await vi.importActual<typeof import('../../utils/easCli')>('../../utils/easCli');
  return { ...actual, resolveEasCli: vi.fn() };
});
vi.mock('../../utils/spawnCapture', () => ({ spawnCaptureAsync: vi.fn() }));

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
        url: 'myapp://expo-development-client/?url=https%3A%2F%2Fabc.tunnel.example',
        label: 'the development build',
      },
    ],
    resolution: 'tunnel',
  } as any);
}

function mockNoSession() {
  vi.mocked(probeCloudSessionAsync).mockResolvedValue({
    state: 'none',
    sessionId: null,
    platform: null,
  } as any);
}

beforeEach(() => {
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
      openUrl: 'myapp://expo-development-client/?url=x',
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
  it(`reads the first build's id`, async () => {
    vi.mocked(spawnCaptureAsync).mockResolvedValue({
      stdout: '[{"id":"build-7","status":"FINISHED","platform":"IOS"}]\n',
      stderr: '',
      exitCode: 0,
      spawnError: null,
    } as any);
    await expect(findLatestSimulatorBuildIdAsync(projectRoot, 'ios', EAS_CLI)).resolves.toBe(
      'build-7'
    );
    expect(vi.mocked(spawnCaptureAsync).mock.calls[0]![1]).toEqual([
      '--yes',
      'eas-cli',
      ...buildLatestSimulatorBuildArgs('ios'),
    ]);
  });

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
  it(`starts a session with Expo Go and the tunnelled exp:// URL, and reports the id`, async () => {
    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
    });

    expect(report).toEqual({
      opened: true,
      sessionId: '11111111-2222-3333-4444-555555555555',
      started: true,
      tunnelHost: 'abc.tunnel.example',
      sessionUrl:
        'https://expo.dev/accounts/e2e/projects/app/simulator-sessions/11111111-2222-3333-4444-555555555555',
      reason: null,
    });
    const [command, args, options] = vi.mocked(spawnCaptureAsync).mock.calls[0]!;
    expect(command).toBe('/usr/bin/npx');
    expect(args).toEqual([
      '--yes',
      'eas-cli',
      ...buildSessionStartArgs({
        platform: 'ios',
        app: { expoGo: true },
        openUrl: 'exp://abc.tunnel.example',
        name: 'my-app — agent-cli dev',
      }),
    ]);
    expect(options).toMatchObject({ cwd: projectRoot });
  });

  it(`starts a session with the build id and the dev-launcher URL for a development build`, async () => {
    await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: false,
      devServerUrl: DEV_SERVER,
      buildId: 'build-1',
    });

    const args = vi.mocked(spawnCaptureAsync).mock.calls[0]![1];
    expect(args).toContain('--build-id');
    expect(args[args.indexOf('--open-url') + 1]).toBe(
      'myapp://expo-development-client/?url=https%3A%2F%2Fabc.tunnel.example'
    );
  });

  it(`refuses to start a session for a development build it cannot name, and says how to build one`, async () => {
    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: false,
      devServerUrl: DEV_SERVER,
      buildId: null,
    });

    expect(report.opened).toBe(false);
    expect(report.reason).toContain(
      'npx --yes eas-cli@latest build --platform ios --profile development-simulator'
    );
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
  });

  it(`reuses a session this project already has on the platform, through the same open navigate runs`, async () => {
    vi.mocked(probeCloudSessionAsync).mockResolvedValue({
      state: 'active',
      sessionId: 'sess-up',
      platform: 'ios',
    } as any);
    vi.mocked(openRouteAsync).mockResolvedValue({
      exitCode: 0,
      command: 'eas simulator:exec',
    } as any);

    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
    });

    expect(report).toMatchObject({ opened: true, sessionId: 'sess-up', started: false });
    expect(openRouteAsync).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({ route: '/', platform: 'ios', cloud: 'required' })
    );
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
  });

  // The tunnel comes up after Metro answers. A deep link sent before it names the loopback, which a
  // session on EAS cannot load.
  it(`waits for the tunnel before it sends the deep link to a session that is up`, async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(probeCloudSessionAsync).mockResolvedValue({
        state: 'active',
        sessionId: 'sess-up',
        platform: 'ios',
      } as any);
      vi.mocked(fetchAdvertisedUrlAsync).mockResolvedValueOnce(null).mockResolvedValue({
        url: 'https://abc.tunnel.example',
        host: 'abc.tunnel.example',
        hostType: 'tunnel',
      });
      vi.mocked(openRouteAsync).mockResolvedValue({
        exitCode: 0,
        command: 'eas simulator:exec',
      } as any);

      const pending = openAppOnEasAsync(projectRoot, {
        platform: 'ios',
        expoGo: true,
        devServerUrl: DEV_SERVER,
        buildId: null,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(openRouteAsync).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();

      expect(await pending).toMatchObject({ opened: true, sessionId: 'sess-up' });
      expect(fetchAdvertisedUrlAsync).toHaveBeenCalledTimes(2);
      expect(openRouteAsync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it(`sends no deep link to a session that is up when no tunnel comes`, async () => {
    vi.mocked(probeCloudSessionAsync).mockResolvedValue({
      state: 'active',
      sessionId: 'sess-up',
      platform: 'ios',
    } as any);
    mockTunnel(null);

    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      waits: { tunnelMs: 1 },
    });

    expect(report).toMatchObject({ opened: false, sessionId: 'sess-up', started: false });
    expect(report.reason).toContain('advertised no tunnel host');
    expect(openRouteAsync).not.toHaveBeenCalled();
  });

  it(`starts a new session when the one up is the other platform`, async () => {
    vi.mocked(probeCloudSessionAsync).mockResolvedValue({
      state: 'active',
      sessionId: 'sess-android',
      platform: 'android',
    } as any);

    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
    });

    expect(report.started).toBe(true);
    expect(openRouteAsync).not.toHaveBeenCalled();
  });

  it(`gives up when the dev server advertises no tunnel inside the wait, and says why`, async () => {
    mockTunnel(null);

    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      waits: { tunnelMs: 1 },
    });

    expect(report.opened).toBe(false);
    expect(report.reason).toContain('advertised no tunnel host');
    // The session was looked for first, and none was up — so the tunnel was needed, and missing.
    expect(probeCloudSessionAsync).toHaveBeenCalled();
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
  });

  it(`stops quietly when the dev server is gone before the tunnel came up`, async () => {
    mockTunnel(null);
    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      stillWanted: () => false,
    });
    expect(report.reason).toContain('dev server stopped');
  });

  it(`names the session a failed start billed, so it can be stopped`, async () => {
    vi.mocked(spawnCaptureAsync).mockResolvedValue({
      stdout: '',
      stderr:
        'Simulator session created (id: sess-billed)\nTimed out after 600s waiting for agent-device session to be ready.\n',
      exitCode: 1,
      spawnError: null,
    } as any);

    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
    });

    expect(report.opened).toBe(false);
    expect(report.sessionId).toBe('sess-billed');
    expect(report.started).toBe(true);
    expect(report.reason).toContain('exited 1');
    expect(report.reason).toContain('npx --yes eas-cli@latest simulator:stop --id sess-billed');
  });

  it(`says when no eas can be run at all`, async () => {
    vi.mocked(resolveEasCli).mockReturnValue(null);
    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
    });
    expect(report.reason).toContain('no package runner');
  });
});

describe('the session half on its own', () => {
  const { ensureEasSessionAsync } = require('../openAppEas') as typeof import('../openAppEas');
  const { buildSessionStopArgs, stopEasSessionAsync } =
    require('../../device/eas') as typeof import('../../device/eas');

  it('describes smoke cleanup without asking the caller to stop its session', async () => {
    await ensureEasSessionAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      cleanupAfterRun: true,
    });
    const messages = vi
      .mocked(Log.progress)
      .mock.calls.map(([message]) => message)
      .join('\n');
    expect(messages).toContain('This run will stop the session afterwards');
    expect(messages).not.toContain('bills until');
  });

  it(`ends a session by id and never bare`, () => {
    expect(buildSessionStopArgs('sess-1')).toEqual([
      'simulator:stop',
      '--id',
      'sess-1',
      '--non-interactive',
    ]);
  });

  it(`reports a stop that took, and quotes one that did not`, async () => {
    vi.mocked(spawnCaptureAsync).mockResolvedValue({
      stdout: 'stopped',
      stderr: '',
      exitCode: 0,
      spawnError: null,
    } as any);
    await expect(stopEasSessionAsync(projectRoot, 'sess-1', EAS_CLI)).resolves.toEqual({
      ok: true,
      reason: null,
    });
    expect(vi.mocked(spawnCaptureAsync).mock.calls[0]![1]).toEqual([
      '--yes',
      'eas-cli',
      ...buildSessionStopArgs('sess-1'),
    ]);

    vi.mocked(spawnCaptureAsync).mockResolvedValue({
      stdout: '',
      stderr: 'Session not found',
      exitCode: 1,
      spawnError: null,
    } as any);
    const failed = await stopEasSessionAsync(projectRoot, 'sess-1', EAS_CLI);
    expect(failed.ok).toBe(false);
    expect(failed.reason).toContain('Session not found');
    await expect(stopEasSessionAsync(projectRoot, 'sess-1', null)).resolves.toMatchObject({
      ok: false,
    });
  });

  it(`names the session it reused, with the URL it would open, and starts nothing`, async () => {
    vi.mocked(probeCloudSessionAsync).mockResolvedValue({
      state: 'active',
      sessionId: 'sess-up',
      platform: 'ios',
    } as any);
    const report = await ensureEasSessionAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
    });
    expect(report).toMatchObject({ ok: true, sessionId: 'sess-up', started: false, openUrl: null });
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
    // Nothing waited on the tunnel: a session that is up is driven by `openRouteAsync`, which
    // resolves the link itself.
    expect(fetchAdvertisedUrlAsync).not.toHaveBeenCalled();
  });

  it(`takes the session name a caller gives it`, async () => {
    await ensureEasSessionAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      sessionName: 'my-app — agent-cli smoke',
    });
    const args = vi.mocked(spawnCaptureAsync).mock.calls[0]![1];
    expect(args[args.indexOf('--name') + 1]).toBe('my-app — agent-cli smoke');
  });
});

describe('worktree session ownership', () => {
  const options = {
    platform: 'ios' as const,
    expoGo: true,
    devServerUrl: DEV_SERVER,
    buildId: null,
  };
  it('a failed listing never starts a billed session', async () => {
    vi.mocked(probeCloudSessionAsync).mockResolvedValue({
      state: 'unknown',
      reason: 'listing timed out',
    } as any);
    const report = await openAppOnEasAsync(projectRoot, options);
    expect(report).toMatchObject({ opened: false, reason: 'listing timed out' });
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
  });
  it('a queued bound session is retained without a replacement start', async () => {
    vi.mocked(probeCloudSessionAsync).mockResolvedValue({
      state: 'queued',
      sessionId: 'queued',
      platform: 'ios',
      source: 'bound',
    } as any);
    expect(await openAppOnEasAsync(projectRoot, options)).toMatchObject({
      opened: false,
      sessionId: 'queued',
    });
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
  });
  it('records a session created before a failed start', async () => {
    const { bindingPathFor, readBindingFile } = await import('../../deviceBinding/registry');
    vi.mocked(spawnCaptureAsync).mockResolvedValue({
      stdout: 'Simulator session created (id: billed)',
      stderr: 'failed readiness',
      exitCode: 1,
    });
    await openAppOnEasAsync(projectRoot, options);
    expect(readBindingFile(bindingPathFor(projectRoot, 'ios', 'cloud'))).toMatchObject({
      binding: { device: { id: 'billed', origin: 'started' } },
    });
  });
  it('retries only an unsupported idle flag before a creation receipt', async () => {
    vi.mocked(spawnCaptureAsync).mockResolvedValueOnce({
      stdout: '',
      stderr: 'Nonexistent flag: --max-idle-time-minutes',
      exitCode: 2,
    });
    expect(await openAppOnEasAsync(projectRoot, options)).toMatchObject({ opened: true });
    expect(spawnCaptureAsync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawnCaptureAsync).mock.calls[1]![1]).not.toContain('--max-idle-time-minutes');
  });
  it('does not retry a flag error once a session was created', async () => {
    vi.mocked(spawnCaptureAsync).mockResolvedValue({
      stdout: 'Simulator session created (id: billed)',
      stderr: 'Nonexistent flag: --max-idle-time-minutes',
      exitCode: 2,
    });
    expect(await openAppOnEasAsync(projectRoot, options)).toMatchObject({
      opened: false,
      sessionId: 'billed',
    });
    expect(spawnCaptureAsync).toHaveBeenCalledTimes(1);
  });
});
