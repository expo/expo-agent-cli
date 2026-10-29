import fs from 'fs';
import { vol } from 'memfs';
import { stripVTControlCharacters } from 'node:util';
import path from 'path';

import { detachedPidLine } from '../../dev/childVerdict';
import { recordLastDevRequest } from '../../dev/lastRequest';
import { detachedLogPath } from '../../dev/logFile';
import { resolveDevOptions } from '../../dev/resolveOptions';
import { resetSettingsCache } from '../../settings';

import * as devLock from '../../devLock';
import * as localDevice from '../../device/localDevice';
import * as deviceBinding from '../../deviceBinding';
import { writeCloudBinding } from '../../deviceBinding/__tests__/fakeCloudBinding';
import { bindingPathFor } from '../../deviceBinding/registry';
import * as summary from '../../deviceBinding/summary';
import { event } from '../../events';
import * as network from '../../followups/network';
import { lookUpBuildPlatformAsync } from '../../impact/buildCache';
import { compareWithEasBuildAsync } from '../../impact/compare';
import { refineWithChangedFilesAsync } from '../../impact/fromRecord';
import { resolveRuntimeVersionAsync } from '../../impact/runtimeVersion';
import * as Log from '../../log';
import { readAuthPreflightAsync } from '../../needsHuman/preflight';
import * as easBuildLookup from '../../plan/easBuildLookup';
import { readLastBuildRecord } from '../../plan/lastBuild';
import * as resolveAsync from '../../plan/resolveAsync';
import * as appConfig from '../../project/appConfig';
import { probeProjectStateAsync } from '../../project/probe';
import type { ProjectState, StartPlan } from '../../project/types';
import { type DevServerDiscovery } from '../../runtime/devServer';
import { discoverDevServerAsync } from '../../runtime/discoverDevServer';
import { probeTargetLivenessAsync } from '../../runtime/targetLiveness';
import { waitForBundlerReadyAsync } from '../../runtime/waitReady';
import { getPersistedAgentIdsAsync } from '../../skills/agents';
import { discoverSkillsAsync } from '../../skills/discovery';
import type { DiscoveredSkill } from '../../skills/types';
import { readEasBuildsStatusAsync } from '../easBuilds';
import { formatStatusReport } from '../format';
import { readInstalledStatusAsync } from '../installed';
import { collectStatusReportAsync, printStatusAsync } from '../statusAsync';
import type { StatusReport } from '../types';
import { lockInfo } from '../../devLock/__tests__/fakeLock';
import { buildStatusFollowUps } from '../../followups';

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

const uiSkill: DiscoveredSkill = {
  name: 'expo-ui',
  path: '/project/node_modules/@expo/ui/skills/expo-ui',
  packageName: '@expo/ui',
  linkName: 'expo-ui',
};

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

describe(collectStatusReportAsync, () => {
  it(`should report every section of a running project`, async () => {
    vi.mocked(readLastBuildRecord).mockReturnValue({
      ios: { hash: 'abcdef0123456789', sources: null },
    });
    vi.mocked(getPersistedAgentIdsAsync).mockResolvedValue(['claude-code']);
    vi.mocked(discoverSkillsAsync).mockResolvedValue([uiSkill]);
    await fs.promises.mkdir(uiSkill.path, { recursive: true });
    await fs.promises.mkdir('/project/.claude/skills', { recursive: true });
    // An absolute target, because memfs resolves a relative one against `process.cwd()`.
    await fs.promises.symlink(uiSkill.path, '/project/.claude/skills/expo-ui');

    const report = await collectStatusReportAsync(projectRoot, { ...options, platform: 'ios' });

    expect(report.errors).toEqual({});
    expect(report.project).toEqual({
      root: projectRoot,
      name: 'my-app',
      isExpoApp: true,
      sdkVersion: '54.0.0',
      native: 'cng',
      nativeDirs: { ios: false, android: false },
      usesDevClient: false,
      hasWeb: true,
    });
    expect(report.expoGo).toEqual({ compatible: true, reasonCount: 0 });
    expect(report.freshness?.platforms[0]).toMatchObject({ platform: 'ios', state: 'fresh' });
    expect(report.devServer).toEqual({
      url: devServerUrl,
      running: true,
      appsConnected: 1,
      appsListed: 1,
      appsStale: 0,
      source: 'default',
      ready: true,
      projectRootMatched: true,
      hostType: null,
      tunnelUrl: null,
      // The URL a device opens, next to the address the dev server listens on (K7(c)). This project
      // has no dev client, so Expo Go's form is the only one there is.
      openUrls: [{ target: 'expo-go', label: 'Expo Go', url: 'exp://192.168.1.233:8081' }],
    });
    expect(report.skills).toEqual({ agentIds: ['claude-code'], discovered: 1, linked: 1 });
    expect(report.next?.rule).toBe('expo-go');
  });

  // The whole probe rides along, so `status --json` is the project brief the former
  // `@expo/agent-cli context` printed, and nothing has to run a second command for the raw facts.
  it(`should carry the raw project probe`, async () => {
    const state = mockState({
      expoGo: {
        compatible: false,
        reasons: [
          {
            kind: 'unbundled-native-module',
            packageName: 'fake-native-module',
            detail: 'is native',
          },
        ],
      },
    });

    const report = await collectStatusReportAsync(projectRoot, options);

    expect(report.probe).toEqual(state);
    // The reasons the `expoGo` section only counts are readable here.
    expect(report.probe?.expoGo.reasons).toHaveLength(1);
    expect(report.expoGo).toEqual({ compatible: false, reasonCount: 1 });
  });

  it(`should report a null probe when the project could not be read`, async () => {
    vi.mocked(probeProjectStateAsync).mockRejectedValue(new Error('project is unreadable'));

    const report = await collectStatusReportAsync(projectRoot, options);

    expect(report.probe).toBeNull();
    expect(report.errors.project).toBe('project is unreadable');
  });

  it(`should report a skill that is discovered but not linked`, async () => {
    vi.mocked(getPersistedAgentIdsAsync).mockResolvedValue(['claude-code']);
    vi.mocked(discoverSkillsAsync).mockResolvedValue([uiSkill]);

    const report = await collectStatusReportAsync(projectRoot, options);

    expect(report.skills).toEqual({ agentIds: ['claude-code'], discovered: 1, linked: 0 });
  });

  it(`should report that no agent is selected`, async () => {
    vi.mocked(discoverSkillsAsync).mockResolvedValue([uiSkill]);

    const report = await collectStatusReportAsync(projectRoot, options);

    // Without a cached selection there is nowhere to link to, so nothing counts as linked.
    expect(report.skills).toEqual({ agentIds: null, discovered: 1, linked: 0 });
  });

  it(`should report a dev server that does not answer`, async () => {
    vi.mocked(discoverDevServerAsync).mockResolvedValue({
      reachable: false,
      targets: [],
      reason: 'fetch failed',
      devServerUrl,
      source: 'default',
      discovered: false,
    });

    const report = await collectStatusReportAsync(projectRoot, options);

    expect(report.devServer).toEqual({
      url: devServerUrl,
      running: false,
      appsConnected: 0,
      appsListed: 0,
      appsStale: 0,
      source: 'default',
      ready: null,
      projectRootMatched: null,
      hostType: null,
      tunnelUrl: null,
      openUrls: [],
      reason: 'fetch failed',
    });
    // Nothing answered, so nothing was asked about readiness either.
    expect(vi.mocked(waitForBundlerReadyAsync)).not.toHaveBeenCalled();
    // A missing dev server is information, so every other section is still reported.
    expect(report.errors).toEqual({});
    expect(report.project).not.toBeNull();
  });

  // @ref llp/0010 — `status` reports where the project is now and never waits for a bundle, so
  // "still working" is its own answer and not a claim that the bundler failed.
  it(`should report an unknown readiness when the bundler is still working`, async () => {
    vi.mocked(waitForBundlerReadyAsync).mockResolvedValue({
      ready: false,
      projectRootMatched: true,
      reportedProjectRoot: projectRoot,
      timedOut: true,
      waitedMs: 400,
    });

    const report = await collectStatusReportAsync(projectRoot, options);

    expect(report.devServer?.ready).toBeNull();
    expect(report.devServer?.projectRootMatched).toBe(true);
  });

  it(`should report a dev server that answered /status with something else as not ready`, async () => {
    vi.mocked(waitForBundlerReadyAsync).mockResolvedValue({
      ready: false,
      projectRootMatched: null,
      reportedProjectRoot: null,
      timedOut: false,
      waitedMs: 3,
      reason: 'not an Expo dev server',
    });

    const report = await collectStatusReportAsync(projectRoot, options);

    expect(report.devServer?.ready).toBe(false);
  });

  it(`should report the discovery step that found the dev server`, async () => {
    vi.mocked(discoverDevServerAsync).mockResolvedValue({
      reachable: true,
      targets: [],
      devServerUrl: 'http://127.0.0.1:8090',
      source: 'lock',
      discovered: true,
    });

    const report = await collectStatusReportAsync(projectRoot, options);

    expect(report.devServer?.source).toBe('lock');
  });

  it(`should report another project's dev server as not matching`, async () => {
    vi.mocked(waitForBundlerReadyAsync).mockResolvedValue({
      ready: true,
      projectRootMatched: false,
      reportedProjectRoot: '/other-project',
      timedOut: false,
      waitedMs: 2,
    });

    const report = await collectStatusReportAsync(projectRoot, options);

    expect(report.devServer?.projectRootMatched).toBe(false);
  });

  it(`should stop waiting for a dev server that never answers`, async () => {
    vi.mocked(discoverDevServerAsync).mockReturnValue(new Promise(() => {}));

    const report = await collectStatusReportAsync(projectRoot, {
      ...options,
      devServerTimeoutMs: 1,
    });

    expect(report.devServer?.running).toBe(false);
    expect(report.devServer?.reason).toMatch(/1ms/);
  });

  it(`should cancel the dev-server probe it stopped waiting for`, async () => {
    // Stopping the wait is not stopping the work, and the process cannot exit while the socket
    // lives: against a dev server that accepted the connection and never answered, the report was
    // complete at 3.07 s and `status` was still running at 45 s [observed — 2026-08-27]. Nothing
    // reportable changes here — status has already decided it will not use this answer — so the
    // only thing cancelling can affect is how long the command stays alive after printing.
    let signal: AbortSignal | undefined;
    vi.mocked(discoverDevServerAsync).mockImplementation((_url, discoverOptions) => {
      signal = discoverOptions?.signal;
      return new Promise(() => {});
    });

    const report = await collectStatusReportAsync(projectRoot, {
      ...options,
      devServerTimeoutMs: 1,
    });

    expect(report.devServer?.running).toBe(false);
    expect(signal?.aborted).toBe(true);
  });

  it(`should report an unknown freshness when there is no fingerprint tool`, async () => {
    mockState({ fingerprint: { hash: null, error: 'fingerprint CLI not found' } });

    const report = await collectStatusReportAsync(projectRoot, options);

    expect(report.freshness?.hash).toBeNull();
    expect(report.freshness?.error).toBe('fingerprint CLI not found');
    // Four entries now: backend × platform (llp/0021 §The rules).
    expect(report.freshness?.platforms.map((platform) => platform.state)).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
  });

  it(`should report a bare project and the plan that builds it`, async () => {
    mockState({
      nativeDirs: { ios: true, android: false },
      expoGo: { compatible: false, reasons: [{ kind: 'custom-native-code', detail: 'ios/' }] },
    });

    const report = await collectStatusReportAsync(projectRoot, options);

    expect(report.project?.native).toBe('bare');
    expect(report.next?.rule).toBe('bare-stale');
  });

  it(`should report an Expo Go incompatible project without a dev client`, async () => {
    mockState({
      expoGo: {
        compatible: false,
        reasons: [
          { kind: 'unbundled-native-module', packageName: 'react-native-fancy', detail: 'native' },
        ],
      },
    });

    const report = await collectStatusReportAsync(projectRoot, options);

    expect(report.expoGo).toEqual({ compatible: false, reasonCount: 1 });
    expect(report.next?.rule).toBe('needs-dev-client');
  });

  it(`should note the sections a failed probe leaves unknown, and report the rest`, async () => {
    vi.mocked(probeProjectStateAsync).mockRejectedValue(new Error('project is unreadable'));

    const report = await collectStatusReportAsync(projectRoot, options);

    expect(report.project).toBeNull();
    expect(report.expoGo).toBeNull();
    expect(report.freshness).toBeNull();
    expect(report.next).toBeNull();
    expect(report.errors.project).toContain('project is unreadable');
    // The sections that do not need the project state are still reported.
    expect(report.devServer?.running).toBe(true);
    expect(report.skills).not.toBeNull();
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Status
  //
  // Every run carries the per-source list, the OTA verdict and the EAS answer.
  describe('what every run carries', () => {
    it(`should classify the change from the two source lists, in process`, async () => {
      // Both sides carry their sources, which is what makes the classification possible at all —
      // the probe computed the head's to get its hash, and the record holds the base's.
      mockState({ fingerprint: { hash: 'abcdef0123456789', sources: [] } });
      vi.mocked(readLastBuildRecord).mockReturnValue({ ios: { hash: 'older', sources: [] } });

      const report = await collectStatusReportAsync(projectRoot, options);

      expect(report.freshness?.platforms[0]!.impact).toMatchObject({
        class: 'js-only',
        fingerprintChanged: true,
        changedSources: [],
      });
    });

    // Section isolation: three answers, and one of them failing costs one of them.
    it(`should note an OTA read it could not make, and keep every other fact`, async () => {
      vi.mocked(resolveRuntimeVersionAsync).mockRejectedValue(new Error('expo config failed'));

      const report = await collectStatusReportAsync(projectRoot, options);

      expect(report.errors.freshness).toBe('expo config failed');
      expect(report.freshness?.ota).toBeNull();
      expect(report.freshness?.hash).toBe('abcdef0123456789');
      expect(report.project).not.toBeNull();
    });

    it(`should not resolve an OTA verdict for a project it could not probe`, async () => {
      vi.mocked(probeProjectStateAsync).mockRejectedValue(new Error('project is unreadable'));

      const report = await collectStatusReportAsync(projectRoot, options);

      expect(resolveRuntimeVersionAsync).not.toHaveBeenCalled();
      expect(report.freshness).toBeNull();
    });
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Status
  // The file-level view runs only where it can change the answer, which is the one rule that keeps
  // a `git` call off the common path.
  describe('the file-level refinement', () => {
    function unchanged() {
      mockState({ fingerprint: { hash: 'abcdef0123456789', sources: [] } });
      vi.mocked(readLastBuildRecord).mockReturnValue({
        ios: { hash: 'abcdef0123456789', sources: [] },
      });
    }

    it(`should upgrade js-only to dev-client-compatible when a config file moved`, async () => {
      unchanged();
      vi.mocked(refineWithChangedFilesAsync).mockResolvedValue({
        class: 'dev-client-compatible',
        reason: 'metro.config.js is read once when the dev server starts',
        counts: { total: 1, native: 0, js: 1, config: 1 },
      });

      const report = await collectStatusReportAsync(projectRoot, options);

      expect(report.freshness?.platforms[0]!.impact).toMatchObject({
        class: 'dev-client-compatible',
        reason: 'metro.config.js is read once when the dev server starts',
      });
      expect(report.freshness?.changedFiles).toEqual({ total: 1, native: 0, js: 1, config: 1 });
    });

    it(`should not look at files when the fingerprint already moved`, async () => {
      mockState({ fingerprint: { hash: 'abcdef0123456789', sources: [] } });
      vi.mocked(readLastBuildRecord).mockReturnValue({ ios: { hash: 'older', sources: [] } });

      await collectStatusReportAsync(projectRoot, options);

      expect(refineWithChangedFilesAsync).not.toHaveBeenCalled();
    });

    it(`should not look at files when no class was established`, async () => {
      vi.mocked(readLastBuildRecord).mockReturnValue({});

      await collectStatusReportAsync(projectRoot, options);

      expect(refineWithChangedFilesAsync).not.toHaveBeenCalled();
    });

    it(`should keep the fingerprint's answer when git could not say`, async () => {
      unchanged();
      vi.mocked(refineWithChangedFilesAsync).mockResolvedValue(null);

      const report = await collectStatusReportAsync(projectRoot, options);

      expect(report.freshness?.platforms[0]!.impact?.class).toBe('js-only');
      expect(report.freshness?.changedFiles).toBeNull();
    });
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Status
  describe('--assert', () => {
    function decided(recordedHash: string) {
      mockState({ fingerprint: { hash: 'abcdef0123456789', sources: [] } });
      vi.mocked(readLastBuildRecord).mockReturnValue({ ios: { hash: recordedHash, sources: [] } });
    }

    it(`should report no assertion when none was made`, async () => {
      const report = await collectStatusReportAsync(projectRoot, options);

      expect(report.assertion).toBeNull();
    });

    it(`should pass when the change costs at most the asserted class`, async () => {
      decided('abcdef0123456789');

      const report = await collectStatusReportAsync(projectRoot, {
        ...options,
        assert: 'js-only',
      });

      expect(report.assertion).toMatchObject({ ok: true, actual: 'js-only', exitCode: 0 });
    });

    it(`should fail with 22 for a project with nothing to compare against`, async () => {
      vi.mocked(readLastBuildRecord).mockReturnValue({});

      const report = await collectStatusReportAsync(projectRoot, {
        ...options,
        assert: 'js-only',
      });

      expect(report.assertion).toMatchObject({ ok: false, actual: null, exitCode: 22 });
    });
  });

  // @ref llp/0011-impact-and-freshness.rfc.md §The three comparisons
  describe('--build', () => {
    beforeEach(() => {
      vi.mocked(compareWithEasBuildAsync).mockResolvedValue({
        base: { label: 'EAS build build-1', hash: 'base-hash' },
        head: { label: 'working tree', hash: 'head-hash' },
        items: [
          {
            op: 'added',
            addedSource: {
              type: 'dir',
              filePath: 'node_modules/react-native-mmkv',
              reasons: ['rncoreAutolinkingIos'],
              hash: 'aa',
            },
          },
        ],
        fingerprintChanged: true,
        caveats: [],
        error: null,
      });
    });

    // @ref llp/0021-honest-reports.rfc.md §The rules — live run,
    // S1. The one comparison used to be copied onto every platform, which reported an iOS
    // simulator build as able to run android code.
    it(`should put the build's answer on the build's platform only`, async () => {
      vi.mocked(lookUpBuildPlatformAsync).mockResolvedValue('ios');

      const report = await collectStatusReportAsync(projectRoot, {
        ...options,
        buildId: 'build-1',
      });

      expect(compareWithEasBuildAsync).toHaveBeenCalledWith(
        expect.anything(),
        projectRoot,
        'build-1'
      );
      expect(report.freshness?.comparison).toEqual({
        kind: 'eas-build',
        label: 'EAS build build-1',
        buildId: 'build-1',
        platform: 'ios',
      });
      // The eas axis, which is the one `--build` asks about (llp/0021 §The rules).
      const easAxis = (platform: string) =>
        report.freshness!.platforms.find(
          (one) => one.platform === platform && one.backend === 'eas'
        )!;
      expect(easAxis('ios').impact).toMatchObject({
        class: 'needs-native-build',
        fingerprintChanged: true,
      });
      expect(easAxis('ios')).toMatchObject({ state: 'stale', buildId: 'build-1' });
      // A stated non-answer, never the other platform's verdict.
      expect(easAxis('android').impact).toMatchObject({
        class: null,
        fingerprintChanged: null,
        reason: expect.stringContaining('not compared'),
      });
      // And the local axis is left alone: it answers a question `--build` did not ask.
      expect(
        report.freshness!.platforms.find(
          (one) => one.platform === 'ios' && one.backend === 'local'
        )!.impact?.reason
      ).not.toContain('build-1');
    });

    it(`should compare nothing when the build's platform could not be established`, async () => {
      // Set here rather than left to the factory: `clearMocks` clears calls, not implementations.
      vi.mocked(lookUpBuildPlatformAsync).mockResolvedValue(null);

      const report = await collectStatusReportAsync(projectRoot, {
        ...options,
        buildId: 'build-1',
      });

      expect(report.freshness?.comparison.platform).toBeNull();
      // The eas axis of both platforms: the comparison was against a build, and which platform
      // that build is for was never established, so neither axis is an answer about either.
      for (const platform of report.freshness!.platforms.filter((one) => one.backend === 'eas')) {
        expect(platform.impact).toMatchObject({
          class: null,
          reason: expect.stringContaining('could not be established'),
        });
      }
    });

    // The caller said which platform they mean, and no lookup overrules a stated fact.
    it(`should take the platform the caller named without asking EAS`, async () => {
      const report = await collectStatusReportAsync(projectRoot, {
        ...options,
        buildId: 'build-1',
        platform: 'android',
      });

      expect(lookUpBuildPlatformAsync).not.toHaveBeenCalled();
      expect(report.freshness?.comparison.platform).toBe('android');
    });

    // The `fresh`/`stale` state is about the project's own record, and `--build` asks a different
    // question. One of them silently changing meaning would be worse than reporting both.
    it(`should leave the freshness states alone, because they answer another question`, async () => {
      vi.mocked(readLastBuildRecord).mockReturnValue({
        ios: { hash: 'abcdef0123456789', sources: null },
      });

      const report = await collectStatusReportAsync(projectRoot, {
        ...options,
        buildId: 'build-1',
      });

      expect(report.freshness?.platforms[0]).toMatchObject({ platform: 'ios', state: 'fresh' });
    });

    it(`should compose with --assert, gating on the build comparison`, async () => {
      vi.mocked(lookUpBuildPlatformAsync).mockResolvedValue('ios');

      const report = await collectStatusReportAsync(projectRoot, {
        ...options,
        buildId: 'build-1',
        assert: 'js-only',
      });

      expect(report.assertion).toMatchObject({
        ok: false,
        actual: 'needs-native-build',
        exitCode: 20,
      });
    });

    it(`should note a comparison it could not make, and keep every other fact`, async () => {
      vi.mocked(compareWithEasBuildAsync).mockResolvedValue({
        base: { label: 'EAS build build-1', hash: null },
        head: { label: 'working tree', hash: null },
        items: null,
        fingerprintChanged: null,
        caveats: [],
        error: 'Could not compare against EAS build build-1.',
      });

      const report = await collectStatusReportAsync(projectRoot, {
        ...options,
        buildId: 'build-1',
      });

      expect(report.errors.freshness).toContain('Could not compare against EAS build build-1.');
      expect(report.project).not.toBeNull();
    });
  });

  // @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol — what an agent reads before it
  // starts a command that would stop on a login.
  it(`should report who the CLI family acts as`, async () => {
    const report = await collectStatusReportAsync(projectRoot, options);

    expect(report.auth).toEqual({ loggedIn: true, user: 'alice', source: 'eas whoami' });
  });

  it(`should note an auth section it could not read, and report the rest`, async () => {
    vi.mocked(readAuthPreflightAsync).mockRejectedValue(new Error('eas is not executable'));

    const report = await collectStatusReportAsync(projectRoot, options);

    expect(report.auth).toBeNull();
    expect(report.errors.auth).toContain('eas is not executable');
    expect(report.project).not.toBeNull();
  });

  it(`should note a skills section it could not read`, async () => {
    vi.mocked(discoverSkillsAsync).mockRejectedValue(new Error('autolinking is not installed'));

    const report = await collectStatusReportAsync(projectRoot, options);

    expect(report.skills).toBeNull();
    expect(report.errors.skills).toContain('autolinking is not installed');
    expect(report.project).not.toBeNull();
  });

  it(`should fall back to the directory name when the project has no package.json`, async () => {
    vol.reset();

    const report = await collectStatusReportAsync(projectRoot, options);

    expect(report.project?.name).toBe('project');
  });
});

/** Everything the command printed, joined into one string. */
function output(): string {
  return vi.mocked(Log.log).mock.calls.flat().join('\n');
}

describe(printStatusAsync, () => {
  it(`should print one JSON object with every section`, async () => {
    await printStatusAsync(projectRoot, { ...options, json: true });

    expect(Log.log).toHaveBeenCalledTimes(1);
    const report: StatusReport = JSON.parse(output());
    expect(Object.keys(report)).toEqual([
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
  });

  // Shape test: the top-level keys of `--json` are the command's contract, so they are asserted
  // as an exact set. Adding, renaming, or dropping one is a breaking change for every caller.
  it(`should print a stable set of top-level keys with --json`, async () => {
    await printStatusAsync(projectRoot, { ...options, json: true });

    expect(Object.keys(JSON.parse(output())).sort()).toEqual([
      'assertion',
      'auth',
      'binding',
      'builds',
      'devServer',
      'device',
      'errors',
      'expoGo',
      'followups',
      'freshness',
      'installed',
      'next',
      'orphanSessions',
      'probe',
      'project',
      'skills',
    ]);
  });

  it(`should print the same key set when a section could not be read`, async () => {
    vi.mocked(probeProjectStateAsync).mockRejectedValue(new Error('project is unreadable'));

    await printStatusAsync(projectRoot, { ...options, json: true });

    // A failed section is reported as null plus a note in `errors`, so the shape never changes.
    expect(Log.log).toHaveBeenCalledTimes(1);
    expect(Object.keys(JSON.parse(output())).sort()).toEqual([
      'assertion',
      'auth',
      'binding',
      'builds',
      'devServer',
      'device',
      'errors',
      'expoGo',
      'followups',
      'freshness',
      'installed',
      'next',
      'orphanSessions',
      'probe',
      'project',
      'skills',
    ]);
  });

  it(`should print the human readable report by default`, async () => {
    const report = await collectStatusReportAsync(projectRoot, options);
    vi.mocked(Log.log).mockClear();

    await printStatusAsync(projectRoot, options);

    expect(output()).toBe(formatStatusReport(report));
  });

  it(`should emit the status event for the driving agent`, async () => {
    vi.mocked(getPersistedAgentIdsAsync).mockResolvedValue(['claude-code']);

    await printStatusAsync(projectRoot, { ...options, platform: 'ios' });

    expect(event).toHaveBeenCalledWith('status', {
      rule: 'expo-go',
      sdkVersion: '54.0.0',
      expoGoCompatible: true,
      devServerRunning: true,
      appsConnected: 1,
      appsListed: 1,
      appsStale: 0,
      devServerHostType: null,
      tunnelUrl: null,
      // The best of the URLs a device opens, so the stream carries the one an agent can act on.
      openUrl: 'exp://192.168.1.233:8081',
      // No binding on either platform, which the registry answers without a device tool.
      localDevice: 'absent',
      installed: 'unknown',
      freshness: { ios: 'stale', android: 'stale' },
      // The section builder is mocked out here; its own suite covers what it answers.
      easBuilds: { ios: null, android: null },
      impact: { ios: null, android: null },
      assertion: null,
      easBuildsAsked: false,
      // @ref llp/0023-fingerprint-caching.rfc.md §The report says where the answer came from
      // Null here because this suite mocks the probe, so no fingerprint call stated a source. A
      // real run always carries one.
      fingerprintSource: null,
      fingerprintRevalidatedAgainst: null,
      skillsDiscovered: 0,
      skillsLinked: 0,
      sectionErrors: [],
    });
  });

  it(`should emit the event even when a section could not be read`, async () => {
    vi.mocked(probeProjectStateAsync).mockRejectedValue(new Error('project is unreadable'));

    await printStatusAsync(projectRoot, options);

    expect(event).toHaveBeenCalledWith(
      'status',
      expect.objectContaining({ rule: null, sectionErrors: ['project'] })
    );
  });

  // @ref llp/0009-smart-followups.rfc.md §Examples per command — status already carries "next",
  // so its follow-ups reach a driving agent only through the event and the JSON report.
  describe('follow-ups', () => {
    it(`should emit the follow-up event without adding a section to the text report`, async () => {
      await printStatusAsync(projectRoot, options);

      expect(event).toHaveBeenCalledWith('followups', {
        command: 'status',
        followups: [
          {
            id: 'runtime-errors',
            command: 'npx @expo/agent-cli runtime:errors',
            why: expect.any(String),
          },
        ],
      });
      expect(output()).not.toContain('Suggested next:');
    });

    it(`should embed the follow-ups in the JSON report`, async () => {
      await printStatusAsync(projectRoot, { ...options, json: true });

      expect(Log.log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(output()).followups).toEqual([
        {
          id: 'runtime-errors',
          command: 'npx @expo/agent-cli runtime:errors',
          why: expect.any(String),
        },
      ]);
    });

    it(`should never repeat the plan the next line already names`, async () => {
      vi.mocked(getPersistedAgentIdsAsync).mockResolvedValue(['claude-code']);
      vi.mocked(discoverSkillsAsync).mockResolvedValue([uiSkill]);
      mockState({ expoGo: { compatible: false, reasons: [] } });

      await printStatusAsync(projectRoot, { ...options, json: true });

      const report = JSON.parse(output());
      expect(report.followups.map((followup: { id: string }) => followup.id)).toEqual([
        'runtime-errors',
        'skills-sync',
        'install-dev-client',
      ]);
      // The dev server of this fixture is running with an app attached, so `next` is the readiness
      // gate rather than `@expo/agent-cli dev` — and deliberately not `runtime:errors`, which the
      // `runtime-errors` follow-up above already names.
      //
      // Either platform, because this case is not about which one. It runs the whole command, so the
      // platform in `next` comes from the devices the host has (llp/0005 §Which platform is the
      // caller's to say) — and pinning `--ios` here passed on a Mac and failed on the Linux runner
      // [observed — tier0-linux, 2026-09-04]. `src/status/__tests__/sections-test.ts` is where the
      // choice itself is pinned, against a fixture that states its device.
      expect(report.next.command).toMatch(/^npx @expo\/agent-cli smoke --(ios|android)$/);
      expect(
        report.followups.map((followup: { command: string }) => followup.command)
      ).not.toContain(report.next.command);
    });

    it(`should embed an empty list with --no-followups, keeping the key set`, async () => {
      await printStatusAsync(projectRoot, { ...options, json: true, followups: false });

      expect(JSON.parse(output()).followups).toEqual([]);
      expect(event).not.toHaveBeenCalledWith('followups', expect.anything());
    });
  });
});

// @ref ../../runtime/targetLiveness — friction run 6, F56. `/json/list` is a list of
// registrations: a page an app left behind when it was force-stopped stays in it, so this command
// reported `1 app connected` while every runtime command answered `No target found`.
describe(`${collectStatusReportAsync.name} and stale debugger targets`, () => {
  it(`counts the targets that still answer, and names the ones that do not`, async () => {
    vi.mocked(discoverDevServerAsync).mockResolvedValue({
      reachable: true,
      targets: [{ id: 'live' } as any, { id: 'stale' } as any],
      devServerUrl,
      source: 'lock',
      discovered: true,
    });
    vi.mocked(waitForBundlerReadyAsync).mockResolvedValue({
      ready: true,
      projectRootMatched: true,
      reportedProjectRoot: projectRoot,
      timedOut: false,
      waitedMs: 1,
    });
    vi.mocked(probeTargetLivenessAsync).mockResolvedValue({
      listed: 2,
      live: 1,
      stale: [{ id: 'stale' } as any],
    });

    const report = await collectStatusReportAsync(projectRoot, options);

    expect(report.devServer).toMatchObject({ appsConnected: 1, appsListed: 2, appsStale: 1 });
    expect(formatStatusReport(report)).toContain('1 stale target still listed');
  });
});

describe(`${collectStatusReportAsync.name} and an unbound worktree`, () => {
  function lastRequest() {
    vol.fromJSON({
      '/project/.expo/agent-cli-last-dev.json': JSON.stringify({
        version: 1,
        platform: 'android',
        port: 19082,
        device: 'emulator-5556',
        buildBackend: 'local',
        runTarget: 'dev-build',
      }),
    });
  }

  it('keeps Android startup context before Metro has published a lock', async () => {
    lastRequest();
    stopDevServer();
    const report = await collectStatusReportAsync(projectRoot, { devServerUrl: null });
    expect(report.next?.command).toBe(
      'npx @expo/agent-cli dev --android --local --dev-client --port 19082 --device emulator-5556 --detach --wait-ready'
    );
    expect(report.next?.why).toContain('No android device');
    expect(discoverDevServerAsync).toHaveBeenCalledWith(
      'http://127.0.0.1:19082',
      expect.anything()
    );
  });

  it('prefers the explicit platform over the saved Android request', async () => {
    lastRequest();
    stopDevServer();
    const report = await collectStatusReportAsync(projectRoot, {
      devServerUrl: null,
      platform: 'ios',
    });
    expect(report.next?.command).toBe('npx @expo/agent-cli dev --ios --detach --wait-ready');
  });

  it('keeps the installed-app --device out of the dev command and the saved device in it', async () => {
    lastRequest();
    stopDevServer();
    const report = await collectStatusReportAsync(projectRoot, {
      devServerUrl: 'http://localhost:19090',
      device: 'Pixel; echo nope',
    });
    expect(report.next?.command).toBe(
      'npx @expo/agent-cli dev --android --local --dev-client --port 19090 --device emulator-5556 --detach --wait-ready'
    );
    expect(report.next?.steps.some((step) => step.argv.includes('19090'))).toBe(true);
    const ios = await collectStatusReportAsync(projectRoot, {
      devServerUrl: null,
      platform: 'ios',
      device: 'iPhone 15',
    });
    expect(ios.next?.command).toBe('npx @expo/agent-cli dev --ios --detach --wait-ready');
  });

  it('uses a current own lock instead of an old requested port', async () => {
    lastRequest();
    stopDevServer();
    vi.mocked(devLock.readDevServerLockAsync).mockResolvedValue({
      ...running,
      port: 19091,
      url: 'http://127.0.0.1:19091',
    });
    const report = await collectStatusReportAsync(projectRoot, { devServerUrl: null });
    expect(report.next?.command).toContain('--port 19091');
    expect(discoverDevServerAsync).toHaveBeenCalledWith(
      'http://127.0.0.1:19091',
      expect.anything()
    );
    expect(report.devServer?.source).toBe('lock');
  });

  it('does not turn a remote URL into a local Metro port', async () => {
    lastRequest();
    stopDevServer();
    const report = await collectStatusReportAsync(projectRoot, {
      devServerUrl: 'http://example.test:19090',
    });
    expect(report.next?.command).not.toContain('--port');
  });

  it('does not suggest a saved port that now serves another project', async () => {
    lastRequest();
    vi.mocked(discoverDevServerAsync).mockResolvedValue({
      reachable: true,
      targets: [],
      devServerUrl: 'http://127.0.0.1:19082',
      source: 'default',
      discovered: false,
    });
    vi.mocked(waitForBundlerReadyAsync).mockResolvedValue({
      ready: false,
      projectRootMatched: false,
      reportedProjectRoot: '/other-project',
      timedOut: false,
      waitedMs: 1,
    });
    const report = await collectStatusReportAsync(projectRoot, { devServerUrl: null });
    expect(report.next?.command).toContain('dev --android --local --dev-client');
    expect(report.next?.command).not.toContain('--port');
    expect(report.next?.steps.some((step) => step.argv.includes('19082'))).toBe(false);
  });

  it('restores the dev plan steps when rebinding replaces a navigate suggestion', async () => {
    vi.mocked(discoverDevServerAsync).mockResolvedValue({
      reachable: true,
      targets: [],
      devServerUrl,
      source: 'default',
      discovered: false,
    });
    vi.mocked(probeTargetLivenessAsync).mockResolvedValueOnce({ listed: 0, live: 0, stale: [] });
    vi.mocked(devLock.readDevServerLockAsync).mockResolvedValue(running);
    const report = await collectStatusReportAsync(projectRoot, { ...options, platform: 'android' });
    expect(report.next?.command).toContain('dev:stop &&');
    expect(report.next?.steps.length).toBeGreaterThan(0);
  });

  it('uses a sole Android binding when there is no saved request or platform flag', async () => {
    stopDevServer();
    vi.spyOn(summary, 'readBindingSummaryAsync').mockResolvedValueOnce([
      { platform: 'android', expiresAt: '2020-01-01T00:00:00.000Z' } as summary.BindingSummary,
    ]);
    const report = await collectStatusReportAsync(projectRoot, { devServerUrl: null });
    expect(report.next?.command).toBe('npx @expo/agent-cli dev --android --detach --wait-ready');
    expect(report.next?.why).toContain('android');
  });
  const iosOptions = { ...options, platform: 'ios' as const };
  const running = lockInfo({
    projectRoot,
    url: devServerUrl,
    port: 8081,
    pid: 4242,
    startedAt: new Date(0).toISOString(),
  });

  async function planNextAsync() {
    vi.spyOn(summary, 'readBindingSummaryAsync').mockResolvedValueOnce([
      { platform: 'ios', expiresAt: '2999-01-01T00:00:00.000Z' } as summary.BindingSummary,
    ]);
    return (await collectStatusReportAsync(projectRoot, iosOptions)).next;
  }

  function stopDevServer() {
    vi.mocked(discoverDevServerAsync).mockResolvedValue({
      reachable: false,
      targets: [],
      reason: 'fetch failed',
      devServerUrl,
      source: 'default',
      discovered: false,
    });
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['ios', false],
    ['android', false],
    ['ios', true],
    ['android', true],
  ] as const)('recovers an unbound %s device (own server=%s)', async (platform, ownServer) => {
    vi.mocked(discoverDevServerAsync).mockResolvedValue({
      reachable: true,
      targets: [],
      devServerUrl,
      source: 'default',
      discovered: false,
    });
    vi.mocked(probeTargetLivenessAsync).mockResolvedValueOnce({ listed: 0, live: 0, stale: [] });
    vi.mocked(devLock.readDevServerLockAsync).mockResolvedValue(ownServer ? running : null);
    vi.mocked(waitForBundlerReadyAsync).mockResolvedValueOnce({
      ready: true,
      projectRootMatched: ownServer,
      reportedProjectRoot: ownServer ? projectRoot : '/other',
      timedOut: false,
      waitedMs: 1,
    });
    const report = await collectStatusReportAsync(projectRoot, { ...options, platform });
    const restart = ownServer ? 'npx @expo/agent-cli dev:stop && ' : '';
    expect(report.next?.command).toBe(
      `${restart}npx @expo/agent-cli dev --${platform}${ownServer ? ' --port 8081' : ''} --detach --wait-ready`
    );
    expect(report.next?.why).toContain(`No ${platform} device is bound to this worktree.`);
    if (ownServer) expect(report.next?.why).toContain('restart');
  });

  describe('beside a dev server that runs an EAS Simulator session', () => {
    function easServer(platform: 'ios' | 'android') {
      vi.mocked(discoverDevServerAsync).mockResolvedValue({
        reachable: true,
        targets: [],
        devServerUrl,
        source: 'default',
        discovered: false,
      });
      vi.mocked(probeTargetLivenessAsync).mockResolvedValueOnce({ listed: 0, live: 0, stale: [] });
      vi.mocked(devLock.readDevServerLockAsync).mockResolvedValue({
        ...running,
        easPlatform: platform,
      });
    }

    it.each(['ios', 'android'] as const)(
      'waits for the %s session instead of a restart',
      async (platform) => {
        easServer(platform);
        const report = await collectStatusReportAsync(projectRoot, { ...options, platform });
        // No --port: the re-run finds the running Metro through its lock, which names the port.
        expect(report.next?.command).toBe(
          `npx @expo/agent-cli dev --${platform} --eas --detach --wait-ready`
        );
        expect(report.next?.why).toContain('No restart is needed.');
        expect(report.next?.why).not.toContain('must restart');
      }
    );

    it('says the session is starting while the detached child starts it', async () => {
      easServer('ios');
      vi.mocked(devLock.readDevServerLockAsync).mockResolvedValue({
        ...running,
        easPlatform: 'ios',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
      fs.mkdirSync(path.dirname(detachedLogPath(projectRoot)), { recursive: true });
      fs.writeFileSync(detachedLogPath(projectRoot), `${detachedPidLine(process.pid)}\n`);
      const report = await collectStatusReportAsync(projectRoot, iosOptions);
      expect(report.next?.command).not.toContain('dev:stop');
      expect(report.next?.why).toContain('is starting');
    });

    describe('with an app connected', () => {
      function androidEasServerWithApp() {
        vi.mocked(devLock.readDevServerLockAsync).mockResolvedValue({
          ...running,
          easPlatform: 'android',
        });
      }

      it('and no binding, next binds the session again and is not smoke', async () => {
        androidEasServerWithApp();
        const report = await collectStatusReportAsync(projectRoot, {
          ...options,
          platform: 'android',
        });
        expect(report.devServer?.appsConnected).toBeGreaterThan(0);
        expect(report.next?.command).toBe(
          'npx @expo/agent-cli dev --android --eas --detach --wait-ready'
        );
        expect(report.next?.why).toContain('No restart is needed.');
      });

      it('and no binding and no platform flag or request, next binds the session of the lock', async () => {
        androidEasServerWithApp();
        const report = await collectStatusReportAsync(projectRoot, options);
        expect(report.next?.command).toBe(
          'npx @expo/agent-cli dev --android --eas --detach --wait-ready'
        );
        expect(report.next?.command).not.toContain('smoke');
      });

      it('and a live EAS binding, next stays smoke --android --eas', async () => {
        androidEasServerWithApp();
        writeCloudBinding(projectRoot, 'android', 'sess-live', {
          expiresAt: '2999-01-01T00:00:00.000Z',
        });
        const report = await collectStatusReportAsync(projectRoot, {
          ...options,
          platform: 'android',
        });
        expect(report.next?.command).toMatch(/smoke --android --eas/);
      });
    });

    it('beside a remembered request for the other platform, never stops the EAS server', async () => {
      easServer('android');
      recordLastDevRequest(projectRoot, resolveDevOptions(['--ios']));
      const report = await collectStatusReportAsync(projectRoot, options);
      expect(report.next?.command).toBe(
        'npx @expo/agent-cli dev --android --eas --detach --wait-ready'
      );
    });

    it('beside a caller who names the other platform, never stops the EAS server', async () => {
      easServer('android');
      const report = await collectStatusReportAsync(projectRoot, iosOptions);
      expect(report.next?.command).not.toContain('dev:stop');
    });

    it('on a host that binds no device, still binds the session of the lock', async () => {
      vi.stubEnv('AGENT_CLI_NO_DEVICE', '1');
      easServer('ios');
      const report = await collectStatusReportAsync(projectRoot, iosOptions);
      expect(report.next?.command).toBe(
        'npx @expo/agent-cli dev --ios --eas --detach --wait-ready'
      );
      expect(report.next?.why).toContain('No restart is needed.');
    });

    it('names no --port for an explicit server URL on another port', async () => {
      easServer('ios');
      const report = await collectStatusReportAsync(projectRoot, {
        devServerUrl: 'http://127.0.0.1:9000',
        platform: 'ios',
      });
      expect(report.next?.command).toBe(
        'npx @expo/agent-cli dev --ios --eas --detach --wait-ready'
      );
    });

    it('with an expired own session row and a live local binding, does not say the lease expired', async () => {
      stopDevServer();
      vi.spyOn(summary, 'readBindingSummaryAsync').mockResolvedValueOnce([
        {
          platform: 'ios',
          backend: 'cloud',
          state: 'gone',
          id: 'sess-old',
          expiresAt: '2026-01-01T00:00:00.000Z',
        },
        {
          platform: 'ios',
          backend: 'local',
          state: 'recorded',
          expiresAt: '2999-01-01T00:00:00.000Z',
        },
      ] as summary.BindingSummary[]);
      const report = await collectStatusReportAsync(projectRoot, iosOptions);
      expect(report.next?.why ?? '').not.toContain('expired');
      expect(report.next?.command).not.toContain('--eas');
    });

    it('beside an expired own session binding, says the lease expired and not that it starts', async () => {
      easServer('ios');
      writeCloudBinding(projectRoot, 'ios', 'sess-old', {
        boundAt: '2025-12-31T00:00:00.000Z',
        expiresAt: '2026-01-01T00:00:00.000Z',
      });
      const report = await collectStatusReportAsync(projectRoot, iosOptions);
      expect(report.next?.command).toBe(
        'npx @expo/agent-cli dev --ios --eas --detach --wait-ready'
      );
      expect(report.next?.why).toContain('sess-old expired');
      expect(report.next?.why).not.toContain('is starting');
    });
  });

  it(`detaches the plan's own dev command`, async () => {
    stopDevServer();
    const report = await collectStatusReportAsync(projectRoot, iosOptions);
    expect(report.next?.command).toBe(
      'npx @expo/agent-cli dev --ios --port 8081 --detach --wait-ready'
    );
  });

  it(`keeps the plan's flags when it detaches the plan's dev command`, async () => {
    stopDevServer();
    const resolve = resolveAsync.resolveStartPlanAsync;
    vi.spyOn(resolveAsync, 'resolveStartPlanAsync').mockImplementationOnce(async (...args) => {
      const resolved = await resolve(...args);
      const buildLocation = {
        ...resolved.plan.buildLocation,
        runsOn: 'eas',
        selection: { implicit: true },
      } as StartPlan['buildLocation'];
      return { ...resolved, plan: { ...resolved.plan, buildLocation } };
    });
    const report = await collectStatusReportAsync(projectRoot, iosOptions);
    expect(report.next?.command).toBe(
      'npx @expo/agent-cli dev --ios --eas --port 8081 --detach --wait-ready'
    );
  });

  it.each([false, true])('reuses an expired binding (own server=%s)', async (ownServer) => {
    stopDevServer();
    vi.mocked(devLock.readDevServerLockAsync).mockResolvedValue(ownServer ? running : null);
    vi.spyOn(summary, 'readBindingSummaryAsync').mockResolvedValueOnce([
      {
        platform: 'ios',
        state: 'gone',
        expiresAt: '2026-01-01T00:00:00.000Z',
      } as summary.BindingSummary,
    ]);
    const report = await collectStatusReportAsync(projectRoot, iosOptions);
    expect(report.next?.command).toBe(
      'npx @expo/agent-cli dev --ios --port 8081 --detach --wait-ready'
    );
    expect(report.next?.why).toBe('The lease on the bound ios device expired.');
  });

  it(`keeps the plan's next while an app is connected to this project's dev server`, async () => {
    const plan = await planNextAsync();
    vi.spyOn(summary, 'readBindingSummaryAsync').mockResolvedValueOnce([
      {
        platform: 'ios',
        state: 'gone',
        expiresAt: '2026-01-01T00:00:00.000Z',
      } as summary.BindingSummary,
    ]);
    const report = await collectStatusReportAsync(projectRoot, iosOptions);
    expect(report.next).toEqual(plan);
  });

  it(`keeps the plan's next under AGENT_CLI_NO_DEVICE, where dev binds nothing`, async () => {
    vi.stubEnv('AGENT_CLI_NO_DEVICE', '1');
    const plan = await planNextAsync();
    const report = await collectStatusReportAsync(projectRoot, iosOptions);
    expect(report.next).toEqual(plan);
  });

  it(`keeps the plan's next on a host that cannot bind the platform`, async () => {
    vi.mocked(deviceBinding.hostBindsPlatform).mockReturnValue(false);
    const plan = await planNextAsync();
    const report = await collectStatusReportAsync(projectRoot, iosOptions);
    expect(report.next).toEqual(plan);
  });

  it(`keeps the plan's next while the project has an EAS session`, async () => {
    vol.fromJSON({ '/project/.env.eas-simulator': 'EAS_SIMULATOR_SESSION_ID=session-1\n' });
    const plan = await planNextAsync();
    const report = await collectStatusReportAsync(projectRoot, iosOptions);
    expect(report.next).toEqual(plan);
  });

  // @ref llp/0015-backend-selection-and-config.rfc.md §The device backend — the same state as an
  // unbound device above, except that `dev` would put the app on an EAS session.
  it(`asks for no local device when the config puts the device on EAS`, async () => {
    vol.fromJSON({
      '/project/package.json': JSON.stringify({
        name: 'my-app',
        expo: { 'agent-cli': { deviceBackend: 'eas' } },
      }),
    });
    vi.mocked(discoverDevServerAsync).mockResolvedValue({
      reachable: true,
      targets: [],
      devServerUrl,
      source: 'default',
      discovered: false,
    });
    vi.mocked(probeTargetLivenessAsync).mockResolvedValueOnce({ listed: 0, live: 0, stale: [] });
    vi.mocked(waitForBundlerReadyAsync).mockResolvedValueOnce({
      ready: true,
      projectRootMatched: false,
      reportedProjectRoot: '/other',
      timedOut: false,
      waitedMs: 1,
    });
    const report = await collectStatusReportAsync(projectRoot, iosOptions);
    expect(report.next?.why ?? '').not.toContain('No ios device is bound to this worktree.');
    expect(report.next?.command).not.toMatch(/ --detach --wait-ready$/);
  });

  it(`keeps the plan's next for --platform web`, async () => {
    const report = await collectStatusReportAsync(projectRoot, { ...options, platform: 'web' });
    expect(report.next?.why).not.toBe('No web device is bound to this worktree.');
    expect(report.next?.command).not.toMatch(/ dev --web --detach --wait-ready$/);
  });

  it("carries a saved web request's port and flags into its dev command without detaching", async () => {
    vol.fromJSON({
      '/project/.expo/agent-cli-last-dev.json': JSON.stringify({
        version: 1,
        platform: 'web',
        port: 19006,
        buildBackend: 'local',
        runTarget: 'expo-go',
      }),
    });
    stopDevServer();
    const report = await collectStatusReportAsync(projectRoot, { devServerUrl: null });
    expect(report.next?.command).toBe('npx @expo/agent-cli dev --web --local --go --port 19006');
  });

  it('removes an unreadable binding file before the dev command that would refuse on it', async () => {
    stopDevServer();
    const file = bindingPathFor(projectRoot, 'ios', 'local-ios');
    vol.fromJSON({ [file]: '{' });
    const report = await collectStatusReportAsync(projectRoot, iosOptions);
    expect(report.next?.command).toBe(
      `rm -f '${file}' && npx @expo/agent-cli dev --ios --port 8081 --detach --wait-ready`
    );
    expect(report.next?.why).toBe(
      `The binding file ${file} does not parse; a newer CLI may have written it.`
    );
  });

  function saveEasRequest() {
    mockState({ usesDevClient: true, expoGo: { compatible: false, reasons: [] } });
    vol.fromJSON({
      '/project/.expo/agent-cli-last-dev.json': JSON.stringify({
        version: 1,
        platform: 'ios',
        port: null,
        buildBackend: 'eas',
        runTarget: null,
      }),
    });
  }

  function buildsFound(buildProfile: string) {
    vi.mocked(readEasBuildsStatusAsync).mockResolvedValueOnce({
      askedEas: true,
      platforms: [
        {
          platform: 'ios',
          state: 'found',
          fingerprintHash: 'ios-hash',
          buildId: 'build-1',
          createdAt: null,
          buildProfile,
          buildUrl: null,
          source: 'eas',
          checkedAt: null,
          ageMs: null,
          reason: null,
        },
      ],
    });
  }

  it("should reuse the builds section's simulator build for a saved --eas request", async () => {
    const lookUp = vi.spyOn(easBuildLookup, 'lookUpEasSimulatorBuildAsync').mockResolvedValue(null);
    saveEasRequest();
    buildsFound('development-simulator');

    await collectStatusReportAsync(projectRoot, { devServerUrl: null });

    expect(lookUp).not.toHaveBeenCalled();
    expect(readEasBuildsStatusAsync).toHaveBeenCalledTimes(1);
  });

  it(`should not ask EAS again when the builds section has no build`, async () => {
    const lookUp = vi.spyOn(easBuildLookup, 'lookUpEasSimulatorBuildAsync').mockResolvedValue(null);
    saveEasRequest();

    await collectStatusReportAsync(projectRoot, { devServerUrl: null });

    expect(lookUp).not.toHaveBeenCalled();
    expect(readEasBuildsStatusAsync).toHaveBeenCalledTimes(1);
  });

  it(`should ask EAS itself when the builds section found another profile`, async () => {
    const lookUp = vi.spyOn(easBuildLookup, 'lookUpEasSimulatorBuildAsync').mockResolvedValue(null);
    saveEasRequest();
    buildsFound('development');

    await collectStatusReportAsync(projectRoot, {
      devServerUrl: null,
      fingerprintCache: false,
      buildLookupTimeoutMs: 1_000,
    });

    expect(lookUp).toHaveBeenCalledWith(projectRoot, 'ios', {
      fingerprintCache: false,
      timeoutMs: 1_000,
    });
  });
});

// @ref llp/0004-smart-start-and-project-state.rfc.md §Reported by status
describe(`${collectStatusReportAsync.name} and the installed section`, () => {
  const installed = {
    outcome: 'up-to-date' as const,
    platforms: [],
  };

  beforeEach(() => {
    vi.mocked(readInstalledStatusAsync).mockResolvedValue(installed);
  });

  it(`reads the device on a plain run, with no device named`, async () => {
    const report = await collectStatusReportAsync(projectRoot, options);
    expect(readInstalledStatusAsync).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({ device: null })
    );
    expect(report.installed).toEqual(installed);
  });

  // @ref llp/0035-one-device-per-worktree.rfc.md §Session binding
  it(`replaces the installed advice with the recorded EAS session`, async () => {
    vi.mocked(readInstalledStatusAsync).mockResolvedValue({
      outcome: 'unknown',
      platforms: [
        {
          platform: 'ios',
          status: 'unknown',
          reason: 'no-device',
          recommendation: 'No simulator is booted.',
          commands: ['npx @expo/agent-cli dev --ios'],
          deviceName: null,
          installedHash: null,
          currentHash: null,
        },
      ],
    });
    vi.spyOn(summary, 'readBindingSummaryAsync').mockResolvedValueOnce([
      {
        platform: 'ios',
        backend: 'cloud',
        id: 'sess-1',
        name: 'sess-1',
        origin: 'started',
        state: 'recorded',
        expiresAt: '2999-01-01T00:00:00.000Z',
      },
    ]);

    const report = await collectStatusReportAsync(projectRoot, options);

    const [row] = report.installed!.platforms;
    expect(row).toMatchObject({ reason: 'cloud-session', commands: [] });
  });

  // @ref llp/0021-honest-reports.rfc.md §How they show up
  it(`names dev --eas, and an expired lease, when the own EAS session binding expired`, async () => {
    vi.mocked(readInstalledStatusAsync).mockResolvedValue({
      outcome: 'unknown',
      platforms: [
        {
          platform: 'ios',
          status: 'unknown',
          reason: 'no-device',
          recommendation: 'No simulator is booted.',
          commands: ['npx @expo/agent-cli dev --ios --detach --wait-ready'],
          deviceName: null,
          installedHash: null,
          currentHash: null,
        },
      ],
    });
    writeCloudBinding(projectRoot, 'ios', 'sess-1', {
      boundAt: '2019-12-31T00:00:00.000Z',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });

    const report = await collectStatusReportAsync(projectRoot, { ...options, platform: 'ios' });

    const command = 'npx @expo/agent-cli dev --ios --eas --detach --wait-ready';
    expect(report.next?.command).toBe(command);
    expect(report.next?.why).toContain('sess-1');
    const [row] = report.installed!.platforms;
    expect(row).toMatchObject({ reason: 'cloud-session', commands: [command] });
    const text = stripVTControlCharacters(formatStatusReport(report));
    expect(text).not.toContain('EAS Simulator session, gone');
    expect(text).not.toContain('No simulator is booted.');
  });

  it(`hands the named device through`, async () => {
    await collectStatusReportAsync(projectRoot, { ...options, device: 'Pixel_9' });
    expect(readInstalledStatusAsync).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({ device: 'Pixel_9' })
    );
  });

  // The tier-0 harness has no device this could be true about (llp/0002 §Tier 0).
  it(`reads no device when AGENT_CLI_NO_DEVICE is set`, async () => {
    vi.stubEnv('AGENT_CLI_NO_DEVICE', '1');
    try {
      const report = await collectStatusReportAsync(projectRoot, options);
      expect(readInstalledStatusAsync).not.toHaveBeenCalled();
      expect(report.installed).toBeNull();
      expect(report.errors.installed).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

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

  it(`bounds the read and keeps the rest of the report when it runs out of time`, async () => {
    vi.mocked(readInstalledStatusAsync).mockImplementationOnce(() => new Promise(() => {}));
    const report = await collectStatusReportAsync(projectRoot, {
      ...options,
      installedReadTimeoutMs: 10,
    });
    expect(report.installed).toBeNull();
    expect(report.errors.installed).toBe('The installed-app check did not finish within 0.01s.');
    expect(report.project).not.toBeNull();
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
    vi.spyOn(appConfig, 'readEasProject').mockReturnValue({
      projectId: null,
      source: null,
      evaluationError: null,
      unreadable: false,
    });
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

// @ref llp/0035-one-device-per-worktree.rfc.md §Session cleanup
describe('the EAS session of a deleted worktree', () => {
  const gone = '/gone-worktree';
  function orphan(id = 'sess-orphan') {
    vol.mkdirSync(gone, { recursive: true });
    writeCloudBinding(gone, 'ios', id, {
      boundAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    fs.rmSync(gone, { recursive: true });
  }

  it('is named with its path, and plain dev:stop stops it', async () => {
    orphan();
    const report = await collectStatusReportAsync(projectRoot, options);
    const command = 'npx @expo/agent-cli dev:stop';
    expect(report.orphanSessions).toEqual([
      { platform: 'ios', id: 'sess-orphan', projectRoot: gone, command },
    ]);
    expect(report.next?.command).not.toBe(command);
    expect(buildStatusFollowUps(report)[0]).toMatchObject({ command });
  });

  it('names simulator:stop --id when this worktree runs a dev server', async () => {
    orphan();
    vi.mocked(devLock.readDevServerLockAsync).mockResolvedValue(lockInfo({ port: 8081 }));
    const report = await collectStatusReportAsync(projectRoot, options);
    expect(report.orphanSessions?.[0]?.command).toBe(
      'npx --yes eas-cli simulator:stop --id sess-orphan'
    );
  });

  it('is empty when no deleted worktree has a session', async () => {
    const report = await collectStatusReportAsync(projectRoot, options);
    expect(report.orphanSessions).toEqual([]);
  });
});
