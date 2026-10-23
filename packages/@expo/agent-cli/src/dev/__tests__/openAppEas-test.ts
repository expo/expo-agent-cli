// @ref llp/0027-everything-on-eas.rfc.md §The open is a session
import fs from 'fs';
import * as Log from '../../log';
import simulatorFailures from '../../__fixtures__/eas/simulator-failures.json';
import {
  probeCloudSessionAsync,
  readCloudSessionIdSync,
  type CloudSessionProbe,
} from '../../device/cloudSimulator';
import { cloudProbe } from '../../device/__tests__/fakeCloudProbe';
import { acquireCloudBindingAsync, readCloudBindings } from '../../deviceBinding/cloud';
import { writeCloudBinding } from '../../deviceBinding/__tests__/fakeCloudBinding';
import { registryDirectory } from '../../deviceBinding/registry';
import { openRouteAsync, resolveRouteUrlAsync } from '../../navigate/openRoute';
import { resolveEasCli } from '../../utils/easCli';
import { ensureGitExcludedAsync } from '../../utils/gitExclude';
import { spawnCaptureAsync } from '../../utils/spawnCapture';
import { fetchAdvertisedUrlAsync } from '../advertisedUrl';
import { lookUpEasSimulatorBuildAsync } from '../../plan/easBuildLookup';
import {
  buildLatestSimulatorBuildArgs,
  buildSessionStartArgs,
  easRunLifecycle,
  findLatestSimulatorBuildIdAsync,
  openAppOnEasAsync,
  otherPlatformSessionAsync,
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
vi.mock('../../navigate/openRoute', () => ({
  openRouteAsync: vi.fn(),
  resolveRouteUrlAsync: vi.fn(),
}));
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
      keepSession: true,
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
      keepSession: true,
    });

    const args = vi.mocked(spawnCaptureAsync).mock.calls[0]![1];
    expect(args).toContain('--build-id');
    expect(args[args.indexOf('--open-url') + 1]).toBe(
      'myapp://?__expo_url=https%3A%2F%2Fabc.tunnel.example'
    );
  });

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

  it(`reuses a session this project already has on the platform, through the same open navigate runs`, async () => {
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(
      cloudProbe.active({ id: 'sess-up', platform: 'ios' })
    );
    vi.mocked(openRouteAsync).mockResolvedValue({
      exitCode: 0,
      command: 'eas simulator:exec',
    } as any);

    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
    });

    expect(report).toMatchObject({ opened: true, sessionId: 'sess-up', started: false });
    expect(openRouteAsync).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({ route: '/', platform: 'ios', cloud: 'required' })
    );
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
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

  it('builds a reused session link from the tunnel host just read from the manifest', async () => {
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(
      cloudProbe.active({ id: 'sess-up', platform: 'ios' })
    );
    vi.mocked(openRouteAsync).mockResolvedValue({
      exitCode: 0,
      command: 'eas simulator:exec',
    } as any);
    await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: false,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
    });
    expect(resolveRouteUrlAsync).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({ tunnelHost: 'abc.tunnel.example' })
    );
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

  // The tunnel comes up after Metro answers. A deep link sent before it names the loopback, which a
  // session on EAS cannot load.
  it(`waits for the tunnel before it sends the deep link to a session that is up`, async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(probeCloudSessionAsync).mockResolvedValue(
        cloudProbe.active({ id: 'sess-up', platform: 'ios' })
      );
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
        keepSession: true,
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
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(
      cloudProbe.active({ id: 'sess-up', platform: 'ios' })
    );
    mockTunnel(null);

    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
      waits: { tunnelMs: 1 },
    });

    expect(report).toMatchObject({ opened: false, sessionId: 'sess-up', started: false });
    expect(report.reason).toContain('advertised no tunnel host');
    expect(openRouteAsync).not.toHaveBeenCalled();
  });

  it.each(['active', 'queued'] as const)(
    `refuses a start while this worktree has a %s session on the other platform`,
    async (state) => {
      vi.mocked(probeCloudSessionAsync).mockResolvedValue(
        cloudProbe[state]({ id: 'sess-android', platform: 'android' })
      );

      const report = await openAppOnEasAsync(projectRoot, {
        platform: 'ios',
        expoGo: true,
        devServerUrl: DEV_SERVER,
        buildId: null,
        keepSession: true,
      });

      expect(report).toMatchObject({ opened: false, started: false, sessionId: null });
      expect(report.refusal).toMatchObject({
        code: 'CLOUD_SIMULATOR_PLATFORM_MISMATCH',
        data: { sessionId: 'sess-android', platform: 'android' },
      });
      expect(report.reason).toBe(report.refusal!.message.split('\n')[0]);
      expect(report.refusal!.message).toContain('session sess-android is an Android session');
      expect(report.refusal!.message).toContain('navigate / --eas --android');
      expect(report.refusal!.message).toContain('dev --ios --eas --detach');
      expect(report.refusal!.message).toContain('dev:stop --eas');
      expect(spawnCaptureAsync).not.toHaveBeenCalled();
      expect(openRouteAsync).not.toHaveBeenCalled();
      const { bindingPathFor } = await import('../../deviceBinding/registry');
      expect(fs.existsSync(bindingPathFor(projectRoot, 'ios', 'cloud'))).toBe(false);
    }
  );

  it(`gives up when the dev server advertises no tunnel inside the wait, and says why`, async () => {
    mockTunnel(null);

    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
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
      keepSession: true,
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
      keepSession: true,
    });

    expect(report.opened).toBe(false);
    expect(report.sessionId).toBe('sess-billed');
    expect(report.started).toBe(true);
    expect(report.reason).toContain('exited 1');
    expect(report.reason).toContain('npx --yes eas-cli simulator:stop --id sess-billed');
    const { bindingPathFor, readBindingFile } = await import('../../deviceBinding/registry');
    expect(readBindingFile(bindingPathFor(projectRoot, 'ios', 'cloud'))).toMatchObject({
      binding: { device: { id: 'sess-billed', origin: 'started' } },
    });
  });

  it('quotes a non-TTY startup timeout and preserves the created session for cleanup', async () => {
    vi.mocked(spawnCaptureAsync).mockResolvedValue(simulatorFailures.start);
    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
    });
    expect(report).toMatchObject({ opened: false, started: true, sessionId: 'sess-billed' });
    expect(report.reason).toContain('exited 1: ✖ Timed out');
    expect(report.reason).toContain('simulator:stop --id sess-billed');
    expect(report.sessionUrl).toContain('/simulator-sessions/sess-billed');
  });

  // @ref llp/0021-honest-reports.rfc.md §The rules — rules 11 and 14 [observed — bunx on a
  // half-written scratch directory, 2026-10-05].
  it.each([
    [
      'the first line after the runner progress',
      'Resolving dependencies\nTypeError: (0 , minimatch_1.minimatch) is not a function\n',
      'exited 1: TypeError: (0 , minimatch_1.minimatch) is not a function',
      false,
    ],
    [
      'that the runner did not deliver the CLI when the runner printed nothing else',
      'Resolving dependencies\nResolved, downloaded and extracted [214]\n',
      'failed to deliver the eas CLI',
      true,
    ],
    [
      'the session a cold start created, not that EAS never ran',
      'Resolving dependencies\nSimulator session created (id: sess-billed)\nTimed out after 600s\n',
      'simulator:stop --id sess-billed',
      false,
    ],
  ])(`quotes %s`, async (_, stderr, expected, runnerOnly) => {
    vi.mocked(spawnCaptureAsync).mockResolvedValue({
      stdout: '',
      stderr,
      exitCode: 1,
      spawnError: null,
    } as any);

    const report = await openAppOnEasAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
    });

    expect(report.opened).toBe(false);
    expect(report.reason).toContain(expected);
    expect(report.reason).not.toContain('exited 1: Resolving dependencies');
    expect(report.reason!.includes('failed to deliver the eas CLI')).toBe(runnerOnly);
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
  const { ensureEasSessionAsync } = require('../openAppEas') as typeof import('../openAppEas');
  const { buildSessionStopArgs, stopEasSessionAsync } =
    require('../../device/eas') as typeof import('../../device/eas');

  it('describes smoke cleanup without asking the caller to stop its session', async () => {
    await ensureEasSessionAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: false,
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

  it('quotes the failed stop after non-TTY progress', async () => {
    vi.mocked(spawnCaptureAsync).mockResolvedValue(simulatorFailures.stop);
    const result = await stopEasSessionAsync(projectRoot, 'sess-billed', EAS_CLI);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('exited 1: ✖ Failed to stop simulator session sess-billed');
  });

  it('reports a runner-only stop interrupted by a signal', async () => {
    vi.mocked(spawnCaptureAsync).mockResolvedValue({
      exitCode: null,
      stdout: '',
      stderr: 'Resolving dependencies\n',
    });
    const result = await stopEasSessionAsync(projectRoot, 'sess-billed', EAS_CLI);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('exited on a signal');
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
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(
      cloudProbe.active({ id: 'sess-up', platform: 'ios' })
    );
    const report = await ensureEasSessionAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
    });
    expect(report).toMatchObject({ ok: true, sessionId: 'sess-up', started: false, openUrl: null });
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
    // Nothing waited on the tunnel: a session that is up is driven by `openRouteAsync`, which
    // resolves the link itself.
    expect(fetchAdvertisedUrlAsync).not.toHaveBeenCalled();
  });

  it(`claims an expired binding of its own and reuses its live session`, async () => {
    const { bindingPathFor, readBindingFile } = await import('../../deviceBinding/registry');
    const root = '/project/claim-app';
    const file = bindingPathFor(root, 'ios', 'cloud');
    writeCloudBinding(root, 'ios', 'OLD', {
      boundAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(
      cloudProbe.active({ id: 'OLD', platform: 'ios' })
    );
    const report = await ensureEasSessionAsync(root, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
    });
    expect(probeCloudSessionAsync).toHaveBeenCalledWith(
      expect.objectContaining({ boundIds: ['OLD'] })
    );
    expect(report).toMatchObject({ ok: true, started: false, sessionId: 'OLD' });
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
    const read = readBindingFile(file);
    expect(read.kind === 'binding' && Date.parse(read.binding.expiresAt) > Date.now()).toBe(true);
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

  it(`refuses an unreadable binding before it probes or starts a session`, async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { bindingPathFor } = await import('../../deviceBinding/registry');
    const file = bindingPathFor('/project/garbage-app', 'ios', 'cloud');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'garbage');
    const report = await ensureEasSessionAsync('/project/garbage-app', {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
    });
    expect(report).toMatchObject({ ok: false });
    expect(report.reason).toContain('cannot be read');
    expect(probeCloudSessionAsync).not.toHaveBeenCalled();
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
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

  it(`takes the session name a caller gives it`, async () => {
    await ensureEasSessionAsync(projectRoot, {
      platform: 'ios',
      expoGo: true,
      devServerUrl: DEV_SERVER,
      buildId: null,
      keepSession: true,
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
    keepSession: true,
  };
  it('a failed listing never starts a billed session', async () => {
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(
      cloudProbe.unknown({ reason: 'listing timed out' })
    );
    const report = await openAppOnEasAsync(projectRoot, options);
    expect(report).toMatchObject({ opened: false, reason: 'listing timed out' });
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
  });
  it('a queued bound session is retained without a replacement start', async () => {
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(
      cloudProbe.queued({ id: 'queued', platform: 'ios' })
    );
    expect(await openAppOnEasAsync(projectRoot, options)).toMatchObject({
      opened: false,
      sessionId: 'queued',
      reason: expect.stringContaining(
        'session queued is not up yet (status QUEUED); run this again in a minute'
      ),
    });
    expect(spawnCaptureAsync).not.toHaveBeenCalled();
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

  it(`names a live session of a binding on the other platform`, async () => {
    writeCloudBinding(projectRoot, 'ios', 'i1', { expiresAt: '2999-01-01T00:00:00.000Z' });
    vi.mocked(readCloudSessionIdSync).mockReturnValue(null);
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(
      cloudProbe.active({ id: 'i1', platform: 'ios' })
    );
    await expect(otherPlatformSessionAsync(projectRoot, 'android')).resolves.toEqual({
      sessionId: 'i1',
      platform: 'ios',
    });
    expect(probeCloudSessionAsync).toHaveBeenCalledWith(
      expect.objectContaining({ boundIds: ['i1'], platform: 'android' })
    );
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

// @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
describe(easRunLifecycle, () => {
  const started = '11111111-2222-3333-4444-555555555555';
  const progress = () =>
    vi
      .mocked(Log.progress)
      .mock.calls.map(([line]) => String(line))
      .join('\n');

  async function runAsync(keepSession: boolean, open = true) {
    const onSignal = vi.fn();
    const eas = easRunLifecycle(projectRoot, {
      platform: 'ios',
      expoGo: true,
      keepSession,
      onSignal,
    });
    expect(eas.platform).toBe('ios');
    expect(process.listeners('SIGINT')).toContain(onSignal);
    let settled = false;
    void eas.finished.then(() => (settled = true));
    if (open) eas.open({ devServerUrl: DEV_SERVER, stillWanted: () => true, buildId: null });
    await eas.finishAsync();
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(open);
    expect(process.listeners('SIGINT')).not.toContain(onSignal);
    expect(process.listeners('SIGTERM')).not.toContain(onSignal);
    return readCloudBindings(projectRoot).bindings.map(({ device }) => device.id);
  }

  it(`stops and releases the session a foreground run started`, async () => {
    expect(await runAsync(false)).toEqual([]);

    const stop = vi.mocked(spawnCaptureAsync).mock.calls[1]![1];
    expect(stop).toEqual(expect.arrayContaining(['simulator:stop', started]));
    expect(progress()).toContain('This run stops the session when the dev server exits');
    expect(progress()).toContain(`Stopped EAS Simulator session ${started}`);
  });

  it(`warns with the stop command, and keeps the binding, when the stop fails`, async () => {
    vi.mocked(spawnCaptureAsync).mockImplementation((async (_command: string, args: string[]) =>
      args.includes('simulator:stop')
        ? { stdout: '', stderr: 'boom', exitCode: 1, spawnError: null }
        : {
            stdout: `Simulator session created (id: ${started})`,
            stderr: '',
            exitCode: 0,
            spawnError: null,
          }) as any);

    expect(await runAsync(false)).toEqual([started]);

    const warning = String(vi.mocked(Log.warn).mock.calls.at(-1)![0]);
    expect(warning).toMatch(new RegExp(`^Could not stop EAS Simulator session ${started}: `));
    expect(warning).toContain(`simulator:stop --id ${started}" ends it.`);
  });

  it(`keeps the session and its binding when a detached child started it`, async () => {
    expect(await runAsync(true)).toEqual([started]);

    expect(spawnCaptureAsync).toHaveBeenCalledTimes(1);
    expect(progress()).toContain('It bills until');
  });

  it(`waits for nothing when the open never ran`, async () => {
    expect(await runAsync(false, false)).toEqual([]);

    expect(spawnCaptureAsync).not.toHaveBeenCalled();
    expect(progress()).not.toContain('Finishing EAS session work');
  });

  it(`resolves finished when the open failed`, async () => {
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(
      cloudProbe.active({ id: 'sess-android', platform: 'android' })
    );
    const eas = easRunLifecycle(projectRoot, {
      platform: 'ios',
      expoGo: true,
      keepSession: true,
      onSignal: vi.fn(),
    });

    eas.open({ devServerUrl: DEV_SERVER, stillWanted: () => true, buildId: null });
    await eas.finishAsync();

    await expect(eas.finished).resolves.toBeUndefined();
    expect(readCloudBindings(projectRoot).bindings).toEqual([]);
  });

  it(`prints the whole refusal when the worktree has a session on the other platform`, async () => {
    vi.mocked(probeCloudSessionAsync).mockResolvedValue(
      cloudProbe.active({ id: 'sess-android', platform: 'android' })
    );

    await runAsync(false);

    const warning = String(vi.mocked(Log.warn).mock.calls[0]![0]);
    expect(warning).toMatch(/^--ios names a platform/);
    expect(warning).toContain('How: ');
    // Next to the running dev server, the session is reused with navigate, not a second dev.
    expect(warning).toContain('navigate / --eas --android');
  });
});
