import { vol } from 'memfs';
import os from 'os';

import type { FollowUp } from '../../followups';
import { Log } from '../../log';
import { emitStartPlan } from '../../plan/emit';
import { readLastBuildFingerprints, recordLastBuildFingerprint } from '../../plan/lastBuild';
import { clearFingerprintMemo } from '../../project/fingerprint';
import { clearFingerprintCache } from '../../project/fingerprintCache';
import { probeProjectStateAsync } from '../../project/probe';
import type { ProjectState } from '../../project/types';
import { runDevServerAsync, type DevServerRun } from '../../start/startAsync';
import { runExpoAsync, spawnExpoAsync } from '../../utils/expoCli';
import { isInteractive } from '../../utils/interactive';
import { devAsync } from '../devAsync';
import { hasPlanConsent } from '../planConsent';
import { resolveDevOptions } from '../resolveOptions';

vi.mock('../../log');
vi.mock('../planConsent', () => ({ hasPlanConsent: vi.fn() }));
vi.mock('../../plan/emit', () => ({ emitStartPlan: vi.fn() }));
vi.mock('../../plan/events', () => ({ event: vi.fn(), debugEvent: vi.fn() }));
vi.mock('../../plan/lastBuild', () => ({
  readLastBuildFingerprints: vi.fn(() => ({})),
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
  mockReported.length = 0;
  vi.mocked(readLastBuildFingerprints).mockReturnValue({});
  vi.mocked(runExpoAsync).mockResolvedValue(0);
  vi.mocked(isInteractive).mockReturnValue(true);
  vi.mocked(spawnExpoAsync).mockResolvedValue({
    cli: { command: 'expo', args: [] },
    result: { exitCode: 0, stdout: '', stderr: '' },
  });
  vi.mocked(runDevServerAsync).mockResolvedValue(devServerRun());
  vi.mocked(hasPlanConsent).mockReturnValue(true);
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
      expect(runDevServerAsync).toHaveBeenCalledWith(projectRoot, ['start', '--go', '--ios'], {
        agentSkills: true,
        output: 'inherit',
      });
    });

    it(`should run every step of a plan that builds`, async () => {
      mockStaleDevClientState();

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['prebuild', '--platform', 'ios']);
      expect(runDevServerAsync).toHaveBeenCalledWith(projectRoot, ['run:ios'], {
        agentSkills: true,
        output: 'inherit',
      });
    });
  });

  // @ref llp/0008-guardrails.rfc.md §Consent is a re-run, never a prompt
  describe('consent', () => {
    it(`should check the plan for consent before anything runs`, async () => {
      mockStaleDevClientState();

      await devAsync(projectRoot, resolveDevOptions(['--ios']));

      expect(hasPlanConsent).toHaveBeenCalledWith(
        expect.objectContaining({ rule: 'dev-client-stale' }),
        expect.objectContaining({ mode: 'run' })
      );
    });

    it(`should run nothing and exit 0 when the plan has no consent`, async () => {
      mockStaleDevClientState();
      vi.mocked(hasPlanConsent).mockReturnValue(false);

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      expect(runExpoAsync).not.toHaveBeenCalled();
      expect(runDevServerAsync).not.toHaveBeenCalled();
    });

    it(`should never check in --plan mode, which runs nothing anyway`, async () => {
      mockStaleDevClientState();

      await devAsync(projectRoot, resolveDevOptions(['--plan', '--ios']));

      expect(hasPlanConsent).not.toHaveBeenCalled();
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
        ['start', '--go', '--ios', '--port', '8082'],
        { agentSkills: true, output: 'inherit' }
      );
      expect(runExpoAsync).not.toHaveBeenCalled();
    });

    it(`should keep the skill sync opt-out`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--ios', '--no-agent-skills']));

      expect(runDevServerAsync).toHaveBeenCalledWith(projectRoot, ['start', '--go', '--ios'], {
        agentSkills: false,
        output: 'inherit',
      });
    });

    it(`should not repeat a platform flag the plan already passes`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--web']));

      expect(runDevServerAsync).toHaveBeenCalledWith(projectRoot, ['start', '--web'], {
        agentSkills: true,
        output: 'inherit',
      });
    });

    // `--no-open`: the platform decides the plan and never reaches `expo start`, whose `--ios`
    // form opens the app — the one step a caller that opens the app itself said not to run.
    it(`should keep the platform away from expo start under --no-open`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--ios', '--no-open']));

      expect(runDevServerAsync).toHaveBeenCalledWith(projectRoot, ['start', '--go'], {
        agentSkills: true,
        output: 'inherit',
      });
    });

    it(`should run every step in order, ending with the dev server`, async () => {
      mockStaleDevClientState();

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      expect(runExpoAsync).toHaveBeenCalledTimes(1);
      expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['prebuild', '--platform', 'ios']);
      expect(runDevServerAsync).toHaveBeenCalledWith(projectRoot, ['run:ios'], {
        agentSkills: true,
        output: 'inherit',
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
      // handoff is thrown — its own `How:` sends the reader to `npx @expo/agent-cli dev --yes`, which used
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
      vi.mocked(readLastBuildFingerprints).mockReturnValue({ ios: fingerprintHash });

      await devAsync(projectRoot, resolveDevOptions(['--ios']));

      expect(emitStartPlan).toHaveBeenCalledWith(
        expect.objectContaining({ rule: 'dev-client-fresh' }),
        { mode: 'smart', print: 'text', followups: [] }
      );
      expect(runExpoAsync).not.toHaveBeenCalled();
      // `--ios` is an `expo start` option, so it reaches the dev server it asked for.
      expect(runDevServerAsync).toHaveBeenCalledWith(
        projectRoot,
        ['start', '--dev-client', '--ios'],
        { agentSkills: true, output: 'inherit' }
      );
    });

    it(`should warn that expo start options do not reach a build step`, async () => {
      mockStaleDevClientState();

      await devAsync(projectRoot, resolveDevOptions(['--ios', '--port', '8082']));

      expect(Log.warn).toHaveBeenCalledWith(expect.stringMatching(/--port 8082/));
      expect(runDevServerAsync).toHaveBeenCalledWith(projectRoot, ['run:ios'], {
        agentSkills: true,
        output: 'inherit',
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
      expect(runDevServerAsync).toHaveBeenCalledWith(projectRoot, ['run:android'], {
        agentSkills: true,
        output: 'inherit',
      });
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
      vi.mocked(readLastBuildFingerprints).mockReturnValue({ ios: fingerprintHash });
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

      expect(runDevServerAsync).toHaveBeenCalledWith(projectRoot, ['start', '--go', '--ios'], {
        agentSkills: true,
        output: 'inherit',
      });
    });

    it(`should never offer more than three follow-ups`, async () => {
      mockStaleDevClientState();

      await devAsync(projectRoot, resolveDevOptions(['--plan', '--ios']));

      expect(emittedFollowUps().length).toBeLessThanOrEqual(3);
    });
  });

  // @ref llp/0010-agent-conventions.rfc.md §The `--json` error envelope, §Needs-human protocol
  // The run nobody is watching. `@expo/agent-cli dev --yes` is the documented non-interactive entry point,
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

      expect(runDevServerAsync).toHaveBeenCalledWith(projectRoot, ['start', '--go', '--ios'], {
        agentSkills: true,
        output: 'tee',
      });
    });

    it(`should print nothing on stdout before the run in --json mode`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--ios', '--json']));

      expect(emitStartPlan).toHaveBeenCalledWith(expect.objectContaining({ rule: 'expo-go' }), {
        mode: 'smart',
        print: 'none',
        followups: [],
      });
      expect(runDevServerAsync).toHaveBeenCalledWith(projectRoot, ['start', '--go', '--ios'], {
        agentSkills: true,
        output: 'capture',
      });
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
        devAsync(projectRoot, resolveDevOptions(['--ios', '--yes', '--json']))
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
      vi.mocked(runDevServerAsync)
        .mockResolvedValueOnce(devServerRun({ exitCode: 1, stderr: PORT_TAKEN }))
        .mockResolvedValue(devServerRun({ exitCode: 0 }));

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios', '--yes']))).resolves.toBe(0);

      const [, retryArgs] = vi.mocked(runDevServerAsync).mock.calls[1]!;
      expect(retryArgs.slice(0, 2)).toEqual(['start', '--go']);
      expect(retryArgs[retryArgs.length - 2]).toBe('--port');
      // It says so, on stderr, because the dev server is not where the caller asked for it.
      expect(
        vi
          .mocked(Log.warn)
          .mock.calls.map(([line]) => line)
          .join('\n')
      ).toContain('Port 8180 was busy');
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
        resolveDevOptions(['--ios', '--yes', '--port', '8180'])
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

      const error = await devAsync(projectRoot, resolveDevOptions(['--yes', '--json', '--ios']))
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
      // The route that needs no Automation grant, which is the one an agent can take.
      expect(error.message).toMatch(/npx @expo\/agent-cli navigate \//);
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
