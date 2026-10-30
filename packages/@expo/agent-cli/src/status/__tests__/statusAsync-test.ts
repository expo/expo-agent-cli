import { vol } from 'memfs';

import { resetSettingsCache } from '../../settings';

import * as devLock from '../../devLock';
import * as localDevice from '../../device/localDevice';
import * as deviceBinding from '../../deviceBinding';
import { event } from '../../events';
import * as network from '../../followups/network';
import { lookUpBuildPlatformAsync } from '../../impact/buildCache';
import { compareWithEasBuildAsync } from '../../impact/compare';
import { refineWithChangedFilesAsync } from '../../impact/fromRecord';
import { resolveRuntimeVersionAsync } from '../../impact/runtimeVersion';
import * as Log from '../../log';
import { readAuthPreflightAsync } from '../../needsHuman/preflight';
import { readLastBuildRecord } from '../../plan/lastBuild';
import * as appConfig from '../../project/appConfig';
import { probeProjectStateAsync } from '../../project/probe';
import type { ProjectState } from '../../project/types';
import { type DevServerDiscovery } from '../../runtime/devServer';
import { discoverDevServerAsync } from '../../runtime/discoverDevServer';
import { probeTargetLivenessAsync } from '../../runtime/targetLiveness';
import { waitForBundlerReadyAsync } from '../../runtime/waitReady';
import { getPersistedAgentIdsAsync } from '../../skills/agents';
import { discoverSkillsAsync } from '../../skills/discovery';
import { readInstalledStatusAsync } from '../installed';
import { collectStatusReportAsync, printStatusAsync } from '../statusAsync';

vi.mock('../installed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../installed')>()),
  readInstalledStatusAsync: vi.fn(async () => ({ outcome: 'unknown' as const, platforms: [] })),
}));
vi.mock('../../log');
vi.mock('../../events', () => ({ event: vi.fn(), debugEvent: vi.fn() }));
vi.mock('../../project/probe', () => ({ probeProjectStateAsync: vi.fn() }));
vi.mock('../../plan/lastBuild', () => ({ readLastBuildRecord: vi.fn(() => ({})) }));
vi.mock('../../runtime/discoverDevServer', () => ({ discoverDevServerAsync: vi.fn() }));
vi.mock('../../runtime/waitReady', () => ({ waitForBundlerReadyAsync: vi.fn() }));
// The liveness probe opens one debugger socket per listed target (F56). These tests are about the
// report; the probe has its own suite. Every listed target answers unless a case says otherwise.
vi.mock('../../runtime/targetLiveness', () => ({
  probeTargetLivenessAsync: vi.fn(async (targets: unknown[]) => ({
    listed: targets.length,
    live: targets.length,
    stale: [],
  })),
}));
// The preflight spawns `eas whoami`; these tests are about the report, not about the machine the
// suite happens to run on.
vi.mock('../../needsHuman/preflight', () => ({ readAuthPreflightAsync: vi.fn() }));
vi.mock('../../skills/discovery', () => ({ discoverSkillsAsync: vi.fn(async () => []) }));
// The network call and `expo config`, mocked so these tests spawn neither.
vi.mock('../easBuilds', async () => ({
  ...((await vi.importActual('../easBuilds')) as object),
  readEasBuildsStatusAsync: vi.fn(async () => ({ askedEas: false, platforms: [] })),
  platformsToFingerprintEarly: vi.fn(() => []),
}));
vi.mock('../../impact/fromRecord', async () => ({
  ...((await vi.importActual('../../impact/fromRecord')) as object),
  refineWithChangedFilesAsync: vi.fn(async () => null),
}));
vi.mock('../../impact/compare', () => ({ compareWithEasBuildAsync: vi.fn() }));
// Which platform the named build was made for. One EAS call, on the `--build` path only, and a
// null from it means the comparison is attributed to no platform at all (S1).
vi.mock('../../impact/buildCache', async () => ({
  ...((await vi.importActual('../../impact/buildCache')) as object),
  lookUpBuildPlatformAsync: vi.fn(async () => null),
}));
vi.mock('../../utils/easCli', () => ({
  resolveEasCliOrThrow: vi.fn(() => ({
    command: 'npx',
    prefixArgs: ['--yes', 'eas-cli'],
    source: 'npx --yes eas-cli',
    runner: 'npx',
    pinned: false,
    global: false,
  })),
  // The spelling every printed EAS command line carries (llp/0015 §Resolving the EAS CLI).
  easCommandPrefix: () => 'npx --yes eas-cli',
}));
vi.mock('../../impact/runtimeVersion', () => ({
  resolveRuntimeVersionAsync: vi.fn(async () => ({
    policy: 'appVersion',
    literal: null,
    source: 'app.json',
  })),
  resolveOtaSafety: vi.fn(() => ({
    safe: true,
    runtimeVersion: { policy: 'appVersion', literal: null, source: 'app.json' },
    why: 'The runtimeVersion policy is "appVersion".',
  })),
}));
vi.mock('../../skills/agents', async () => ({
  ...(await vi.importActual('../../skills/agents')),
  getPersistedAgentIdsAsync: vi.fn(async () => null),
}));

const projectRoot = '/project';
const devServerUrl = 'http://127.0.0.1:8081';
const options = { devServerUrl };

function mockState(overrides: Partial<ProjectState> = {}): ProjectState {
  const state: ProjectState = {
    projectRoot,
    isExpoApp: true,
    sdkVersion: '54.0.0',
    nativeDirs: { ios: false, android: false },
    usesDevClient: false,
    hasWeb: true,
    expoGo: { compatible: true, reasons: [] },
    fingerprint: { hash: 'abcdef0123456789' },
    ...overrides,
  };
  vi.mocked(probeProjectStateAsync).mockResolvedValue(state);
  return state;
}

beforeEach(() => {
  vol.reset();
  resetSettingsCache();
  // The connect URLs of a non-tunnelled run carry this host, and a suite that read the machine's
  // own would pass or fail by which network it is on.
  vi.spyOn(network, 'resolveLanHost').mockReturnValue('192.168.1.233');
  // Whether `dev` binds a device here is a fact about the host; the rule must not read this one's.
  vi.spyOn(deviceBinding, 'hostBindsPlatform').mockReturnValue(true);
  vi.spyOn(devLock, 'readDevServerLockAsync').mockResolvedValue(null);
  vol.fromJSON({ '/project/package.json': JSON.stringify({ name: 'my-app' }) });
  mockState();
  vi.mocked(readLastBuildRecord).mockReturnValue({});
  vi.mocked(readAuthPreflightAsync).mockResolvedValue({
    loggedIn: true,
    user: 'alice',
    source: 'eas whoami',
  });
  vi.mocked(discoverDevServerAsync).mockResolvedValue({
    reachable: true,
    targets: [{} as any],
    devServerUrl,
    source: 'default',
    discovered: false,
  });
  vi.mocked(waitForBundlerReadyAsync).mockResolvedValue({
    ready: true,
    projectRootMatched: true,
    reportedProjectRoot: projectRoot,
    timedOut: false,
    waitedMs: 1,
  });
  vi.mocked(discoverSkillsAsync).mockResolvedValue([]);
  vi.mocked(getPersistedAgentIdsAsync).mockResolvedValue(null);
  // `clearMocks` clears calls and not implementations, so a `mockRejectedValue` set by one test
  // would otherwise outlive it. These two are re-established rather than left to the factory.
  vi.mocked(refineWithChangedFilesAsync).mockResolvedValue(null);
  vi.mocked(resolveRuntimeVersionAsync).mockResolvedValue({
    policy: 'appVersion',
    literal: null,
    source: 'app.json',
  });
});

// Section isolation. No reader below throws in a real run: the probe, the auth preflight and the
// runtime-version read each turn their own failures into an answer. So no e2e case reaches these
// wrappers, and this table is what proves one broken section costs one line and never the shape.
describe(printStatusAsync, () => {
  const broken = new Error('broken');

  it.each([
    {
      section: 'project',
      fail: () => vi.mocked(probeProjectStateAsync).mockRejectedValue(broken),
      nulls: ['project', 'expoGo', 'freshness', 'next', 'probe'],
    },
    {
      section: 'auth',
      fail: () => vi.mocked(readAuthPreflightAsync).mockRejectedValue(broken),
      nulls: ['auth'],
    },
    {
      section: 'freshness',
      fail: () => vi.mocked(resolveRuntimeVersionAsync).mockRejectedValue(broken),
      nulls: ['freshness.ota'],
    },
  ])('notes a $section section it could not read, and reports the rest', async (row) => {
    row.fail();

    await printStatusAsync(projectRoot, { ...options, json: true });

    expect(Log.log).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(vi.mocked(Log.log).mock.calls[0]![0] as string);
    expect(Object.keys(printed)).toEqual([
      'project',
      'expoGo',
      'freshness',
      'installed',
      'builds',
      'devServer',
      'device',
      'binding',
      'orphanSessions',
      'skills',
      'auth',
      'next',
      'assertion',
      'probe',
      'errors',
      'followups',
    ]);
    expect(printed.errors).toEqual({ [row.section]: 'broken' });
    for (const key of row.nulls) {
      expect(key.split('.').reduce((value, part) => value?.[part], printed)).toBeNull();
    }
    if (row.section !== 'project') {
      expect(printed.project).not.toBeNull();
      expect(printed.freshness.hash).toBe('abcdef0123456789');
    }
    // A project that could not be probed has no freshness to judge an update against.
    expect(resolveRuntimeVersionAsync).toHaveBeenCalledTimes(row.section === 'project' ? 0 : 1);
    expect(printed.devServer.running).toBe(true);
    expect(printed.skills).not.toBeNull();
    expect(event).toHaveBeenCalledWith(
      'status',
      expect.objectContaining({
        rule: row.section === 'project' ? null : 'expo-go',
        sectionErrors: [row.section],
      })
    );
  });
});

describe(collectStatusReportAsync, () => {
  // `status` has no platform flag, so only this input reaches the branch: a platform the caller
  // names is a stated fact, and no EAS lookup overrules it.
  it(`takes the platform the caller named for --build without asking EAS`, async () => {
    vi.mocked(compareWithEasBuildAsync).mockResolvedValue({
      base: { label: 'EAS build build-1', hash: 'base-hash' },
      head: { label: 'working tree', hash: 'base-hash' },
      items: [],
      fingerprintChanged: false,
      caveats: [],
      error: null,
    });

    const report = await collectStatusReportAsync(projectRoot, {
      ...options,
      buildId: 'build-1',
      platform: 'android',
    });

    expect(lookUpBuildPlatformAsync).not.toHaveBeenCalled();
    expect(report.freshness?.comparison.platform).toBe('android');
  });

  // An e2e case would need a phone that answers after the 15 s default, so the hand-over is
  // checked here.
  it(`hands a phone the default answer time, or the one --device-timeout named`, async () => {
    await collectStatusReportAsync(projectRoot, options);
    expect(readInstalledStatusAsync).toHaveBeenLastCalledWith(
      projectRoot,
      expect.objectContaining({ timeoutMs: 15_000 })
    );

    await collectStatusReportAsync(projectRoot, {
      ...options,
      device: "Ada's iPhone",
      installedTimeoutMs: 45_000,
    });
    expect(readInstalledStatusAsync).toHaveBeenLastCalledWith(
      projectRoot,
      expect.objectContaining({ device: "Ada's iPhone", timeoutMs: 45_000 })
    );
  });
});

describe('status retains discovery results at its deadline', () => {
  // Exercise real discovery and project-root checks; only the transport and unrelated report
  // sections are doubles. Every request gets 100 ms, but the whole ladder only gets 200 ms.
  const target = { webSocketDebuggerUrl: 'ws://app' } as any;
  const abortTimers = new Set<ReturnType<typeof setTimeout>>();
  let discoveryWork: Promise<DevServerDiscovery>;
  let discoverySettled: boolean;
  let aborted: string[];

  beforeEach(async () => {
    vi.useFakeTimers();
    aborted = [];
    discoverySettled = false;
    // Native AbortSignal.timeout uses a different clock from fake setTimeout. Put both budgets
    // on this clock, tracking the signal timers separately because native ones cannot be cleared.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        abortTimers.delete(timer);
        controller.abort(new DOMException('timed out', 'TimeoutError'));
      }, ms);
      abortTimers.add(timer);
      return controller.signal;
    });
    // Answered at once, so the probe's budget starts where the advances below count from.
    vi.spyOn(appConfig, 'readEasProject').mockReturnValue({ kind: 'unlinked', source: null });
    vi.spyOn(devLock, 'readDevServerLockAsync').mockResolvedValue(null);
    vi.spyOn(localDevice, 'probeLocalDeviceAsync').mockResolvedValue({
      state: 'absent',
      device: null,
      devices: [],
      reason: null,
    });
    vi.mocked(probeTargetLivenessAsync).mockImplementation(async (targets) => ({
      listed: targets.length,
      live: targets.length,
      stale: [],
    }));
    const actual = await vi.importActual<typeof import('../../runtime/discoverDevServer')>(
      '../../runtime/discoverDevServer'
    );
    vi.mocked(discoverDevServerAsync).mockImplementation((...args) => {
      discoveryWork = actual.discoverDevServerAsync(...args);
      void discoveryWork.then(() => {
        discoverySettled = true;
      });
      return discoveryWork;
    });
  });

  afterEach(() => {
    abortTimers.clear();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function mockSlowScan({
    targets = [target],
    root = projectRoot,
    unanswered = false,
    lateMatch = false,
  }: {
    targets?: (typeof target)[];
    root?: string | null;
    unanswered?: boolean;
    lateMatch?: boolean;
  } = {}) {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new URL(String(input));
      const key = `${url.port}${url.pathname}`;
      const status = url.pathname === '/status';
      if (!['8081', '8082', '8083', '8084'].includes(url.port)) {
        return Promise.reject(new Error('ECONNREFUSED'));
      }
      const hang = url.port === '8084' || (url.port === '8082' && status && unanswered);
      const delay = url.port === '8082' ? 0 : 60;
      const reportedRoot =
        url.port === '8082'
          ? root
          : url.port === '8083' && lateMatch
            ? projectRoot
            : '/other-project';
      const answer = () =>
        status
          ? new Response('', {
              headers: reportedRoot == null ? {} : { 'X-React-Native-Project-Root': reportedRoot },
            })
          : new Response(JSON.stringify(url.port === '8082' ? targets : [target]));
      return new Promise<Response>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          aborted.push(key);
          // An uncooperative late response must not replace the report's chosen server.
          if (lateMatch && url.port === '8083' && status) return;
          clearTimeout(timer);
          reject(new Error('aborted'));
        };
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener('abort', onAbort, { once: true });
        if (!hang) {
          timer = setTimeout(() => {
            init?.signal?.removeEventListener('abort', onAbort);
            resolve(answer());
          }, delay);
        }
      });
    });
  }

  function expectProbeTimersCleared() {
    // Discard only our simulated native signal timers; probe/report and fetch timers must have
    // been cleared by the code or the abort-aware transport, without advancing to their deadlines.
    for (const timer of abortTimers) clearTimeout(timer);
    abortTimers.clear();
    expect(vi.getTimerCount()).toBe(0);
  }

  it.each([
    { name: 'an attached app', targets: [target] },
    { name: 'no attached app', targets: [] },
  ])(
    'keeps a matching server with $name and cancels both pending request stages',
    async ({ targets }) => {
      mockSlowScan({ targets });
      // Do not reuse `options`: its explicit URL would bypass the scan being tested.
      const pendingReport = collectStatusReportAsync(projectRoot, {
        devServerUrl: null,
        devServerTimeoutMs: 100,
      });
      await vi.advanceTimersByTimeAsync(199);
      expect(discoverySettled).toBe(false);
      expect(aborted).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      const report = await pendingReport;

      expect(report.devServer).toMatchObject({
        running: true,
        url: 'http://127.0.0.1:8082',
        source: 'scan',
        appsListed: targets.length,
        appsConnected: targets.length,
      });
      expect(aborted.sort()).toEqual(['8083/status', '8084/json/list']);
      expect(discoverySettled).toBe(true);
      expect(await discoveryWork).toMatchObject({ devServerUrl: 'http://127.0.0.1:8082' });
      expect(
        vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith('8083/status'))
      ).toHaveLength(1);
      expectProbeTimersCleared();
    }
  );

  it('keeps the existing compatibility with servers that send no project-root header', async () => {
    mockSlowScan({ root: null });
    vi.mocked(waitForBundlerReadyAsync).mockResolvedValue({
      ready: true,
      projectRootMatched: null,
      reportedProjectRoot: null,
      timedOut: false,
      waitedMs: 0,
    });
    const pendingReport = collectStatusReportAsync(projectRoot, {
      devServerUrl: null,
      devServerTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect((await pendingReport).devServer).toMatchObject({
      running: true,
      url: 'http://127.0.0.1:8082',
      source: 'scan',
      projectRootMatched: null,
    });
    expectProbeTimersCleared();
  });

  it.each([
    { name: 'foreign', root: '/other-project', unanswered: false },
    { name: 'unanswered', root: projectRoot, unanswered: true },
  ])('does not retain a $name project check', async ({ root, unanswered }) => {
    mockSlowScan({ root, unanswered });
    const pendingReport = collectStatusReportAsync(projectRoot, {
      devServerUrl: null,
      devServerTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect((await pendingReport).devServer).toMatchObject({
      running: false,
      source: 'default',
      reason: expect.stringContaining('did not answer'),
    });
    expect(discoverySettled).toBe(true);
    expectProbeTimersCleared();
  });

  it('returns without waiting for a late preferred candidate and keeps its chosen result', async () => {
    mockSlowScan({ targets: [], lateMatch: true });
    const pendingReport = collectStatusReportAsync(projectRoot, {
      devServerUrl: null,
      devServerTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(200);
    const report = await pendingReport;
    expect(report.devServer).toMatchObject({
      running: true,
      url: 'http://127.0.0.1:8082',
      appsListed: 0,
    });
    expect(discoverySettled).toBe(false);
    await vi.advanceTimersByTimeAsync(40);
    expect(discoverySettled).toBe(true);
    expect(report.devServer).toMatchObject({
      running: true,
      url: 'http://127.0.0.1:8082',
      appsListed: 0,
    });
    expectProbeTimersCleared();
  });
});
