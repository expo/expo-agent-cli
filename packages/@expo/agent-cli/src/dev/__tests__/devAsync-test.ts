import { vol } from 'memfs';
import os from 'os';
import path from 'path';

import { readDevServerLockAsync, type DevServerLockInfo } from '../../devLock';
import type { FollowUp } from '../../followups';
import { Log } from '../../log';
import { emitStartPlan } from '../../plan/emit';
import { readLastBuildRecord, recordLastBuildFingerprint } from '../../plan/lastBuild';
import { clearFingerprintMemo } from '../../project/fingerprint';
import { clearFingerprintCache } from '../../project/fingerprintCache';
import { probeProjectStateAsync } from '../../project/probe';
import { probeBundlerAsync } from '../../runtime/bundlerStatus';
import { resolveStartPlanAsync } from '../../plan/resolveAsync';
import type { PlanStep, ProjectState, StartPlan } from '../../project/types';
import { runDevServerAsync, type DevServerRun } from '../../start/startAsync';
import { runExpoAsync, spawnExpoAsync } from '../../utils/expoCli';
import { isInteractive } from '../../utils/interactive';
import { spawnSubprocessAsync } from '../../utils/subprocess';
import { devAsync } from '../devAsync';
import { devServerAppearedError } from '../ownDevServer';
import { findFreePortAsync, formatPortMove, resolvePlannedPortAsync } from '../portCollision';
import { findPortListenerAsync } from '../portListener';
import { resolveDevOptions } from '../resolveOptions';
import { isExpoDevServerAsync } from '../stopAsync';

vi.mock('../../log');
// The machine running the tests may have its own Metro on 8081.
vi.mock('../portCollision', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../portCollision')>();
  return {
    ...actual,
    resolvePlannedPortAsync: vi.fn(async (requested: number | null) => ({
      port: requested ?? 8081,
      movedFrom: null,
      bindable: true,
    })),
    findFreePortAsync: vi.fn(actual.findFreePortAsync),
  };
});
// No dev server of this project is running unless a test says one is.
vi.mock('../../devLock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../devLock')>()),
  readDevServerLockAsync: vi.fn(async () => null),
}));
// A lock's dev server answers `/status` for this project unless a test says otherwise.
vi.mock('../../runtime/bundlerStatus', () => ({ probeBundlerAsync: vi.fn() }));
vi.mock('../../needsHuman/easProject', () => ({ assertEasProjectConfiguredAsync: vi.fn() }));
vi.mock('../openApp', () => ({
  openAppOnDeviceAsync: vi.fn(),
  openAppFailureLine: vi.fn((platform: string, reason: string) => `${platform}: ${reason}`),
}));
vi.mock('../../plan/emit', () => ({ emitStartPlan: vi.fn() }));
// The real resolver, which a test replaces once when it needs a plan shape the probe cannot reach
// without a device: the install plan, and the EAS plan.
vi.mock('../../plan/resolveAsync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../plan/resolveAsync')>();
  return { ...actual, resolveStartPlanAsync: vi.fn(actual.resolveStartPlanAsync) };
});
vi.mock('../../utils/easCli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/easCli')>()),
  resolveEasCliOrThrow: vi.fn(() => ({ command: 'eas', prefixArgs: [] })),
}));
vi.mock('../../utils/subprocess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/subprocess')>()),
  spawnSubprocessAsync: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));
vi.mock('../../plan/events', () => ({ event: vi.fn(), debugEvent: vi.fn() }));
vi.mock('../../plan/lastBuild', () => ({
  readLastBuildRecord: vi.fn(() => ({})),
  recordLastBuildFingerprint: vi.fn(),
}));
vi.mock('../../project/probe', () => ({ probeProjectStateAsync: vi.fn() }));
vi.mock('../../project/fingerprint', () => ({ clearFingerprintMemo: vi.fn() }));
vi.mock('../../project/fingerprintCache', () => ({ clearFingerprintCache: vi.fn() }));
vi.mock('../../utils/expoCli', () => ({ runExpoAsync: vi.fn(), spawnExpoAsync: vi.fn() }));
vi.mock('../../start/startAsync', () => ({ runDevServerAsync: vi.fn() }));
// A person at a terminal by default, which is the path these tests were written for: the plan's
// steps inherit the terminal, and nothing about their output is this command's business. The
// runs nobody is watching get their own block at the end of the file.
vi.mock('../../utils/interactive', () => ({ isInteractive: vi.fn(() => true) }));
// @ref llp/0015-backend-selection-and-config.rfc.md §The selection
// A unit test must not depend on whether the machine running it has Xcode or an Android SDK
// either: that fact now decides which *steps* a building plan contains, so a CI box with neither
// would turn every local-build assertion in this file into an assertion about a cloud build. The
// tests that care about the choice stub this themselves.
vi.mock('../../toolchain', async () => {
  const actual = await vi.importActual('../../toolchain');
  return {
    ...actual,
    detectToolchainAsync: vi.fn(async (platform: 'ios' | 'android') => ({
      platform,
      status: 'present',
      detail: `The ${platform} toolchain, stubbed for this test.`,
      requirement: `the ${platform} toolchain on this machine`,
      caveats: [],
      impossible: false,
    })),
  };
});
// A unit test must not depend on whether the machine running it has a simulator booted
// (llp/0009 §Device-aware ladders); `unknown` leaves every rung of the ladder as it was.
vi.mock('../../device/localDevice', () => ({
  probeLocalDeviceAsync: vi.fn(async () => ({ state: 'unknown', device: null, reason: null })),
}));
// The busy-port stop names the process on the port and probes it as a dev server; a unit test
// must not read this machine's listeners.
vi.mock('../portListener', async () => ({
  ...(await vi.importActual<typeof import('../portListener')>('../portListener')),
  findPortListenerAsync: vi.fn(async () => null),
}));
vi.mock('../stopAsync', async () => ({
  ...(await vi.importActual<typeof import('../stopAsync')>('../stopAsync')),
  isExpoDevServerAsync: vi.fn(async () => false),
}));
// The follow-ups of a run are reported rather than embedded in the emitted plan, so this is where
// a test reads them. The real reporter still runs, so the `Suggested next:` section is real too.
vi.mock('../../followups', async () => {
  const actual = await vi.importActual<typeof import('../../followups')>('../../followups');
  return {
    ...actual,
    reportFollowUps: vi.fn((command: string, followups: any[], options: any) => {
      mockReported.push(followups);
      return actual.reportFollowUps(command, followups, options);
    }),
  };
});

/** Every list of follow-ups the run reported, in order. */
const mockReported: any[][] = [];

const projectRoot = '/project';

/** This project's own dev server, as its lock answers: an Expo Go `expo start`. */
const ownLock: DevServerLockInfo = {
  url: 'http://127.0.0.1:8190',
  port: 8190,
  pid: 4242,
  startedAt: '2026-10-06T00:00:00.000Z',
  projectRoot,
  args: ['start', '--go', '--port', '8190'],
};
/** The same dev server, started for a development build. */
const devClientLock: DevServerLockInfo = {
  ...ownLock,
  args: ['start', '--dev-client', '--port', '8190'],
};

/** `/status` answers, as a probe of the lock's port reports them. */
const answersOurs = { answering: true, projectRootMatched: true, reportedProjectRoot: projectRoot };
const answersForeign = {
  answering: true,
  projectRootMatched: false,
  reportedProjectRoot: '/other-project',
};
const answersNothing = { answering: false, projectRootMatched: null, reportedProjectRoot: null };
const fingerprintHash = 'abc123def4567890';

/** What one dev-server run answers with, as `runDevServerAsync` reports it. */
function devServerRun(overrides: Partial<DevServerRun> = {}): DevServerRun {
  return { exitCode: 0, stdout: '', stderr: '', port: null, ...overrides };
}
const realPlatform = process.platform;

function mockPlatform(value: typeof process.platform) {
  Object.defineProperty(process, 'platform', { value });
}

function mockProjectState(overrides: Partial<ProjectState> = {}): ProjectState {
  const state: ProjectState = {
    projectRoot,
    isExpoApp: true,
    sdkVersion: '54.0.0',
    nativeDirs: { ios: false, android: false },
    usesDevClient: false,
    hasWeb: true,
    expoGo: { compatible: true, reasons: [] },
    fingerprint: { hash: fingerprintHash },
    ...overrides,
  };
  vi.mocked(probeProjectStateAsync).mockResolvedValue(state);
  return state;
}

/** The state of a managed project that needs a new development build. */
function mockStaleDevClientState(overrides: Partial<ProjectState> = {}): ProjectState {
  return mockProjectState({
    usesDevClient: true,
    expoGo: {
      compatible: false,
      reasons: [{ kind: 'config-plugin', detail: 'the app config uses a config plugin' }],
    },
    ...overrides,
  });
}

/** The follow-ups the run reported, which are the ones a caller sees. */
function emittedFollowUps(): FollowUp[] {
  return mockReported.at(-1) ?? [];
}

function emittedFollowUpIds(): string[] {
  return emittedFollowUps().map((followup) => followup.id);
}

/** Pin this host's LAN address, so the real-device follow-up does not depend on the machine. */
function mockLanAddress(address: string | null) {
  vi.spyOn(os, 'networkInterfaces').mockReturnValue(
    address
      ? ({ en0: [{ address, family: 'IPv4', internal: false }] } as any)
      : ({ lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] } as any)
  );
}

beforeEach(() => {
  vol.reset();
  vi.mocked(readDevServerLockAsync).mockResolvedValue(null);
  vi.mocked(probeBundlerAsync).mockResolvedValue(answersOurs);
  mockReported.length = 0;
  vi.mocked(readLastBuildRecord).mockReturnValue({});
  vi.mocked(runExpoAsync).mockResolvedValue(0);
  vi.mocked(isInteractive).mockReturnValue(true);
  vi.mocked(spawnExpoAsync).mockResolvedValue({
    cli: { command: 'expo', args: [] },
    result: { exitCode: 0, stdout: '', stderr: '' },
  });
  vi.mocked(runDevServerAsync).mockResolvedValue(devServerRun());
  mockLanAddress('192.168.1.5');
});

afterEach(() => {
  mockPlatform(realPlatform);
  vi.restoreAllMocks();
});

describe(devAsync, () => {
  describe('--plan', () => {
    it(`should emit the plan and run nothing`, async () => {
      mockStaleDevClientState();

      await expect(devAsync(projectRoot, resolveDevOptions(['--plan', '--ios']))).resolves.toBe(0);

      expect(emitStartPlan).toHaveBeenCalledWith(
        expect.objectContaining({ rule: 'dev-client-stale' }),
        { mode: 'plan', json: false, followups: expect.any(Array) }
      );
      expect(runExpoAsync).not.toHaveBeenCalled();
      expect(runDevServerAsync).not.toHaveBeenCalled();
    });

    it(`should decide from the probed project state`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--plan', '--ios']));

      expect(probeProjectStateAsync).toHaveBeenCalledWith(projectRoot, {
        fingerprintCache: true,
      });
      expect(emitStartPlan).toHaveBeenCalledWith(expect.objectContaining({ rule: 'expo-go' }), {
        mode: 'plan',
        json: false,
        followups: expect.any(Array),
      });
    });
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Status — Default change
  describe('no flag (running the plan is the default)', () => {
    it(`should emit the plan and run it`, async () => {
      mockProjectState();

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      expect(emitStartPlan).toHaveBeenCalledWith(expect.objectContaining({ rule: 'expo-go' }), {
        mode: 'smart',
        print: 'text',
        followups: [],
      });
      expect(runDevServerAsync).toHaveBeenCalledWith(
        projectRoot,
        ['start', '--go', '--port', '8081'],
        {
          agentSkills: true,
          output: 'inherit',
          oneDevServer: expect.any(Object),
          onDevServer: expect.any(Function),
        }
      );
    });

    it(`should run every step of a plan that builds`, async () => {
      mockStaleDevClientState();

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['prebuild', '--platform', 'ios']);
      expect(runDevServerAsync).toHaveBeenCalledWith(projectRoot, ['run:ios', '--port', '8081'], {
        agentSkills: true,
        output: 'inherit',
        oneDevServer: expect.any(Object),
      });
    });
  });

  // @ref llp/0008-guardrails.rfc.md §The plan is announced, not negotiated
  //
  // The case this table is here for: `dev --ios` in a terminal, on a project whose development
  // build is stale, so the plan is a prebuild and a native build — minutes of work that writes into
  // the project. That used to stop and hand back the same line with `--yes`. It runs.
  describe('a plan that builds', () => {
    it.each([
      ['a terminal', true],
      ['a pipe', false],
    ])(`should run the build steps in %s, asking nothing`, async (_where, interactive) => {
      mockStaleDevClientState();
      vi.mocked(isInteractive).mockReturnValue(interactive);

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      // Either spawner, because which one runs a step is a question about stdio, not about
      // consent: a terminal gets `runExpoAsync` and its inherited stdio, a pipe gets
      // `spawnExpoAsync` with `tee` (`stepOutputFor`).
      const prebuild = [
        ...vi.mocked(runExpoAsync).mock.calls,
        ...vi.mocked(spawnExpoAsync).mock.calls,
      ].map(([, args]) => args);
      expect(prebuild).toContainEqual(['prebuild', '--platform', 'ios']);
      expect(runDevServerAsync).toHaveBeenCalledWith(
        projectRoot,
        ['run:ios', '--port', '8081'],
        expect.anything()
      );
    });

    it(`should still run nothing in --plan mode, which is the run that stops`, async () => {
      mockStaleDevClientState();

      await expect(devAsync(projectRoot, resolveDevOptions(['--plan', '--ios']))).resolves.toBe(0);

      expect(runExpoAsync).not.toHaveBeenCalled();
      expect(runDevServerAsync).not.toHaveBeenCalled();
    });
  });

  describe('running the plan', () => {
    it(`should emit the plan before running any step`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--ios']));

      expect(emitStartPlan).toHaveBeenCalledWith(expect.objectContaining({ rule: 'expo-go' }), {
        mode: 'smart',
        print: 'text',
        followups: [],
      });
    });

    it(`should run a single dev server step through the start wrapper`, async () => {
      mockProjectState();

      await expect(
        devAsync(projectRoot, resolveDevOptions(['--ios', '--port', '8082']))
      ).resolves.toBe(0);

      expect(runDevServerAsync).toHaveBeenCalledWith(
        projectRoot,
        ['start', '--go', '--port', '8082'],
        {
          agentSkills: true,
          output: 'inherit',
          oneDevServer: expect.any(Object),
          onDevServer: expect.any(Function),
        }
      );
      expect(runExpoAsync).not.toHaveBeenCalled();
    });

    // One project has one dev server: the serving step stops on a live holder of the lock, where
    // the plain `start` wrapper starts a second one.
    it(`should ask the serving step for one dev server per project`, async () => {
      mockStaleDevClientState();

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      expect(runDevServerAsync).toHaveBeenCalledWith(
        projectRoot,
        ['run:ios', '--port', '8081'],
        expect.objectContaining({ oneDevServer: { platform: 'ios', built: null } })
      );
    });

    it(`should keep the skill sync opt-out`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--ios', '--no-agent-skills']));

      expect(runDevServerAsync).toHaveBeenCalledWith(
        projectRoot,
        ['start', '--go', '--port', '8081'],
        {
          agentSkills: false,
          output: 'inherit',
          oneDevServer: expect.any(Object),
          onDevServer: expect.any(Function),
        }
      );
    });

    it(`should not repeat a platform flag the plan already passes`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--web']));

      expect(runDevServerAsync).toHaveBeenCalledWith(
        projectRoot,
        ['start', '--web', '--port', '8081'],
        {
          agentSkills: true,
          output: 'inherit',
          oneDevServer: expect.any(Object),
        }
      );
    });

    // @ref llp/0026-dev-owns-the-open.rfc.md — the open is this command's own act, hung on the
    // moment the dev server reports where it listens.
    describe('the open', () => {
      it(`should arm the open for a native run`, async () => {
        mockProjectState();

        await devAsync(projectRoot, resolveDevOptions(['--ios']));

        const [, , opts] = vi.mocked(runDevServerAsync).mock.calls[0]!;
        expect(opts!.onDevServer).toEqual(expect.any(Function));
      });

      it(`should open the app once the dev server reports its port`, async () => {
        mockProjectState();
        const { openAppOnDeviceAsync } = await import('../openApp');
        vi.mocked(openAppOnDeviceAsync).mockResolvedValue({
          opened: true,
          deviceId: 'UDID-1',
          booted: false,
          installedExpoGo: false,
          reason: null,
        });
        vi.mocked(runDevServerAsync).mockImplementation(async (_root, _args, opts) => {
          opts?.onDevServer?.({ url: 'http://127.0.0.1:8081', port: 8081 });
          return devServerRun();
        });

        await devAsync(projectRoot, resolveDevOptions(['--ios']));
        // The open is fire-and-forget; give its promise the turn it needs.
        await new Promise((resolve) => setImmediate(resolve));

        expect(openAppOnDeviceAsync).toHaveBeenCalledWith(
          projectRoot,
          expect.objectContaining({
            platform: 'ios',
            expoGo: true,
            devServerUrl: 'http://127.0.0.1:8081',
          })
        );
      });

      it(`should arm nothing under --no-open`, async () => {
        mockProjectState();

        await devAsync(projectRoot, resolveDevOptions(['--ios', '--no-open']));

        const [, args, opts] = vi.mocked(runDevServerAsync).mock.calls[0]!;
        // The platform never reaches `expo start` either: its --ios form opens the app through
        // the osascript this command exists to avoid.
        expect(args).toEqual(['start', '--go', '--port', '8081']);
        expect(opts!.onDevServer).toBeUndefined();
      });

      it(`should arm nothing for the web target, which is served rather than opened`, async () => {
        mockProjectState();

        await devAsync(projectRoot, resolveDevOptions(['--web']));

        const [, , opts] = vi.mocked(runDevServerAsync).mock.calls[0]!;
        expect(opts!.onDevServer).toBeUndefined();
      });

      it(`should arm nothing under AGENT_CLI_NO_DEVICE, which a stubbed harness sets`, async () => {
        mockProjectState();
        process.env.AGENT_CLI_NO_DEVICE = '1';
        try {
          await devAsync(projectRoot, resolveDevOptions(['--ios']));
        } finally {
          delete process.env.AGENT_CLI_NO_DEVICE;
        }

        const [, , opts] = vi.mocked(runDevServerAsync).mock.calls[0]!;
        expect(opts!.onDevServer).toBeUndefined();
      });
    });

    it(`should run every step in order, ending with the dev server`, async () => {
      mockStaleDevClientState();

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      expect(runExpoAsync).toHaveBeenCalledTimes(1);
      expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['prebuild', '--platform', 'ios']);
      expect(runDevServerAsync).toHaveBeenCalledWith(projectRoot, ['run:ios', '--port', '8081'], {
        agentSkills: true,
        output: 'inherit',
        oneDevServer: expect.any(Object),
      });
    });

    // The code is still the subprocess's own (llp/0010 §Exit codes); what changed is that a run
    // whose step failed reports a failure instead of its plan.
    it(`should stop at the first failing step and forward its exit code`, async () => {
      mockStaleDevClientState();
      vi.mocked(runExpoAsync).mockResolvedValue(2);

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).rejects.toMatchObject({
        code: 'PLAN_STEP_FAILED',
        exitCode: 2,
      });

      expect(runDevServerAsync).not.toHaveBeenCalled();
      expect(recordLastBuildFingerprint).not.toHaveBeenCalled();
    });

    it(`should record the fingerprint of a build that succeeded`, async () => {
      mockStaleDevClientState();

      await devAsync(projectRoot, resolveDevOptions(['--android']));

      expect(recordLastBuildFingerprint).toHaveBeenCalledWith(projectRoot, 'android', {
        hash: fingerprintHash,
        sources: null,
      });
    });

    // @ref llp/0023-fingerprint-caching.rfc.md §What invalidates an answer
    // The pinned files of the fingerprint cache are stamps of the project's config and lockfiles and
    // say nothing about `ios/` or `android/`, so `expo prebuild` — which creates them — moves
    // nothing the record is keyed on. Its expiry catches that eventually; dropping both caches after
    // the step catches it now, for the one prebuild this CLI runs itself.
    it(`should forget both fingerprint caches after a step that changed the project`, async () => {
      mockStaleDevClientState();

      await devAsync(projectRoot, resolveDevOptions(['--android']));

      expect(clearFingerprintMemo).toHaveBeenCalledWith(projectRoot);
      expect(clearFingerprintCache).toHaveBeenCalledWith(projectRoot);
    });

    it(`should not touch the fingerprint caches when a step failed`, async () => {
      mockStaleDevClientState();
      vi.mocked(runExpoAsync).mockResolvedValue(2);

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).rejects.toMatchObject({
        code: 'PLAN_STEP_FAILED',
      });

      // The plan stopped, so the project is in whatever state the failed step left. Nothing was
      // *completed*, and a cache dropped here would only cost the next run a second.
      expect(clearFingerprintCache).not.toHaveBeenCalled();
    });

    it(`should not record a fingerprint of a build that failed`, async () => {
      mockStaleDevClientState();
      vi.mocked(runDevServerAsync).mockResolvedValue(devServerRun({ exitCode: 1 }));

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).rejects.toMatchObject({
        exitCode: 1,
      });

      expect(recordLastBuildFingerprint).not.toHaveBeenCalled();
    });

    // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
    // F121. `expo run:*` is one subprocess that builds, installs *and* serves, and the record used
    // to be written only when all three worked — so a run whose app is on the device and whose
    // launch then failed left the next plan planning another fifteen minutes
    // [observed — wave 29, `evidence/07-dev-build-ios-2.log`]. The build is a fact of its own.
    it(`should record the build when the step failed after installing the app`, async () => {
      mockStaleDevClientState();
      vi.mocked(runDevServerAsync).mockResolvedValue(
        devServerRun({
          exitCode: 1,
          stdout: '› Build Succeeded\n› Installing on iPhone 17 Pro\n› Opening on iPhone 17 Pro',
          stderr: 'Error: osascript -e tell app "System Events" exited with non-zero code: 1',
        })
      );

      // Exit 7, because that is what the observed run was: the launch step is `osascript`, and the
      // Automation refusal is a stop only a person can clear. The record is written **before** that
      // handoff is thrown — its own `How:` sends the reader to `npx @expo/agent-cli dev --ios`, which used
      // to be the same fifteen minutes over again.
      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).rejects.toMatchObject({
        exitCode: 7,
        message: expect.stringContaining('the app it built is installed on the simulator already'),
      });

      expect(recordLastBuildFingerprint).toHaveBeenCalledWith(projectRoot, 'ios', {
        hash: fingerprintHash,
        sources: null,
      });
    });

    // The launch failure is still reported — it is its own fact — and the report says the build
    // was kept, because "run it again" costs fifteen minutes if that sentence is missing.
    it(`should say the build was recorded in the failure it reports`, async () => {
      mockStaleDevClientState();
      vi.mocked(runDevServerAsync).mockResolvedValue(
        devServerRun({ exitCode: 1, stdout: '› Build Succeeded\n› Installing on iPhone 17 Pro' })
      );

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).rejects.toMatchObject({
        code: 'PLAN_STEP_FAILED',
        message: expect.stringContaining('the app it built is installed'),
      });
    });

    it(`should not record a build for a step that installed nothing`, async () => {
      mockStaleDevClientState();
      vi.mocked(runDevServerAsync).mockResolvedValue(
        devServerRun({ exitCode: 1, stdout: '› Build Succeeded', stderr: 'error: code signing' })
      );

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).rejects.toMatchObject({
        exitCode: 1,
      });

      expect(recordLastBuildFingerprint).not.toHaveBeenCalled();
    });

    it(`should not record anything when the fingerprint is unavailable`, async () => {
      mockStaleDevClientState({ fingerprint: { hash: null, error: 'fingerprint failed' } });

      await devAsync(projectRoot, resolveDevOptions(['--ios']));

      expect(recordLastBuildFingerprint).not.toHaveBeenCalled();
    });

    it(`should reuse a development build recorded for the current fingerprint`, async () => {
      mockStaleDevClientState();
      vi.mocked(readLastBuildRecord).mockReturnValue({
        ios: { hash: fingerprintHash, sources: null },
      });

      await devAsync(projectRoot, resolveDevOptions(['--ios']));

      expect(emitStartPlan).toHaveBeenCalledWith(
        expect.objectContaining({ rule: 'dev-client-fresh' }),
        { mode: 'smart', print: 'text', followups: [] }
      );
      expect(runExpoAsync).not.toHaveBeenCalled();
      expect(runDevServerAsync).toHaveBeenCalledWith(
        projectRoot,
        ['start', '--dev-client', '--port', '8081'],
        {
          agentSkills: true,
          output: 'inherit',
          oneDevServer: expect.any(Object),
          onDevServer: expect.any(Function),
        }
      );
    });

    it(`should warn that expo start options do not reach a build step`, async () => {
      mockStaleDevClientState();

      await devAsync(projectRoot, resolveDevOptions(['--ios', '--tunnel']));

      expect(Log.warn).toHaveBeenCalledWith(expect.stringMatching(/not passed on: --tunnel/));
      expect(runDevServerAsync).toHaveBeenCalledWith(projectRoot, ['run:ios', '--port', '8081'], {
        agentSkills: true,
        output: 'inherit',
        oneDevServer: expect.any(Object),
      });
    });

    // @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port is not a step only a person
    // can complete — `expo run:*` bakes the port into the app, so it gets the named one too.
    it(`should pass a named port to the build step that serves`, async () => {
      mockStaleDevClientState();

      await devAsync(projectRoot, resolveDevOptions(['--ios', '--port', '8082']));

      expect(Log.warn).not.toHaveBeenCalled();
      expect(runDevServerAsync).toHaveBeenCalledWith(projectRoot, ['run:ios', '--port', '8082'], {
        agentSkills: true,
        output: 'inherit',
        oneDevServer: expect.any(Object),
      });
    });

    it(`should run every serving step on the port it picked, and say once that it moved`, async () => {
      mockStaleDevClientState();
      vi.mocked(resolvePlannedPortAsync).mockResolvedValueOnce({
        port: 8082,
        movedFrom: 8081,
        bindable: true,
      });

      await devAsync(projectRoot, resolveDevOptions(['--ios']));

      expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['prebuild', '--platform', 'ios']);
      expect(runDevServerAsync).toHaveBeenCalledWith(projectRoot, ['run:ios', '--port', '8082'], {
        agentSkills: true,
        output: 'inherit',
        oneDevServer: expect.any(Object),
      });
      const warnings = vi.mocked(Log.warn).mock.calls.map(([line]) => String(line));
      expect(warnings.filter((line) => line.includes('the dev server uses'))).toEqual([
        expect.stringContaining(formatPortMove({ busy: 8081, to: 8082, when: 'plan' })),
      ]);
      expect(vi.mocked(emitStartPlan).mock.calls[0]![0]).toMatchObject({
        devServerPort: { port: 8082, movedFrom: 8081 },
      });
    });

    it(`should put the picked port on the plan it prints under --plan`, async () => {
      mockStaleDevClientState();
      vi.mocked(resolvePlannedPortAsync).mockResolvedValueOnce({
        port: 8082,
        movedFrom: 8081,
        bindable: true,
      });

      await devAsync(projectRoot, resolveDevOptions(['--ios', '--plan']));

      const [plan] = vi.mocked(emitStartPlan).mock.calls[0]!;
      expect(plan.devServerPort).toEqual({ port: 8082, movedFrom: 8081, state: 'picked' });
      expect(plan.steps.map((step) => step.argv)).toEqual([
        ['expo', 'prebuild', '--platform', 'ios'],
        ['expo', 'run:ios', '--port', '8082'],
      ]);
      expect(plan.reasons).toContain('The dev server port is picked again when the plan runs.');
      expect(runDevServerAsync).not.toHaveBeenCalled();
    });

    it(`should say under --plan that a named port is taken`, async () => {
      mockStaleDevClientState();
      vi.mocked(resolvePlannedPortAsync).mockResolvedValueOnce({
        port: 8180,
        movedFrom: null,
        bindable: false,
      });

      await devAsync(projectRoot, resolveDevOptions(['--ios', '--plan', '--port', '8180']));

      const [plan] = vi.mocked(emitStartPlan).mock.calls[0]!;
      expect(plan.devServerPort).toEqual({
        port: 8180,
        movedFrom: null,
        state: 'named',
        taken: true,
      });
      expect(plan.reasons).not.toContain('The dev server port is picked again when the plan runs.');
    });

    describe(`with this project's own dev server running`, () => {
      beforeEach(() => {
        vi.mocked(readDevServerLockAsync).mockResolvedValue(ownLock);
      });

      // No dependence on the Expo CLI noticing its own server: the build installs with
      // `--no-bundler`, and the open after it connects the app to the lock's URL.
      it(`should install run:* with --no-bundler, and open the app against the running server`, async () => {
        mockStaleDevClientState();
        const { openAppOnDeviceAsync } = await import('../openApp');
        vi.mocked(openAppOnDeviceAsync).mockResolvedValue({
          opened: true,
          deviceId: 'UDID-1',
          booted: false,
          installedExpoGo: false,
          reason: null,
        });
        const env = process.env.AGENT_CLI_NO_DEVICE;
        delete process.env.AGENT_CLI_NO_DEVICE;

        try {
          await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);
        } finally {
          if (env !== undefined) process.env.AGENT_CLI_NO_DEVICE = env;
        }

        expect(resolvePlannedPortAsync).not.toHaveBeenCalled();
        expect(runDevServerAsync).not.toHaveBeenCalled();
        const args = vi
          .mocked(runExpoAsync)
          .mock.calls.map(([, stepArgs]) => stepArgs)
          .find((stepArgs) => stepArgs[0] === 'run:ios')!;
        expect(args.at(-1)).toBe('--no-bundler');
        expect(args).not.toContain('--port');
        expect(openAppOnDeviceAsync).toHaveBeenCalledWith(
          projectRoot,
          expect.objectContaining({ platform: 'ios', devServerUrl: ownLock.url })
        );
        const [plan] = vi.mocked(emitStartPlan).mock.calls[0]!;
        expect(plan.devServerPort).toEqual({ port: 8190, movedFrom: null, state: 'reused' });
        expect(plan.reasons).toContain(
          'The dev server is already running on port 8190; the install uses the running server, and the app is opened against it.'
        );
      });

      // `expo run:* --no-bundler` builds and launches the app against 8081 (the Expo CLI's
      // `resolveBundlerProps`), and with no open after it nothing moves the app to port 8190.
      it(`should stop before the run:* install when no open follows and the server is off 8081`, async () => {
        mockStaleDevClientState();

        const error = await devAsync(projectRoot, resolveDevOptions(['--ios', '--no-open'])).then(
          () => null,
          (thrown) => thrown
        );

        expect(error).toMatchObject({ code: 'DEV_SERVER_ON_OTHER_PORT', exitCode: 20 });
        expect(error.message).toContain('running on port 8190');
        expect(error.message).toContain('not on port 8081');
        expect(runExpoAsync).not.toHaveBeenCalled();
        expect(runDevServerAsync).not.toHaveBeenCalled();
      });

      it(`should install run:* without saying the app is opened when the server is on 8081`, async () => {
        vi.mocked(readDevServerLockAsync).mockResolvedValue({ ...ownLock, port: 8081 });
        mockStaleDevClientState();

        await expect(
          devAsync(projectRoot, resolveDevOptions(['--ios', '--no-open']))
        ).resolves.toBe(0);

        const [plan] = vi.mocked(emitStartPlan).mock.calls[0]!;
        expect(plan.reasons).toContain(
          'The dev server is already running on port 8081; the install uses the running server.'
        );
        expect(plan.steps.at(-1)!.reason).toMatch(/so the step starts none\.$/);
      });

      // `agent-cli start` publishes `['start']`, and every `dev` start names a run target.
      it(`should reuse a server started by agent-cli start for a plan that names a run target`, async () => {
        vi.mocked(readDevServerLockAsync).mockResolvedValue({ ...ownLock, args: ['start'] });
        mockProjectState();

        await expect(
          devAsync(projectRoot, resolveDevOptions(['--ios', '--no-open']))
        ).resolves.toBe(0);
        expect(runDevServerAsync).not.toHaveBeenCalled();
      });

      it(`should start no second dev server, and open the app against the running one`, async () => {
        mockProjectState();
        const { openAppOnDeviceAsync } = await import('../openApp');
        vi.mocked(openAppOnDeviceAsync).mockResolvedValue({
          opened: true,
          deviceId: 'UDID-1',
          booted: false,
          installedExpoGo: false,
          reason: null,
        });
        const env = process.env.AGENT_CLI_NO_DEVICE;
        delete process.env.AGENT_CLI_NO_DEVICE;

        try {
          await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);
        } finally {
          if (env !== undefined) process.env.AGENT_CLI_NO_DEVICE = env;
        }

        expect(probeBundlerAsync).toHaveBeenCalledWith(ownLock.url, { projectRoot });
        expect(resolvePlannedPortAsync).not.toHaveBeenCalled();
        expect(runDevServerAsync).not.toHaveBeenCalled();
        expect(runExpoAsync).not.toHaveBeenCalled();
        expect(openAppOnDeviceAsync).toHaveBeenCalledWith(
          projectRoot,
          expect.objectContaining({ platform: 'ios', devServerUrl: ownLock.url })
        );
        const [plan] = vi.mocked(emitStartPlan).mock.calls[0]!;
        expect(plan.steps).toEqual([]);
      });

      // The open is the reuse run's only action, so an open that fails fails the run.
      it(`should fail the run when the open against the running server fails`, async () => {
        mockProjectState();
        const { openAppOnDeviceAsync } = await import('../openApp');
        vi.mocked(openAppOnDeviceAsync).mockResolvedValue({
          opened: false,
          deviceId: null,
          booted: false,
          installedExpoGo: false,
          reason: 'no simulator could be booted',
        });
        const env = process.env.AGENT_CLI_NO_DEVICE;
        delete process.env.AGENT_CLI_NO_DEVICE;

        try {
          await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).rejects.toMatchObject({
            code: 'APP_OPEN_FAILED',
            exitCode: 20,
            message: 'ios: no simulator could be booted',
          });
        } finally {
          if (env !== undefined) process.env.AGENT_CLI_NO_DEVICE = env;
        }
        expect(runDevServerAsync).not.toHaveBeenCalled();
        expect(Log.warn).not.toHaveBeenCalled();
      });

      it(`should print the running server's port under --json, with no steps`, async () => {
        mockProjectState();

        await expect(
          devAsync(projectRoot, resolveDevOptions(['--ios', '--no-open', '--json']))
        ).resolves.toBe(0);

        expect(runDevServerAsync).not.toHaveBeenCalled();
        const printed = JSON.parse(String(vi.mocked(Log.log).mock.calls.at(-1)![0]));
        expect(printed.steps).toEqual([]);
        expect(printed.devServerPort).toEqual({ port: 8190, movedFrom: null, state: 'reused' });
      });

      it(`should plan the running server's port under --plan, and start nothing`, async () => {
        mockProjectState();

        await expect(devAsync(projectRoot, resolveDevOptions(['--ios', '--plan']))).resolves.toBe(
          0
        );

        const [plan] = vi.mocked(emitStartPlan).mock.calls[0]!;
        expect(plan.devServerPort).toEqual({ port: 8190, movedFrom: null, state: 'reused' });
        expect(plan.steps).toEqual([]);
        expect(plan.reasons).toContain(
          'The dev server is already running on port 8190; the run reports it and starts nothing.'
        );
        expect(plan.reasons).not.toContain(
          'The dev server port is picked again when the plan runs.'
        );
        expect(resolvePlannedPortAsync).not.toHaveBeenCalled();
        expect(runDevServerAsync).not.toHaveBeenCalled();
      });

      describe('with steps before expo start', () => {
        function planStep(id: string, argv: string[]): PlanStep {
          return { id, argv, reason: `${id} step`, timeClass: 'minutes', runsOn: null };
        }
        const startStep = planStep('start', ['expo', 'start', '--dev-client']);
        const installPlan: StartPlan = {
          target: 'dev-client',
          rule: 'dev-client-install',
          reasons: [],
          buildLocation: null,
          steps: [planStep('install', ['expo', 'run:ios', '--no-bundler']), startStep],
        };
        const easPlan: StartPlan = {
          target: 'dev-client',
          rule: 'dev-client-eas',
          reasons: [],
          buildLocation: null,
          steps: [
            planStep('eas-build', ['eas', 'build', '--platform', 'ios', '--non-interactive']),
            startStep,
          ],
        };

        beforeEach(() => {
          mockStaleDevClientState();
          vi.mocked(readDevServerLockAsync).mockResolvedValue(devClientLock);
        });

        it(`should run the install, start nothing, and open the app against the running server`, async () => {
          vi.mocked(resolveStartPlanAsync).mockResolvedValueOnce(installPlan);
          const { openAppOnDeviceAsync } = await import('../openApp');
          vi.mocked(openAppOnDeviceAsync).mockResolvedValue({
            opened: true,
            deviceId: 'UDID-1',
            booted: false,
            installedExpoGo: false,
            reason: null,
          });
          const env = process.env.AGENT_CLI_NO_DEVICE;
          delete process.env.AGENT_CLI_NO_DEVICE;

          try {
            await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);
          } finally {
            if (env !== undefined) process.env.AGENT_CLI_NO_DEVICE = env;
          }

          expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['run:ios', '--no-bundler']);
          expect(runDevServerAsync).not.toHaveBeenCalled();
          expect(openAppOnDeviceAsync).toHaveBeenCalledWith(
            projectRoot,
            expect.objectContaining({ platform: 'ios', devServerUrl: ownLock.url })
          );
        });

        // The server stopped while the install ran: no deep link to a URL nothing serves.
        it(`should stop instead of opening when the server stopped during the install`, async () => {
          vi.mocked(resolveStartPlanAsync).mockResolvedValueOnce(installPlan);
          vi.mocked(runExpoAsync).mockImplementationOnce(async () => {
            vi.mocked(readDevServerLockAsync).mockResolvedValue(null);
            return 0;
          });
          const { openAppOnDeviceAsync } = await import('../openApp');
          const env = process.env.AGENT_CLI_NO_DEVICE;
          delete process.env.AGENT_CLI_NO_DEVICE;

          try {
            await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).rejects.toMatchObject(
              {
                code: 'DEV_SERVER_GONE',
                exitCode: 20,
                message: expect.stringContaining(
                  "This project's dev server on port 8190, which this run reused, stopped while the steps ran, so the app was not opened."
                ),
              }
            );
          } finally {
            if (env !== undefined) process.env.AGENT_CLI_NO_DEVICE = env;
          }
          expect(openAppOnDeviceAsync).not.toHaveBeenCalled();
          expect(runDevServerAsync).not.toHaveBeenCalled();
        });

        it(`should run the EAS build and start nothing`, async () => {
          vi.mocked(resolveStartPlanAsync).mockResolvedValueOnce(easPlan);

          await expect(
            devAsync(projectRoot, resolveDevOptions(['--ios', '--no-open']))
          ).resolves.toBe(0);

          expect(spawnSubprocessAsync).toHaveBeenCalledWith(
            'eas',
            ['build', '--platform', 'ios', '--non-interactive'],
            expect.anything()
          );
          expect(runDevServerAsync).not.toHaveBeenCalled();
          const [plan] = vi.mocked(emitStartPlan).mock.calls[0]!;
          expect(plan.steps.map((step) => step.id)).toEqual(['eas-build']);
          expect(plan.reasons).toContain(
            'The dev server is already running on port 8190; the build uses it instead of starting another.'
          );
        });

        it(`should print the plan it ran under --json, with the running server's port`, async () => {
          vi.mocked(resolveStartPlanAsync).mockResolvedValueOnce(installPlan);

          await devAsync(projectRoot, resolveDevOptions(['--ios', '--no-open', '--json']));

          const printed = JSON.parse(String(vi.mocked(Log.log).mock.calls.at(-1)![0]));
          expect(printed.steps.map((step: PlanStep) => step.id)).toEqual(['install']);
          expect(printed.devServerPort).toEqual({ port: 8190, movedFrom: null, state: 'reused' });
        });

        it(`should plan the install without expo start under --plan`, async () => {
          vi.mocked(resolveStartPlanAsync).mockResolvedValueOnce(installPlan);

          await expect(devAsync(projectRoot, resolveDevOptions(['--ios', '--plan']))).resolves.toBe(
            0
          );

          const [plan] = vi.mocked(emitStartPlan).mock.calls[0]!;
          expect(plan.steps.map((step) => step.argv)).toEqual([
            ['expo', 'run:ios', '--no-bundler'],
          ]);
          expect(plan.devServerPort).toEqual({ port: 8190, movedFrom: null, state: 'reused' });
          expect(plan.reasons).toContain(
            'The dev server is already running on port 8190; the install uses it instead of starting another.'
          );
          expect(runExpoAsync).not.toHaveBeenCalled();
          expect(runDevServerAsync).not.toHaveBeenCalled();
        });

        // @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port — a reuse drops `start`,
        // and its options with it, so a running server without them stops the run first.
        describe('when the running server lacks an option the start asks for', () => {
          const tunnelledEasPlan: StartPlan = {
            ...easPlan,
            steps: [
              easPlan.steps[0]!,
              { ...startStep, argv: ['expo', 'start', '--dev-client', '--tunnel'] },
            ],
          };

          it(`should stop before the EAS build, and start nothing`, async () => {
            vi.mocked(resolveStartPlanAsync).mockResolvedValueOnce(tunnelledEasPlan);

            const error = await devAsync(projectRoot, resolveDevOptions(['--ios'])).then(
              () => null,
              (thrown) => thrown
            );

            expect(error).toMatchObject({
              code: 'DEV_SERVER_OPTIONS_MISMATCH',
              exitCode: 20,
              suggestedCommand: expect.stringContaining('dev:stop'),
              message: expect.stringContaining(
                "This project's dev server is running on port 8190 without --tunnel, so nothing was started."
              ),
            });
            expect(spawnSubprocessAsync).not.toHaveBeenCalled();
            expect(runExpoAsync).not.toHaveBeenCalled();
            expect(runDevServerAsync).not.toHaveBeenCalled();
          });

          it(`should stop on a forwarded --clear`, async () => {
            vi.mocked(resolveStartPlanAsync).mockResolvedValueOnce(installPlan);

            await expect(
              devAsync(projectRoot, resolveDevOptions(['--ios', '--clear']))
            ).rejects.toMatchObject({
              code: 'DEV_SERVER_OPTIONS_MISMATCH',
              exitCode: 20,
              message: expect.stringContaining('without --clear'),
            });
            expect(runExpoAsync).not.toHaveBeenCalled();
            expect(runDevServerAsync).not.toHaveBeenCalled();
          });

          it(`should reuse a server that carries the same options`, async () => {
            vi.mocked(readDevServerLockAsync).mockResolvedValue({
              ...devClientLock,
              args: ['start', '--dev-client', '--port', '8190', '--tunnel'],
            });
            vi.mocked(resolveStartPlanAsync).mockResolvedValueOnce(tunnelledEasPlan);

            await expect(
              devAsync(projectRoot, resolveDevOptions(['--ios', '--no-open']))
            ).resolves.toBe(0);

            expect(spawnSubprocessAsync).toHaveBeenCalledWith(
              'eas',
              ['build', '--platform', 'ios', '--non-interactive'],
              expect.anything()
            );
            expect(runDevServerAsync).not.toHaveBeenCalled();
          });

          it(`should list no steps under --plan and say the run stops`, async () => {
            vi.mocked(resolveStartPlanAsync).mockResolvedValueOnce(tunnelledEasPlan);

            await expect(
              devAsync(projectRoot, resolveDevOptions(['--ios', '--plan']))
            ).resolves.toBe(0);

            const [plan] = vi.mocked(emitStartPlan).mock.calls[0]!;
            expect(plan.steps).toEqual([]);
            expect(plan.devServerPort).toEqual({
              port: 8190,
              movedFrom: null,
              state: 'mismatch',
              missing: ['--tunnel'],
              extra: [],
            });
            expect(plan.reasons).toContain(
              "This project's dev server is running on port 8190 without --tunnel; the run stops instead of reusing it."
            );
            expect(spawnSubprocessAsync).not.toHaveBeenCalled();
          });

          it(`should reuse a holder whose options are unknown when the start asks only for its run target`, async () => {
            vi.mocked(readDevServerLockAsync).mockResolvedValue({ ...ownLock, args: null });
            vi.mocked(resolveStartPlanAsync).mockResolvedValueOnce(installPlan);

            await expect(
              devAsync(projectRoot, resolveDevOptions(['--ios', '--no-open']))
            ).resolves.toBe(0);
            expect(runDevServerAsync).not.toHaveBeenCalled();
          });

          it(`should stop for a holder whose options are unknown when the start asks for more`, async () => {
            vi.mocked(readDevServerLockAsync).mockResolvedValue({ ...ownLock, args: null });
            vi.mocked(resolveStartPlanAsync).mockResolvedValueOnce(tunnelledEasPlan);

            await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).rejects.toMatchObject(
              {
                code: 'DEV_SERVER_OPTIONS_MISMATCH',
                message: expect.stringContaining(
                  'running on port 8190 and its options are unknown (started by an older version), while this run asks for --tunnel,'
                ),
              }
            );
            expect(spawnSubprocessAsync).not.toHaveBeenCalled();
          });
        });
      });

      // One project has one lock: a second dev server on 8200 could not hold it.
      it(`should stop when --port names another port than the running server's`, async () => {
        mockStaleDevClientState();

        const error = await devAsync(
          projectRoot,
          resolveDevOptions(['--ios', '--port', '8200'])
        ).then(
          () => null,
          (thrown) => thrown
        );

        expect(error).toMatchObject({ code: 'DEV_SERVER_ON_OTHER_PORT', exitCode: 20 });
        expect(error.message).toContain('running on port 8190');
        expect(error.message).toContain('not on the named port 8200');
        expect(resolvePlannedPortAsync).not.toHaveBeenCalled();
        expect(runDevServerAsync).not.toHaveBeenCalled();
        expect(runExpoAsync).not.toHaveBeenCalled();
      });

      it(`should say under --plan that a named port elsewhere stops the run`, async () => {
        mockStaleDevClientState();

        await expect(
          devAsync(projectRoot, resolveDevOptions(['--ios', '--plan', '--port', '8200']))
        ).resolves.toBe(0);

        const [plan] = vi.mocked(emitStartPlan).mock.calls[0]!;
        expect(plan.steps).toEqual([]);
        expect(plan.devServerPort).toEqual({
          port: 8200,
          movedFrom: null,
          state: 'elsewhere',
          running: 8190,
        });
      });

      // No open runs for the web, so the run says where the running server serves the app.
      it(`should name the running server's URL for --web`, async () => {
        mockProjectState();

        await expect(devAsync(projectRoot, resolveDevOptions(['--web']))).resolves.toBe(0);

        expect(runDevServerAsync).not.toHaveBeenCalled();
        expect(Log.log).toHaveBeenCalledWith('The web app is served at http://127.0.0.1:8190.');
        const [plan] = vi.mocked(emitStartPlan).mock.calls[0]!;
        expect(plan.reasons).toContain(
          'The dev server is already running on port 8190; the run starts nothing, and the web app is served at http://127.0.0.1:8190.'
        );
      });

      it(`should carry the running server's URL in the --json follow-ups for --web`, async () => {
        mockProjectState();

        await expect(devAsync(projectRoot, resolveDevOptions(['--web', '--json']))).resolves.toBe(
          0
        );

        const printed = JSON.parse(String(vi.mocked(Log.log).mock.calls.at(-1)![0]));
        expect(vi.mocked(Log.log)).toHaveBeenCalledTimes(1);
        expect(printed.steps).toEqual([]);
        expect(JSON.stringify(printed.followups)).toContain('8190');
      });
    });

    // @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port is not a step only a person
    // can complete — another run of this project starts its dev server while this one builds. The
    // serving step's lock claim stops on it (`runDevServerAsync`, here a mock that throws the way
    // the claim does), and the plan approved is the plan run: no switch to that server.
    describe(`with this project's dev server appearing during the steps`, () => {
      function planStep(id: string, argv: string[]): PlanStep {
        return { id, argv, reason: `${id} step`, timeClass: 'minutes', runsOn: null };
      }
      const startStep = planStep('start', ['expo', 'start', '--dev-client']);

      beforeEach(() => {
        vi.mocked(runDevServerAsync).mockImplementation(async (_root, _args, opts) => {
          throw devServerAppearedError(devClientLock, opts.oneDevServer!);
        });
      });

      it(`should run the EAS build, then stop at the start's claim, naming the build on EAS`, async () => {
        mockStaleDevClientState();
        vi.mocked(resolveStartPlanAsync).mockResolvedValueOnce({
          target: 'dev-client',
          rule: 'dev-client-eas',
          reasons: [],
          buildLocation: null,
          steps: [
            planStep('eas-build', ['eas', 'build', '--platform', 'ios', '--non-interactive']),
            startStep,
          ],
        });

        const error = await devAsync(projectRoot, resolveDevOptions(['--ios', '--json'])).then(
          () => null,
          (thrown) => thrown
        );

        expect(spawnSubprocessAsync).toHaveBeenCalledWith(
          'eas',
          ['build', '--platform', 'ios', '--non-interactive'],
          expect.anything()
        );
        expect(error).toMatchObject({ code: 'DEV_SERVER_APPEARED', exitCode: 20 });
        expect(error.message).toContain(
          'Another run of this project started a dev server on port 8190 while this one built, so this step did not start a second one.'
        );
        expect(error.message).toContain('build:run --platform ios --latest');
        expect(error.message).toContain('smoke --ios');
        expect(error.suggestedCommand).toMatch(/ status$/);
      });

      it(`should stop with DEV_SERVER_APPEARED when a lock appears during the install, with the build recorded`, async () => {
        mockStaleDevClientState();
        vi.mocked(resolveStartPlanAsync).mockResolvedValueOnce({
          target: 'dev-client',
          rule: 'dev-client-install',
          reasons: [],
          buildLocation: null,
          steps: [planStep('install', ['expo', 'run:ios', '--no-bundler']), startStep],
        });
        // A server that serves with the options the start asks for: still a stop.
        vi.mocked(runExpoAsync).mockImplementationOnce(async () => {
          vi.mocked(readDevServerLockAsync).mockResolvedValue(devClientLock);
          return 0;
        });
        const { openAppOnDeviceAsync } = await import('../openApp');

        const error = await devAsync(projectRoot, resolveDevOptions(['--ios'])).then(
          () => null,
          (thrown) => thrown
        );

        expect(error).toMatchObject({ code: 'DEV_SERVER_APPEARED', exitCode: 20 });
        expect(error.message).toContain(
          'Why: one dev server per project; the build this run did is recorded, so the next run reuses it.'
        );
        expect(recordLastBuildFingerprint).toHaveBeenCalledWith(
          projectRoot,
          'ios',
          expect.objectContaining({ hash: expect.any(String) })
        );
        expect(runDevServerAsync).toHaveBeenCalledWith(
          projectRoot,
          ['start', '--dev-client', '--port', '8081'],
          expect.objectContaining({
            oneDevServer: {
              platform: 'ios',
              built: 'the build this run did is recorded, so the next run reuses it',
            },
          })
        );
        // The lock is read once, before the plan; the plan printed is the plan run.
        expect(readDevServerLockAsync).toHaveBeenCalledTimes(1);
        expect(openAppOnDeviceAsync).not.toHaveBeenCalled();
      });

      it(`should start the dev server when no lock appeared`, async () => {
        vi.mocked(runDevServerAsync).mockResolvedValue(devServerRun());
        mockStaleDevClientState();
        vi.mocked(resolveStartPlanAsync).mockResolvedValueOnce({
          target: 'dev-client',
          rule: 'dev-client-install',
          reasons: [],
          buildLocation: null,
          steps: [planStep('install', ['expo', 'run:ios', '--no-bundler']), startStep],
        });

        await expect(
          devAsync(projectRoot, resolveDevOptions(['--ios', '--no-open']))
        ).resolves.toBe(0);

        expect(readDevServerLockAsync).toHaveBeenCalledTimes(1);
        expect(runDevServerAsync).toHaveBeenCalledTimes(1);
      });
    });

    describe(`with this project's dev server still starting`, () => {
      const installPlan: StartPlan = {
        target: 'dev-client',
        rule: 'dev-client-install',
        reasons: [],
        buildLocation: null,
        steps: [
          {
            id: 'install',
            argv: ['expo', 'run:ios', '--no-bundler'],
            reason: 'install step',
            timeClass: 'minutes',
            runsOn: null,
          },
          {
            id: 'start',
            argv: ['expo', 'start', '--dev-client'],
            reason: 'start step',
            timeClass: 'seconds',
            runsOn: null,
          },
        ],
      };

      beforeEach(() => {
        vi.mocked(readDevServerLockAsync).mockResolvedValue(ownLock);
        vi.mocked(probeBundlerAsync).mockResolvedValue(answersNothing);
      });

      it(`should stop with an outcome and start nothing`, async () => {
        mockProjectState();

        const error = await devAsync(projectRoot, resolveDevOptions(['--ios'])).then(
          () => null,
          (thrown) => thrown
        );

        expect(error).toMatchObject({
          code: 'DEV_SERVER_STARTING',
          exitCode: 20,
          message: expect.stringContaining(
            "This project's dev server is starting on port 8190 (pid 4242), so nothing was started."
          ),
        });
        expect(runDevServerAsync).not.toHaveBeenCalled();
        expect(runExpoAsync).not.toHaveBeenCalled();
      });

      it(`should stop the install plan before its install`, async () => {
        mockStaleDevClientState();
        vi.mocked(resolveStartPlanAsync).mockResolvedValueOnce(installPlan);

        await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).rejects.toMatchObject({
          code: 'DEV_SERVER_STARTING',
          exitCode: 20,
        });
        expect(runExpoAsync).not.toHaveBeenCalled();
        expect(spawnExpoAsync).not.toHaveBeenCalled();
        expect(runDevServerAsync).not.toHaveBeenCalled();
      });

      it(`should list no steps under --plan, and say the run stops`, async () => {
        mockStaleDevClientState();
        vi.mocked(resolveStartPlanAsync).mockResolvedValueOnce(installPlan);

        await expect(devAsync(projectRoot, resolveDevOptions(['--ios', '--plan']))).resolves.toBe(
          0
        );

        const [plan] = vi.mocked(emitStartPlan).mock.calls[0]!;
        expect(plan.steps).toEqual([]);
        expect(plan.devServerPort).toEqual({ port: 8190, movedFrom: null, state: 'starting' });
        expect(plan.reasons).toContain(
          'The dev server is starting on port 8190; this run stops. Run again once it answers, and it is reused.'
        );
        expect(runExpoAsync).not.toHaveBeenCalled();
      });

      // A plan that ends in `run:*` drops a forwarded `--clear`, and the stop empties its steps.
      it(`should print a stop's plan with a dropped option under --plan`, async () => {
        mockStaleDevClientState();

        await expect(
          devAsync(projectRoot, resolveDevOptions(['--ios', '--plan', '--clear']))
        ).resolves.toBe(0);

        const [plan] = vi.mocked(emitStartPlan).mock.calls[0]!;
        expect(plan.steps).toEqual([]);
        expect(plan.devServerPort).toEqual({ port: 8190, movedFrom: null, state: 'starting' });
        expect(plan.reasons).toContain(
          'The dev server is starting on port 8190; this run stops. Run again once it answers, and it is reused.'
        );
      });
    });

    describe(`with the lock's port answering for another project`, () => {
      beforeEach(() => {
        vi.mocked(readDevServerLockAsync).mockResolvedValue(ownLock);
        vi.mocked(probeBundlerAsync).mockResolvedValue(answersForeign);
      });

      it(`should stop with an outcome and start nothing`, async () => {
        mockProjectState();

        const error = await devAsync(projectRoot, resolveDevOptions(['--ios'])).then(
          () => null,
          (thrown) => thrown
        );

        expect(error).toMatchObject({
          code: 'DEV_SERVER_PORT_FOREIGN',
          exitCode: 20,
          message: expect.stringContaining(
            "This project's dev server lock names port 8190, but the server answering there reports another project root (/other-project), so nothing was started."
          ),
        });
        expect(error.message).not.toContain('--force');
        // The port may be mid-retry, so the caller's own command comes before `dev:stop`.
        expect(error.message).toContain('How: run "npx @expo/agent-cli dev --ios" again');
        expect(error.suggestedCommand).toBe('npx @expo/agent-cli dev --ios');
        expect(runDevServerAsync).not.toHaveBeenCalled();
        expect(runExpoAsync).not.toHaveBeenCalled();
      });

      it(`should say the run stops under --plan`, async () => {
        mockProjectState();

        await expect(devAsync(projectRoot, resolveDevOptions(['--ios', '--plan']))).resolves.toBe(
          0
        );

        const [plan] = vi.mocked(emitStartPlan).mock.calls[0]!;
        expect(plan.steps).toEqual([]);
        expect(plan.devServerPort).toEqual({ port: 8190, movedFrom: null, state: 'foreign' });
        expect(plan.reasons).toContain(
          'The dev server lock names port 8190, but the server there reports another project root (/other-project); the run stops instead of starting another.'
        );
        expect(runDevServerAsync).not.toHaveBeenCalled();
      });
    });

    it(`should not warn about the platform flag the plan already acted on`, async () => {
      mockStaleDevClientState();

      await devAsync(projectRoot, resolveDevOptions(['--ios']));

      expect(Log.warn).not.toHaveBeenCalled();
    });
  });

  // There is no default platform any more: the resolver requires the flag, and the refusal is
  // tested with it (`./resolveOptions-test.ts`). What is still this command's to prove is that the
  // flag it was given is the platform the plan acts on, which the tests above do per rule.
  describe('the platform the caller named', () => {
    it(`should build for the named platform, not the host's`, async () => {
      mockPlatform('darwin');
      mockStaleDevClientState();

      await devAsync(projectRoot, resolveDevOptions(['--android']));

      expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['prebuild', '--platform', 'android']);
      expect(runDevServerAsync).toHaveBeenCalledWith(
        projectRoot,
        ['run:android', '--port', '8081'],
        {
          agentSkills: true,
          output: 'inherit',
          oneDevServer: expect.any(Object),
        }
      );
    });
  });

  // @ref llp/0009-smart-followups.rfc.md §Examples per command
  describe('follow-ups', () => {
    it(`should offer to run the plan --plan just printed`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--plan', '--ios']));

      expect(emittedFollowUpIds()).toEqual(['dev']);
      expect(Log.log).toHaveBeenCalledWith(expect.stringContaining('npx @expo/agent-cli dev'));
    });

    it(`should explain the build a stale plan includes`, async () => {
      mockStaleDevClientState();

      await devAsync(projectRoot, resolveDevOptions(['--plan', '--ios']));

      expect(emittedFollowUpIds()).toEqual(['dev', 'build-freshness', 'project-context']);
    });

    // The open step comes first: a dev server serves a bundle and opens nothing, which is the one
    // gap an agent could not close from inside this CLI.
    it(`should offer the open, device and runtime steps once the plan runs`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--ios']));

      expect(emittedFollowUpIds()).toEqual(['open-app', 'real-device', 'runtime-errors']);
      expect(emittedFollowUps()[0]!.command).toBe('npx @expo/agent-cli navigate /');
      expect(emittedFollowUps()[1]!.command).toBe('exp://192.168.1.5:8081');
    });

    // @ref llp/0009-smart-followups.rfc.md §Examples per command — the web ladder.
    it(`should lead a web run with the site URL and the check that proves it compiles`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--web', '--port', '8134']));

      expect(emittedFollowUpIds()).toEqual(['web-url', 'web-typecheck', 'deploy-web']);
      expect(emittedFollowUps()[0]!.command).toBe('http://localhost:8134');
    });

    it(`should read the port the dev server was asked for`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--ios', '--port', '8082']));

      expect(emittedFollowUps()[1]!.command).toBe('exp://192.168.1.5:8082');
    });

    it(`should offer a tunnel for a development build, which needs no exp:// URL`, async () => {
      vi.mocked(readLastBuildRecord).mockReturnValue({
        ios: { hash: fingerprintHash, sources: null },
      });
      mockStaleDevClientState();

      await devAsync(projectRoot, resolveDevOptions(['--ios']));

      expect(emittedFollowUpIds()).toContain('real-device-tunnel');
    });

    it(`should leave out the device hint for the web target`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--web']));

      expect(emittedFollowUpIds()).not.toContain('open-app');
      expect(emittedFollowUps().some((followup) => followup.command.startsWith('exp://'))).toBe(
        false
      );
    });

    it(`should offer nothing with --no-followups, and print no Next section`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--ios', '--no-followups']));

      expect(emittedFollowUps()).toEqual([]);
      expect(Log.log).not.toHaveBeenCalled();
    });

    it(`should suppress the follow-ups of --plan too`, async () => {
      mockStaleDevClientState();

      await devAsync(projectRoot, resolveDevOptions(['--plan', '--ios', '--no-followups']));

      expect(emittedFollowUps()).toEqual([]);
    });

    it(`should keep --no-followups out of the expo start arguments`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--ios', '--no-followups']));

      expect(runDevServerAsync).toHaveBeenCalledWith(
        projectRoot,
        ['start', '--go', '--port', '8081'],
        {
          agentSkills: true,
          output: 'inherit',
          oneDevServer: expect.any(Object),
          onDevServer: expect.any(Function),
        }
      );
    });

    it(`should never offer more than three follow-ups`, async () => {
      mockStaleDevClientState();

      await devAsync(projectRoot, resolveDevOptions(['--plan', '--ios']));

      expect(emittedFollowUps().length).toBeLessThanOrEqual(3);
    });
  });

  // @ref llp/0010-agent-conventions.rfc.md §The `--json` error envelope, §Needs-human protocol
  // The run nobody is watching. `@expo/agent-cli dev` is the documented non-interactive entry point,
  // and on a busy port it used to start nothing, print unparseable stdout, and tell its caller to
  // open another project's app [observed — friction run, 2026-08-23].
  describe('a run with no terminal', () => {
    /** The non-interactive stop of the Expo CLI on a question only a person can answer. */
    const NEEDS_INPUT = [
      "Input is required, but 'npx expo' is in non-interactive mode.",
      'Required input:',
      '> Which development build would you like to use?',
    ].join('\n');

    /** The same stop, on the one question a machine can answer for itself: a busy port. */
    const PORT_TAKEN = [
      'Port 8180 is running node in another window',
      "Input is required, but 'npx expo' is in non-interactive mode.",
      'Required input:',
      '> Use port 8181 instead?',
    ].join('\n');

    beforeEach(() => {
      vi.mocked(isInteractive).mockReturnValue(false);
    });

    it(`should keep what the steps print, so a stop on a question can be recognised`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--ios']));

      expect(runDevServerAsync).toHaveBeenCalledWith(
        projectRoot,
        ['start', '--go', '--port', '8081'],
        {
          agentSkills: true,
          output: 'tee',
          oneDevServer: expect.any(Object),
          onDevServer: expect.any(Function),
        }
      );
    });

    it(`should print nothing on stdout before the run in --json mode`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--ios', '--json']));

      expect(emitStartPlan).toHaveBeenCalledWith(expect.objectContaining({ rule: 'expo-go' }), {
        mode: 'smart',
        print: 'none',
        followups: [],
      });
      expect(runDevServerAsync).toHaveBeenCalledWith(
        projectRoot,
        ['start', '--go', '--port', '8081'],
        {
          agentSkills: true,
          output: 'capture',
          oneDevServer: expect.any(Object),
          onDevServer: expect.any(Function),
        }
      );
    });

    it(`should print exactly one JSON object, when the run has ended`, async () => {
      mockProjectState();
      vi.mocked(runDevServerAsync).mockResolvedValue(
        devServerRun({ port: { port: 8082, source: 'log' } })
      );

      await devAsync(projectRoot, resolveDevOptions(['--ios', '--json']));

      const printed = vi.mocked(Log.log).mock.calls.map(([line]) => line);
      expect(printed).toHaveLength(1);
      expect(JSON.parse(printed[0]!)).toMatchObject({ rule: 'expo-go', target: 'expo-go' });
    });

    // Exit 7 is the definition of this stop: no re-run of the same command gets past a question.
    it(`should hand a stop on a question back to a person`, async () => {
      mockProjectState();
      vi.mocked(runDevServerAsync).mockResolvedValue(
        devServerRun({ exitCode: 1, stderr: NEEDS_INPUT })
      );

      await expect(
        devAsync(projectRoot, resolveDevOptions(['--ios', '--json']))
      ).rejects.toMatchObject({
        isNeedsHuman: true,
        exitCode: 7,
        needsHuman: { scenario: 'expo-prompt', detectedBy: 'exit-signature' },
      });
    });

    // @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol — the port carve-out (F41).
    // A busy port used to be exit 7 with a `How:` line naming the flag the caller had passed.
    // Picking a free port is mechanical, so nobody is asked.
    it(`should retry on a free port it picks, when the caller named none`, async () => {
      mockProjectState();
      vi.mocked(resolvePlannedPortAsync).mockResolvedValueOnce({
        port: 8180,
        movedFrom: null,
        bindable: true,
      });
      vi.mocked(runDevServerAsync)
        .mockResolvedValueOnce(devServerRun({ exitCode: 1, stderr: PORT_TAKEN }))
        .mockResolvedValue(devServerRun({ exitCode: 0 }));

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      const [, firstArgs] = vi.mocked(runDevServerAsync).mock.calls[0]!;
      const [, retryArgs] = vi.mocked(runDevServerAsync).mock.calls[1]!;
      expect(firstArgs).toEqual(['start', '--go', '--port', '8180']);
      expect(retryArgs.slice(0, 3)).toEqual(['start', '--go', '--port']);
      expect(retryArgs.filter((arg) => arg === '--port')).toHaveLength(1);
      expect(Number(retryArgs.at(-1))).toBeGreaterThan(8180);
      // It says so, on stderr, because the dev server is not where the caller asked for it.
      expect(
        vi
          .mocked(Log.warn)
          .mock.calls.map(([line]) => line)
          .join('\n')
      ).toContain('Port 8180 was taken before the dev server bound it');
    });

    // The retry's port goes before `--`: `expo start` forwards what follows to something else.
    it(`should put the retry's port before the separator, replacing the one there`, async () => {
      mockProjectState();
      vi.mocked(resolvePlannedPortAsync).mockResolvedValueOnce({
        port: 8180,
        movedFrom: null,
        bindable: true,
      });
      vi.mocked(runDevServerAsync)
        .mockResolvedValueOnce(devServerRun({ exitCode: 1, stderr: PORT_TAKEN }))
        .mockResolvedValue(devServerRun({ exitCode: 0 }));

      await expect(
        devAsync(projectRoot, resolveDevOptions(['--ios', '--', '--port', '9000']))
      ).resolves.toBe(0);

      const [, retryArgs] = vi.mocked(runDevServerAsync).mock.calls[1]!;
      const separator = retryArgs.indexOf('--');
      expect(retryArgs.indexOf('--port')).toBeLessThan(separator);
      expect(retryArgs.slice(separator)).toEqual(['--', '--port', '9000']);
    });

    // A `run:*` step's output carries other listeners' errors; one about another port is not this
    // step's collision, and the step that ran on 8081 succeeded.
    it(`should not retry a step whose output names a collision on another port`, async () => {
      mockProjectState();
      vi.mocked(runDevServerAsync).mockResolvedValue(
        devServerRun({
          exitCode: 0,
          stdout: 'Error: listen EADDRINUSE: address already in use :::3000',
        })
      );

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      expect(runDevServerAsync).toHaveBeenCalledTimes(1);
    });

    // What `expo run:*` printed when another project's Metro held 8081, before it built, installed,
    // deep-linked the app to that Metro, and exited 0 [observed — live suite, 2026-10-05].
    it(`should retry a run:* step that skipped its dev server and exited 0`, async () => {
      mockStaleDevClientState();
      vi.mocked(runDevServerAsync)
        .mockResolvedValueOnce(
          devServerRun({
            exitCode: 0,
            stdout: [
              '› Port 8081 is being used by another process',
              "Input is required, but 'npx expo' is in non-interactive mode.",
              '› Use port 8082 instead?',
              '› Skipping dev server',
            ].join('\n'),
          })
        )
        .mockResolvedValue(devServerRun({ exitCode: 0 }));

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      expect(vi.mocked(runDevServerAsync).mock.calls.map(([, args]) => args)).toEqual([
        ['run:ios', '--port', '8081'],
        ['run:ios', '--port', expect.stringMatching(/^\d+$/)],
      ]);
      expect(vi.mocked(runDevServerAsync).mock.calls[1]![1].at(-1)).not.toBe('8081');
      expect(
        vi
          .mocked(Log.warn)
          .mock.calls.map(([line]) => line)
          .join('\n')
      ).toContain('Port 8081 was taken before the dev server bound it');
    });

    it(`should fail the plan when the retry skipped its dev server too`, async () => {
      mockStaleDevClientState();
      vi.mocked(runDevServerAsync).mockImplementation(async (_root, args) => {
        const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 8081;
        return devServerRun({
          exitCode: 0,
          stdout: [
            `› Port ${port} is being used by another process`,
            "Input is required, but 'npx expo' is in non-interactive mode.",
            `› Use port ${port + 1} instead?`,
            '› Skipping dev server',
          ].join('\n'),
        });
      });

      const error = await devAsync(projectRoot, resolveDevOptions(['--ios', '--json'])).then(
        () => null,
        (thrown) => thrown
      );

      expect(error).toMatchObject({ code: 'PORT_TAKEN_AFTER_RETRY', exitCode: 20 });
      const retryPort = Number(vi.mocked(runDevServerAsync).mock.calls[1]![1].at(-1));
      expect(error.message).toContain('exited 0');
      expect(error.message).toContain('asked for port 8081');
      expect(error.message).toContain(`moved it to port ${retryPort}, which a process`);
      // The port the retry lost is the one probed for its holder.
      expect(findPortListenerAsync).toHaveBeenLastCalledWith(retryPort);
      expect(error.message).toMatch(
        /How: start on a free port with ".* dev --ios --json --port \d+"\./
      );
      expect(error.message).not.toContain('dev:stop');
      expect(error.suggestedCommand).toMatch(/ dev --ios --json --port \d+$/);
      expect(error.message).not.toContain("CLI's own");
      expect(runDevServerAsync).toHaveBeenCalledTimes(2);
      expect(Log.log).not.toHaveBeenCalled();
    });

    // The suggestion is the caller's own command line with a free port: an `--eas` run that is
    // told to run without `--eas` would plan a different build.
    it(`should suggest the caller's own command with a free port`, async () => {
      mockProjectState();
      vi.mocked(runDevServerAsync).mockImplementation(async (_root, args) => {
        const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 8081;
        return devServerRun({
          exitCode: 1,
          stderr: PORT_TAKEN.replace(/Port \d+/, `Port ${port}`),
        });
      });

      const error = await devAsync(
        projectRoot,
        resolveDevOptions(['--ios', '--clear', '--tunnel', '--json', '--', '--max-workers', '2'])
      ).then(
        () => null,
        (thrown) => thrown
      );

      expect(error.suggestedCommand).toMatch(
        / dev --ios --clear --tunnel --json --port \d+ -- --max-workers 2$/
      );
    });

    // No free port to move to: `dev:stop --force` only when the holder answers as an Expo dev
    // server and its process looks like one, because that is when the command acts.
    it(`should suggest the forced stop when no port is free and a dev server holds it`, async () => {
      mockProjectState();
      vi.mocked(findFreePortAsync).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      vi.mocked(findPortListenerAsync).mockResolvedValueOnce({ pid: 4242, command: 'node' });
      vi.mocked(isExpoDevServerAsync).mockResolvedValueOnce(true);
      vi.mocked(runDevServerAsync).mockResolvedValue(
        devServerRun({ exitCode: 1, stderr: PORT_TAKEN.replace(/Port \d+/, 'Port 8081') })
      );

      const error = await devAsync(projectRoot, resolveDevOptions(['--ios', '--json'])).then(
        () => null,
        (thrown) => thrown
      );

      expect(error).toMatchObject({ code: 'PORT_TAKEN_AFTER_RETRY', exitCode: 20 });
      expect(error.message).toContain(
        'Why: pid 4242 (node) holds port 8081, and no free port was found to retry on.'
      );
      expect(error.suggestedCommand).toMatch(/ dev:stop --port 8081 --force$/);
      expect(runDevServerAsync).toHaveBeenCalledTimes(1);
    });

    it(`should name the holder and suggest nothing when no port is free and it is not a dev server`, async () => {
      mockProjectState();
      vi.mocked(findFreePortAsync).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      vi.mocked(findPortListenerAsync).mockResolvedValueOnce({ pid: 4242, command: 'python3' });
      vi.mocked(runDevServerAsync).mockResolvedValue(
        devServerRun({ exitCode: 1, stderr: PORT_TAKEN.replace(/Port \d+/, 'Port 8081') })
      );

      const error = await devAsync(projectRoot, resolveDevOptions(['--ios', '--json'])).then(
        () => null,
        (thrown) => thrown
      );

      expect(error.message).toContain('How: stop pid 4242 (python3) on port 8081 yourself');
      expect(error.message).not.toContain('dev:stop');
      expect(error.suggestedCommand).toBeUndefined();
    });

    // `expo start` that stopped on the busy port exits 1: the same stop, with its own code named.
    it(`should fail the plan the same way when the retry exited non-zero`, async () => {
      mockProjectState();
      vi.mocked(runDevServerAsync).mockImplementation(async (_root, args) => {
        const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 8081;
        return devServerRun({
          exitCode: 1,
          stderr: PORT_TAKEN.replace(/Port \d+/, `Port ${port}`),
        });
      });

      const error = await devAsync(projectRoot, resolveDevOptions(['--ios', '--json'])).then(
        () => null,
        (thrown) => thrown
      );

      expect(error).toMatchObject({ code: 'PORT_TAKEN_AFTER_RETRY', exitCode: 20 });
      expect(error.isNeedsHuman).toBeUndefined();
      expect(error.message).toContain('exited 1');
      expect(runDevServerAsync).toHaveBeenCalledTimes(2);
    });

    // `expo run:*` that found this project's own dev server on the port reuses it: a bare skip.
    it(`should not retry a run:* step that reused this project's dev server`, async () => {
      mockStaleDevClientState();
      vi.mocked(runDevServerAsync).mockResolvedValue(
        devServerRun({
          exitCode: 0,
          stdout: ['› Skipping dev server', '› Build Succeeded'].join('\n'),
        })
      );

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      expect(runDevServerAsync).toHaveBeenCalledTimes(1);
    });

    // A Metro that logged `metro:instantiate` bound its port; its output is not a bind failure.
    it(`should not retry a dev server that reported its port`, async () => {
      mockProjectState();
      vi.mocked(runDevServerAsync).mockResolvedValue(
        devServerRun({
          exitCode: 0,
          stdout: 'Error: listen EADDRINUSE: address already in use :::9229',
          port: { port: 8081, source: 'log' },
        })
      );

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      expect(runDevServerAsync).toHaveBeenCalledTimes(1);
    });

    // The port watch stops before a long `run:*` build reaches Metro, so the step's port source is
    // `arg`; the log the dev server wrote after the spawn is what says it bound its port.
    it(`should not retry a run:* step whose dev server logged its port after the spawn`, async () => {
      mockStaleDevClientState();
      vi.mocked(runDevServerAsync).mockImplementation(async () => {
        vol.fromJSON({
          [path.join(projectRoot, '.expo', 'dev', 'logs', 'start.log')]: JSON.stringify({
            _e: 'metro:instantiate',
            _t: Date.now(),
            port: 8081,
          }),
        });
        return devServerRun({
          exitCode: 0,
          stdout: 'Error: listen EADDRINUSE: address already in use :::9229',
          port: { port: 8081, source: 'arg' },
        });
      });

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      expect(runDevServerAsync).toHaveBeenCalledTimes(1);
    });

    it(`should report the port the retry moved the dev server to`, async () => {
      mockProjectState();
      vi.mocked(resolvePlannedPortAsync).mockResolvedValueOnce({
        port: 8180,
        movedFrom: null,
        bindable: true,
      });
      vi.mocked(runDevServerAsync)
        .mockResolvedValueOnce(devServerRun({ exitCode: 1, stderr: PORT_TAKEN }))
        .mockImplementation(async (_root, args) =>
          devServerRun({ exitCode: 0, port: { port: Number(args.at(-1)), source: 'arg' } })
        );

      await devAsync(projectRoot, resolveDevOptions(['--ios', '--json']));

      const retryPort = Number(vi.mocked(runDevServerAsync).mock.calls[1]![1].at(-1));
      const printed = JSON.parse(vi.mocked(Log.log).mock.calls[0]![0] as string);
      expect(printed.devServerPort).toEqual({ port: retryPort, movedFrom: 8180, state: 'picked' });
      expect(printed.steps.at(-1).argv).toEqual([
        'expo',
        'start',
        '--go',
        '--port',
        String(retryPort),
      ]);
    });

    it(`should refuse a named port that is taken before any step runs`, async () => {
      mockStaleDevClientState();
      vi.mocked(resolvePlannedPortAsync).mockResolvedValueOnce({
        port: 8180,
        movedFrom: null,
        bindable: false,
      });

      await expect(
        devAsync(projectRoot, resolveDevOptions(['--ios', '--port', '8180']))
      ).rejects.toMatchObject({ code: 'PORT_IN_USE', exitCode: 20 });
      expect(runExpoAsync).not.toHaveBeenCalled();
      expect(runDevServerAsync).not.toHaveBeenCalled();
    });

    // A port the caller named is a requirement: moving would leave every URL they had already
    // printed pointing at nothing. Exit 20 — the outcome failed — and never exit 7.
    it(`should report an outcome, not a person, when the caller demanded the port`, async () => {
      mockProjectState();
      vi.mocked(runDevServerAsync).mockResolvedValue(
        devServerRun({ exitCode: 1, stderr: PORT_TAKEN })
      );

      const error = await devAsync(
        projectRoot,
        resolveDevOptions(['--ios', '--port', '8180'])
      ).then(
        () => null,
        (thrown) => thrown
      );

      expect(error).toMatchObject({ code: 'PORT_IN_USE', exitCode: 20 });
      expect(error.isNeedsHuman).toBeUndefined();
      // Never the command that just failed.
      expect(error.suggestedCommand).not.toContain('--port 8180');
      // Started once, and not retried somewhere else.
      expect(runDevServerAsync).toHaveBeenCalledTimes(1);
    });

    // @ref llp/0010-agent-conventions.rfc.md §The `--json` error envelope
    // The plan object described what the run *meant* to do, so printing it after a step failed
    // told a driving agent that a dev server was up when none was, with only the exit code
    // disagreeing [observed — friction run 2, 2026-08-23].
    it(`should report a failed step as a failure, keeping the subprocess's own code`, async () => {
      mockProjectState();
      vi.mocked(runDevServerAsync).mockResolvedValue(devServerRun({ exitCode: 3 }));

      await expect(
        devAsync(projectRoot, resolveDevOptions(['--ios', '--json']))
      ).rejects.toMatchObject({
        code: 'PLAN_STEP_FAILED',
        exitCode: 3,
      });
      // Nothing reached stdout, so the launcher's envelope is the only object there.
      expect(Log.log).not.toHaveBeenCalled();
    });

    it(`should quote what a captured step printed, which nothing else would show`, async () => {
      mockProjectState();
      vi.mocked(runDevServerAsync).mockResolvedValue(
        devServerRun({ exitCode: 3, stderr: 'EADDRINUSE 8081\n' })
      );

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios', '--json']))).rejects.toThrow(
        /What the tool printed:\nEADDRINUSE 8081/
      );
    });

    // In `tee` mode the same bytes already reached the terminal as they arrived.
    it(`should not repeat output a person has already seen`, async () => {
      mockProjectState();
      vi.mocked(runDevServerAsync).mockResolvedValue(
        devServerRun({ exitCode: 3, stderr: 'EADDRINUSE 8081\n' })
      );

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).rejects.not.toThrow(
        /What the tool printed/
      );
    });

    // @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol
    // `expo start --ios` drives Simulator.app through AppleScript. On a Mac that has granted no
    // Automation permission the rejection is unhandled and ends the whole process, dev server
    // included — and Node leaves with 7, which is this CLI's own needs-human code, so the run used
    // to exit 7 carrying a success-shaped plan and no diagnostics at all.
    it(`should hand a refused Automation permission back to a person`, async () => {
      mockProjectState();
      vi.mocked(runDevServerAsync).mockResolvedValue(
        devServerRun({
          exitCode: 7,
          stderr:
            'Error: osascript -e tell app "System Events" to count processes whose name is "Simulator" exited with non-zero code: 1',
        })
      );

      const error = await devAsync(projectRoot, resolveDevOptions(['--json', '--ios']))
        .then(() => null)
        .catch((thrown) => thrown);

      expect(error).toMatchObject({
        isNeedsHuman: true,
        code: 'MACOS_AUTOMATION_REQUIRED',
        exitCode: 7,
        needsHuman: { scenario: 'macos-automation', detectedBy: 'exit-signature' },
      });
      // What actually happened: the process exited, so the dev server it started is gone.
      expect(error.message).toMatch(/nothing is listening for this project now/);
      // The route that needs no Automation grant: the build is recorded, so the re-run starts
      // the dev server and performs the open itself, through simctl.
      expect(error.message).toMatch(/npx @expo\/agent-cli dev --ios --detach/);
      expect(error.message).toMatch(/simctl openurl/);
      expect(Log.log).not.toHaveBeenCalled();
    });

    describe('the follow-ups of a run', () => {
      it(`should name the port the dev server reported, not the one it was not given`, async () => {
        mockProjectState();
        vi.mocked(runDevServerAsync).mockResolvedValue(
          devServerRun({ port: { port: 8099, source: 'log' } })
        );

        await devAsync(projectRoot, resolveDevOptions(['--ios', '--json']));

        // The open-app step sits first in the ladder; the URL follow-up carries the reported port.
        const commands = emittedFollowUps().map((followup) => followup.command);
        expect(commands).toContain('exp://192.168.1.5:8099');
        expect(commands).not.toContain('exp://192.168.1.5:8081');
      });

      // The bug this exists for: nothing reported a port, so the URL was built on the assumption
      // that 8081 was free — and it was another project's dev server.
      it(`should name no URL when nothing reported a port`, async () => {
        mockProjectState();
        vi.mocked(runDevServerAsync).mockResolvedValue(
          devServerRun({ exitCode: 0, port: { port: 8081, source: 'default' } })
        );

        await devAsync(projectRoot, resolveDevOptions(['--ios', '--json']));

        expect(emittedFollowUpIds()).toContain('dev-server-port-unknown');
        expect(emittedFollowUps().map((followup) => followup.command)).not.toContain(
          'exp://192.168.1.5:8081'
        );
      });
    });
  });
});
