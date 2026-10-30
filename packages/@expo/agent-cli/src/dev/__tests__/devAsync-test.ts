// What only a unit test can reach in `devAsync`: a person at a terminal, a host that is not the
// one running the suite, a device binding, an EAS session, and port races the stub `expo` cannot
// stage. Everything a subprocess can show is in `e2e/__tests__/dev-test.ts`, `dev-detach-test.ts`
// and `plan-test.ts`.
import { vol } from 'memfs';

import { acquireDeviceAsync, devicesDisabled, inspectBindingAsync } from '../../deviceBinding';
import { bindingFor, writeBinding } from '../../deviceBinding/__tests__/fakeTools';
import { bindingPathFor, readBindingFile } from '../../deviceBinding/registry';
import { deviceUnavailableError } from '../../deviceBinding/errors';
import { previewExplicitDeviceAsync } from '../../deviceBinding/preview';
import { withLeaseExtendedAsync } from '../../deviceBinding/renew';
import { readDevServerLockAsync } from '../../devLock/client';
import type { DevServerLockInfo } from '../../devLock/types';
import type { FollowUp } from '../../followups';
import { emitStartPlan } from '../../plan/emit';
import { readLastBuildRecord, recordLastBuildFingerprint } from '../../plan/lastBuild';
import { resolveStartPlanAsync } from '../../plan/resolveAsync';
import { probeProjectStateAsync } from '../../project/probe';
import { probeBundlerAsync } from '../../runtime/bundlerStatus';
import type { ProjectState } from '../../project/types';
import { runDevServerAsync, type DevServerRun } from '../../start/startAsync';
import { runExpoAsync, spawnExpoAsync } from '../../utils/expoCli';
import { isInteractive } from '../../utils/interactive';
import { devAsync } from '../devAsync';
import { findFreePortAsync, resolvePlannedPortAsync } from '../portCollision';
import { findPortListenerAsync } from '../portListener';
import { CALLER_ARGV_ENV } from '../deviceOption';
import { resolveDevOptions } from '../resolveOptions';
import { isExpoDevServerAsync } from '../stopAsync';
import { easRunLifecycle } from '../openAppEas';
import { lockInfo } from '../../devLock/__tests__/fakeLock';

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
vi.mock('../../needsHuman/easProject', () => ({ assertEasProjectConfiguredAsync: vi.fn() }));
vi.mock('../openApp', () => ({
  openAppOnDeviceAsync: vi.fn(),
  openAppFailureLine: vi.fn((platform: string, reason: string) => `${platform}: ${reason}`),
}));
vi.mock('../openAppEas', () => ({
  easRunLifecycle: vi.fn(),
}));
vi.mock('../../plan/emit', () => ({ emitStartPlan: vi.fn() }));
vi.mock('../../plan/events', () => ({ event: vi.fn(), debugEvent: vi.fn() }));
vi.mock('../../plan/lastBuild', () => ({
  readLastBuildRecord: vi.fn(() => ({})),
  recordLastBuildFingerprint: vi.fn(),
}));
// The real resolver, watched: a run that stops on the running dev server never reaches it.
vi.mock('../../plan/resolveAsync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../plan/resolveAsync')>();
  return { ...actual, resolveStartPlanAsync: vi.fn(actual.resolveStartPlanAsync) };
});
vi.mock('../../project/probe', () => ({ probeProjectStateAsync: vi.fn() }));
vi.mock('../../utils/expoCli', () => ({ runExpoAsync: vi.fn(), spawnExpoAsync: vi.fn() }));
vi.mock('../../start/startAsync', () => ({ runDevServerAsync: vi.fn() }));
vi.mock('../../deviceBinding/preview', () => ({ previewExplicitDeviceAsync: vi.fn() }));
vi.mock('../../devLock/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../devLock/client')>()),
  readDevServerLockAsync: vi.fn(async () => null),
}));
// The running-server stop probes the lock's URL for its wording; a unit test must not reach one.
vi.mock('../../runtime/bundlerStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../runtime/bundlerStatus')>()),
  probeBundlerAsync: vi.fn(),
}));
vi.mock('../../deviceBinding/renew', () => ({
  withLeaseExtendedAsync: vi.fn((_root: string, work: () => Promise<unknown>) => work()),
}));
// A person at a terminal by default, which no e2e case can be: `spawnAgentCli` pipes stdout.
vi.mock('../../utils/interactive', () => ({ isInteractive: vi.fn(() => true) }));
// @ref llp/0015-backend-selection-and-config.rfc.md §The selection
// A unit test must not depend on whether the machine running it has Xcode or an Android SDK: that
// fact decides which *steps* a building plan contains. The tests that care stub this themselves.
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
// The registry is off by default, as in the e2e harness; the rows about the binding turn it on
// and script what `acquire` answers (llp/0035 §How `dev` uses it).
vi.mock('../../deviceBinding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../deviceBinding')>()),
  devicesDisabled: vi.fn(() => true),
  acquireDeviceAsync: vi.fn(),
  inspectBindingAsync: vi.fn(),
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
// a test reads them.
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
    fingerprint: { hash: 'abc123def4567890' },
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

const notAnswering = { answering: false, projectRootMatched: null, reportedProjectRoot: null };

/** This project's dev server holds its lock on `port`, and its `/status` answers. */
function mockRunning(port = 8081): DevServerLockInfo {
  const lock: DevServerLockInfo = lockInfo({
    url: `http://127.0.0.1:${port}`,
    port,
    pid: 4242,
    startedAt: '2026-10-07T00:00:00.000Z',
    projectRoot,
  });
  vi.mocked(readDevServerLockAsync).mockResolvedValue(lock);
  vi.mocked(probeBundlerAsync).mockResolvedValue({
    answering: true,
    projectRootMatched: true,
    reportedProjectRoot: projectRoot,
  });
  return lock;
}

/** The `expo start` that stopped on a busy port, naming the port it was given. */
function portTakenOn(port: number): DevServerRun {
  return devServerRun({
    exitCode: 1,
    stderr: [
      `Port ${port} is running node in another window`,
      "Input is required, but 'npx expo' is in non-interactive mode.",
      'Required input:',
      `> Use port ${port + 1} instead?`,
    ].join('\n'),
  });
}

/** Every `expo start` is refused on whatever port it was given. */
function mockEveryPortTaken() {
  vi.mocked(runDevServerAsync).mockImplementation(async (_root, args) =>
    portTakenOn(args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 8081)
  );
}

/** The error `devAsync` rejected with. */
async function failureOf(argv: string[]): Promise<any> {
  return await devAsync(projectRoot, resolveDevOptions(argv)).then(
    () => null,
    (thrown) => thrown
  );
}

beforeEach(() => {
  vol.reset();
  mockReported.length = 0;
  vi.mocked(readDevServerLockAsync).mockReset().mockResolvedValue(null);
  vi.mocked(probeBundlerAsync).mockReset().mockResolvedValue(notAnswering);
  vi.mocked(readLastBuildRecord).mockReturnValue({});
  vi.mocked(runExpoAsync).mockResolvedValue(0);
  vi.mocked(isInteractive).mockReturnValue(true);
  vi.mocked(spawnExpoAsync).mockResolvedValue({
    cli: { command: 'expo', args: [] },
    result: { exitCode: 0, stdout: '', stderr: '' },
  });
  vi.mocked(runDevServerAsync).mockResolvedValue(devServerRun());
});

afterEach(() => {
  mockPlatform(realPlatform);
  vi.restoreAllMocks();
});

describe(devAsync, () => {
  // @ref llp/0008-guardrails.rfc.md §The plan is announced, not negotiated — the terminal half of
  // `dev-test.ts` "runs a plan that builds, with no terminal watching it go by".
  describe('in a terminal', () => {
    it(`should run every step of a plan that builds with the terminal's own stdio, asking nothing`, async () => {
      mockStaleDevClientState();

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['prebuild', '--platform', 'ios']);
      expect(spawnExpoAsync).not.toHaveBeenCalled();
      expect(runDevServerAsync).toHaveBeenCalledWith(projectRoot, ['run:ios', '--port', '8081'], {
        agentSkills: true,
        output: 'inherit',
        easPlatform: null,
      });
    });

    it(`should keep the skill sync opt-out`, async () => {
      mockProjectState();

      await devAsync(projectRoot, resolveDevOptions(['--ios', '--no-agent-skills']));

      const [, , opts] = vi.mocked(runDevServerAsync).mock.calls[0]!;
      expect(opts!.agentSkills).toBe(false);
    });

    // @ref llp/0035-one-device-per-worktree.rfc.md §Lease timer
    it(`should renew the worktree's device lease around a build step`, async () => {
      mockStaleDevClientState();

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      expect(withLeaseExtendedAsync).toHaveBeenCalledTimes(1);
      expect(withLeaseExtendedAsync).toHaveBeenCalledWith(projectRoot, expect.any(Function));
    });
  });

  // @ref llp/0026-dev-owns-the-open.rfc.md — the open is this command's own act, hung on the
  // moment the dev server reports where it listens. The e2e harness sets AGENT_CLI_NO_DEVICE.
  describe('the open', () => {
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

    it.each([
      ['under --no-open', ['--ios', '--no-open'], {}],
      ['for the web target, which is served rather than opened', ['--web'], {}],
      [
        'under AGENT_CLI_NO_DEVICE, which a stubbed harness sets',
        ['--ios'],
        { AGENT_CLI_NO_DEVICE: '1' },
      ],
    ])(`should arm nothing %s`, async (_case, argv, env) => {
      mockProjectState();
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      try {
        await devAsync(projectRoot, resolveDevOptions(argv));
      } finally {
        vi.unstubAllEnvs();
      }

      const [, , opts] = vi.mocked(runDevServerAsync).mock.calls[0]!;
      expect(opts!.onDevServer).toBeUndefined();
    });
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — F121. The stub `expo` of
  // the e2e tier fails `run:*` only after an install (STUB_EXPO_RUN_LAUNCH_FAILS), never before
  // one, and never with the Automation refusal; these two shapes stay here.
  describe('a build step that failed', () => {
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

    // Exit 7, because the launch step is `osascript`, and the Automation refusal is a stop only a
    // person can clear. The record is written **before** that handoff is thrown.
    it(`should record the build when the step failed at the launch after installing the app`, async () => {
      mockStaleDevClientState();
      vi.mocked(runDevServerAsync).mockResolvedValue(
        devServerRun({
          exitCode: 1,
          stdout: '› Build Succeeded\n› Installing on iPhone 17 Pro\n› Opening on iPhone 17 Pro',
          stderr: 'Error: osascript -e tell app "System Events" exited with non-zero code: 1',
        })
      );

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).rejects.toMatchObject({
        exitCode: 7,
        message: expect.stringContaining('the app it built is installed on the simulator already'),
      });

      expect(recordLastBuildFingerprint).toHaveBeenCalledWith(projectRoot, 'ios', {
        hash: 'abc123def4567890',
        sources: null,
      });
    });
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port
  // One dev server per project. A run stops on the lock alone, before the project is probed and the
  // plan is resolved, so nothing below the lock read is spent on it: no probe, no resolver, no
  // toolchain, no EAS, no device.
  describe('a dev server this project already runs', () => {
    it.each([
      ['an Expo Go run', ['--ios'], mockProjectState],
      ['a plan that builds, before the toolchain is probed', ['--ios'], mockStaleDevClientState],
      ['a run on EAS, before EAS is asked anything', ['--ios', '--eas'], mockProjectState],
      ['a run that names the running port', ['--ios', '--port', '8081'], mockProjectState],
    ])(`should stop %s before anything is spent`, async (_case, argv, arrange) => {
      arrange();
      mockRunning();

      await expect(devAsync(projectRoot, resolveDevOptions(argv))).rejects.toMatchObject({
        code: 'DEV_SERVER_RUNNING',
      });

      expect(probeProjectStateAsync).not.toHaveBeenCalled();
      expect(resolveStartPlanAsync).not.toHaveBeenCalled();
      expect(resolvePlannedPortAsync).not.toHaveBeenCalled();
      expect(acquireDeviceAsync).not.toHaveBeenCalled();
      expect(runExpoAsync).not.toHaveBeenCalled();
      expect(runDevServerAsync).not.toHaveBeenCalled();
    });

    it(`should suggest a device platform to a --web caller`, async () => {
      mockPlatform('linux');
      mockRunning();

      await expect(devAsync(projectRoot, resolveDevOptions(['--web']))).rejects.toMatchObject({
        suggestedCommand: 'npx @expo/agent-cli smoke --android',
      });
    });
  });

  // @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol — the port carve-out (F41).
  // The stub `expo` frees every port but the busy one, so the e2e tier cannot stage a retry that
  // loses its port too, a machine with no free port, or `run:*` skipping its dev server with exit 0.
  describe('a port taken before the dev server bound it', () => {
    beforeEach(() => {
      vi.mocked(isInteractive).mockReturnValue(false);
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

      const ports = vi.mocked(runDevServerAsync).mock.calls.map(([, args]) => args.at(-1));
      expect(ports).toHaveLength(2);
      expect(ports[0]).toBe('8081');
      expect(ports[1]).not.toBe('8081');
    });

    it.each([
      [
        'a step whose output names a collision on another port',
        devServerRun({ stdout: 'Error: listen EADDRINUSE: address already in use :::3000' }),
        mockProjectState,
      ],
      [
        'a dev server that reported its port',
        devServerRun({
          stdout: 'Error: listen EADDRINUSE: address already in use :::9229',
          port: { port: 8081, source: 'log' },
        }),
        mockProjectState,
      ],
    ])(`should not retry %s`, async (_case, run, arrange) => {
      arrange();
      vi.mocked(runDevServerAsync).mockResolvedValue(run);

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      expect(runDevServerAsync).toHaveBeenCalledTimes(1);
    });

    // The port watch stops before a long `run:*` build reaches Metro, so the step's port source is
    // `arg`; the log the dev server wrote after the spawn is what says it bound its port.
    it(`should not retry a run:* step whose dev server logged its port after the spawn`, async () => {
      mockStaleDevClientState();
      vi.mocked(runDevServerAsync).mockImplementation(async () => {
        vol.fromJSON({
          '/project/.expo/dev/logs/start.log': JSON.stringify({
            _e: 'metro:instantiate',
            _t: Date.now(),
            port: 8081,
          }),
        });
        return devServerRun({
          stdout: 'Error: listen EADDRINUSE: address already in use :::9229',
          port: { port: 8081, source: 'arg' },
        });
      });

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).resolves.toBe(0);

      expect(runDevServerAsync).toHaveBeenCalledTimes(1);
    });

    it(`should fail the plan when the retry skipped its dev server too`, async () => {
      mockStaleDevClientState();
      vi.mocked(runDevServerAsync).mockImplementation(async (_root, args) => {
        const port = Number(args[args.indexOf('--port') + 1]);
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

      const error = await failureOf(['--ios', '--json']);

      expect(error).toMatchObject({ code: 'PORT_TAKEN_AFTER_RETRY', exitCode: 20 });
      const retryPort = Number(vi.mocked(runDevServerAsync).mock.calls[1]![1].at(-1));
      expect(error.message).toContain('exited 0');
      expect(error.message).toContain('asked for port 8081');
      expect(error.message).toContain(`moved it to port ${retryPort}, which a process`);
      // The port the retry lost is the one probed for its holder.
      expect(findPortListenerAsync).toHaveBeenLastCalledWith(retryPort);
      expect(error.message).toMatch(
        /How: start on a free port with ".* dev --ios --json --port \d+ --detach --wait-ready"\./
      );
      expect(error.message).not.toContain('dev:stop');
      expect(error.message).not.toContain("CLI's own");
      expect(runDevServerAsync).toHaveBeenCalledTimes(2);
    });

    // `expo start` that stopped on the busy port exits 1: the same stop, with its own code named.
    it(`should fail the plan the same way when the retry exited non-zero`, async () => {
      mockProjectState();
      mockEveryPortTaken();

      const error = await failureOf(['--ios', '--json']);

      expect(error).toMatchObject({ code: 'PORT_TAKEN_AFTER_RETRY', exitCode: 20 });
      expect(error.isNeedsHuman).toBeUndefined();
      expect(error.message).toContain('exited 1');
      expect(runDevServerAsync).toHaveBeenCalledTimes(2);
    });

    // The suggestion is the caller's own command line with a free port: an `--eas` run that is
    // told to run without `--eas` would plan a different build.
    it(`should suggest the caller's own command with a free port`, async () => {
      mockProjectState();
      mockEveryPortTaken();

      const error = await failureOf([
        '--ios',
        '--clear',
        '--tunnel',
        '--json',
        '--',
        '--max-workers',
        '2',
      ]);

      expect(error.suggestedCommand).toMatch(
        / dev --ios --clear --tunnel --json --port \d+ --detach --wait-ready -- --max-workers 2$/
      );
    });

    it(`should suggest, from a detached child, the command its parent was given`, async () => {
      mockProjectState();
      mockEveryPortTaken();
      vi.stubEnv('__EXPO_AGENT_CLI_DETACHED', '1');
      vi.stubEnv(CALLER_ARGV_ENV, JSON.stringify(['--ios', '--detach', '--wait-ready', '--json']));

      const options = resolveDevOptions(['--ios', '--json']);
      vi.unstubAllEnvs();
      const error = await devAsync(projectRoot, options).then(
        () => null,
        (thrown) => thrown
      );

      expect(error.suggestedCommand).toMatch(/ dev --ios --detach --wait-ready --json --port \d+$/);
    });

    // No free port to move to: `dev:stop --force` only when the holder answers as an Expo dev
    // server and its process looks like one, because that is when the command acts.
    it(`should suggest the forced stop when no port is free and a dev server holds it`, async () => {
      mockProjectState();
      vi.mocked(findFreePortAsync).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      vi.mocked(findPortListenerAsync).mockResolvedValueOnce({ pid: 4242, command: 'node' });
      vi.mocked(isExpoDevServerAsync).mockResolvedValueOnce(true);
      vi.mocked(runDevServerAsync).mockResolvedValue(portTakenOn(8081));

      const error = await failureOf(['--ios', '--json']);

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
      vi.mocked(runDevServerAsync).mockResolvedValue(portTakenOn(8081));

      const error = await failureOf(['--ios', '--json']);

      expect(error.message).toContain('How: stop pid 4242 (python3) on port 8081 yourself');
      expect(error.message).not.toContain('dev:stop');
      expect(error.suggestedCommand).toBeUndefined();
    });
  });

  // @ref llp/0035-one-device-per-worktree.rfc.md §How `dev` uses it
  // The e2e harness turns devices off, and its iOS binding cases run on macOS only.
  describe('the bound device', () => {
    const device = {
      backend: 'local-ios' as const,
      platform: 'ios' as const,
      udid: 'SIM-1',
      name: 'agent-cli 0000',
      origin: 'created' as const,
    };

    beforeEach(() => {
      // These cases model an iOS simulator host, regardless of the machine running the suite.
      mockPlatform('darwin');
      vi.mocked(devicesDisabled).mockReturnValue(false);
      vi.mocked(acquireDeviceAsync).mockResolvedValue({
        device,
        justBooted: true,
        action: 'created',
      });
      vi.mocked(inspectBindingAsync).mockResolvedValue({
        binding: null,
        path: '/b',
        state: 'none',
      });
    });

    afterEach(() => {
      mockPlatform(realPlatform);
      vi.mocked(devicesDisabled).mockReturnValue(true);
    });

    // non-darwin-host-binds-nothing
    it.each(['linux', 'win32'] as const)(
      `acquires nothing for --ios on %s, and pins no step`,
      async (platform) => {
        mockStaleDevClientState();
        mockPlatform(platform);
        try {
          await devAsync(projectRoot, resolveDevOptions(['--ios', '--local']));
        } finally {
          mockPlatform(realPlatform);
        }
        expect(acquireDeviceAsync).not.toHaveBeenCalled();
        for (const [, args] of vi.mocked(runDevServerAsync).mock.calls) {
          expect(args).not.toContain('--device');
        }
      }
    );

    it(`refuses --device for --ios off macOS, before the project is probed`, async () => {
      mockStaleDevClientState();
      mockPlatform('linux');

      await expect(
        devAsync(projectRoot, resolveDevOptions(['--ios', '--device', 'X']))
      ).rejects.toMatchObject({ code: 'BAD_ARGS' });

      expect(probeProjectStateAsync).not.toHaveBeenCalled();
    });

    // The stop comes before any device choice, so neither a binding nor a named device is read.
    it.each([[[]], [['--device', 'SIM-1']], [['--device', 'HUMAN']]])(
      'stops before the binding is read while the server runs: %j',
      async (deviceArgs) => {
        mockProjectState();
        vol.fromJSON({ '/project/package.json': '{}' });
        mockRunning();
        const file = bindingPathFor(projectRoot, 'ios', 'local-ios');
        writeBinding(file, bindingFor(projectRoot, 'SIM-1'));

        await expect(
          devAsync(projectRoot, resolveDevOptions(['--ios', ...deviceArgs]))
        ).rejects.toMatchObject({ code: 'DEV_SERVER_RUNNING' });

        expect(acquireDeviceAsync).not.toHaveBeenCalled();
        expect(inspectBindingAsync).not.toHaveBeenCalled();
        expect(runDevServerAsync).not.toHaveBeenCalled();
        expect(readBindingFile(file)).toMatchObject({ binding: { device: { udid: 'SIM-1' } } });
      }
    );

    it(`binds nothing for a run that refuses its EAS route`, async () => {
      mockStaleDevClientState();
      const { detectToolchainAsync } = await import('../../toolchain');
      vi.mocked(detectToolchainAsync).mockResolvedValue({
        platform: 'ios',
        status: 'missing',
        detail: 'no Xcode',
        requirement: 'Xcode',
        caveats: [],
        impossible: true,
      });

      await expect(devAsync(projectRoot, resolveDevOptions(['--ios']))).rejects.toMatchObject({
        code: 'EAS_ROUTE_NOT_CHOSEN',
      });

      expect(acquireDeviceAsync).not.toHaveBeenCalled();
    });

    it(`hands the open the device it bound`, async () => {
      mockProjectState();
      const { openAppOnDeviceAsync } = await import('../openApp');
      vi.mocked(runDevServerAsync).mockImplementation(async (_root, _args, opts) => {
        opts?.onDevServer?.({ url: 'http://127.0.0.1:8081', port: 8081 } as never);
        return devServerRun();
      });

      await devAsync(projectRoot, resolveDevOptions(['--ios']));

      expect(openAppOnDeviceAsync).toHaveBeenCalledWith(
        projectRoot,
        expect.objectContaining({ device, justBooted: true })
      );
    });

    // The rows with a bound or unbound device and no `--device` are in `dev-test.ts`, on the
    // Android stubs the Linux tier runs. These need a device tool that names, refuses or times out.
    describe('--plan', () => {
      it(`previews no device under --plan while the server runs`, async () => {
        mockStaleDevClientState();
        mockRunning();

        await expect(
          devAsync(
            projectRoot,
            resolveDevOptions(['--ios', '--local', '--plan', '--device', 'Sim', '--port', '8091'])
          )
        ).resolves.toBe(0);

        expect(previewExplicitDeviceAsync).not.toHaveBeenCalled();
        expect(inspectBindingAsync).not.toHaveBeenCalled();
        const [plan] = vi.mocked(emitStartPlan).mock.calls[0]!;
        expect(plan.steps).toEqual([]);
        expect(plan.explicitDevice).toBeUndefined();
        expect(plan.reasons).not.toContainEqual(expect.stringContaining('reuse or create'));
        expect(emittedFollowUps().map((followup) => followup.id)).toEqual(['dev-server-running']);
      });

      it(`offers a bind plan's run with the caller's --device and --port`, async () => {
        mockStaleDevClientState();
        vi.mocked(previewExplicitDeviceAsync).mockResolvedValueOnce({
          device: { ...device, name: 'My Sim', origin: 'explicit' },
          summary: 'Will bind My Sim (SIM-1).',
        });

        await devAsync(
          projectRoot,
          resolveDevOptions(['--ios', '--local', '--plan', '--device', 'My Sim', '--port', '8091'])
        );

        expect(previewExplicitDeviceAsync).toHaveBeenCalledWith(
          projectRoot,
          'ios',
          expect.anything()
        );
        expect(emittedFollowUps().find((followup) => followup.id === 'dev')!.command).toBe(
          "npx @expo/agent-cli dev --ios --local --device 'My Sim' --port 8091 --detach --wait-ready"
        );
      });

      it(`fails --plan --device as the run does when the device tool times out`, async () => {
        mockStaleDevClientState();
        vi.mocked(previewExplicitDeviceAsync).mockRejectedValueOnce(
          deviceUnavailableError('create-timeout', { platform: 'ios' })
        );

        await expect(
          devAsync(
            projectRoot,
            resolveDevOptions(['--ios', '--local', '--plan', '--device', 'Sim'])
          )
        ).rejects.toMatchObject({ data: { reason: 'create-timeout' }, exitCode: 22 });

        expect(emitStartPlan).not.toHaveBeenCalled();
      });

      it(`previews no --device for a plan whose EAS route nobody chose, and offers the --eas run without it`, async () => {
        mockStaleDevClientState();
        const { detectToolchainAsync } = await import('../../toolchain');
        vi.mocked(detectToolchainAsync).mockResolvedValue({
          platform: 'ios',
          status: 'missing',
          detail: 'no Xcode',
          requirement: 'Xcode',
          caveats: [],
          impossible: true,
        });
        vi.mocked(previewExplicitDeviceAsync).mockResolvedValueOnce({
          device: { ...device, name: 'My Sim', origin: 'explicit' },
          summary: 'Will bind My Sim (SIM-1).',
        });

        await expect(
          devAsync(projectRoot, resolveDevOptions(['--ios', '--plan', '--device', 'My Sim']))
        ).resolves.toBe(0);

        expect(previewExplicitDeviceAsync).not.toHaveBeenCalled();
        expect(vi.mocked(emitStartPlan).mock.calls[0]![0]).not.toHaveProperty('explicitDevice');
        expect(emittedFollowUps().find((followup) => followup.id === 'dev')!.command).toBe(
          'npx @expo/agent-cli dev --ios --eas --detach --wait-ready'
        );
      });
    });
  });
});

// @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
// The open and the cleanup of a session are in `dev-eas-test.ts`; what the lock and a detached
// child carry is not observable through the stub `eas`.
describe('EAS session lifecycle of the dev-server step', () => {
  const lifecycle = {
    platform: 'ios' as const,
    open: vi.fn(),
    finishAsync: vi.fn(),
    finished: new Promise<void>(() => {}),
  };
  beforeEach(() => {
    mockProjectState();
    vi.mocked(easRunLifecycle).mockReturnValue(lifecycle);
    vi.mocked(runDevServerAsync).mockImplementation(async (_root, _args, opts) => {
      opts?.onDevServer?.({ url: 'http://127.0.0.1:8081', port: 8081 });
      return devServerRun();
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['ends the session with a foreground run', null, false],
    ['keeps the session in a detached child', '1', true],
  ])(`%s, and names the platform on the lock`, async (_case, detached, keepSession) => {
    if (detached) vi.stubEnv('__EXPO_AGENT_CLI_DETACHED', detached);

    await devAsync(projectRoot, resolveDevOptions(['--ios', '--eas']));

    expect(easRunLifecycle).toHaveBeenCalledWith(
      projectRoot,
      expect.objectContaining({ platform: 'ios', keepSession })
    );
    const [, , opts] = vi.mocked(runDevServerAsync).mock.calls[0]!;
    expect(opts!.easPlatform).toBe('ios');
  });

  it(`passes the finish of the plan's one EAS open to the lock of a port retry`, async () => {
    let finishOpen!: () => void;
    const opened = {
      ...lifecycle,
      open: vi.fn(),
      finished: new Promise<void>((resolve) => (finishOpen = resolve)),
    };
    const retried = { ...lifecycle, open: vi.fn() };
    vi.mocked(easRunLifecycle).mockReturnValueOnce(opened).mockReturnValueOnce(retried);
    vi.mocked(resolvePlannedPortAsync).mockResolvedValueOnce({
      port: 8180,
      movedFrom: null,
      bindable: true,
    });
    vi.mocked(runDevServerAsync)
      .mockImplementationOnce(async (_root, _args, opts) => {
        opts?.onDevServer?.({ url: 'http://127.0.0.1:8180', port: 8180 });
        return portTakenOn(8180);
      })
      .mockImplementationOnce(async (_root, _args, opts) => {
        opts?.onDevServer?.({ url: 'http://127.0.0.1:8181', port: 8181 });
        return devServerRun();
      });

    await devAsync(projectRoot, resolveDevOptions(['--ios', '--eas']));

    expect(opened.open).toHaveBeenCalledTimes(1);
    expect(retried.open).not.toHaveBeenCalled();
    const retryFinished = vi.mocked(runDevServerAsync).mock.calls[1]![2]!.easOpenFinished!;
    let settled = false;
    void retryFinished.then(() => (settled = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    finishOpen();
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(true);
  });
});
