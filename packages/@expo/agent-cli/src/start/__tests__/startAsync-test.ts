import { vol } from 'memfs';
import os from 'os';

import { publishDevServerPortAsync, RunLock } from '../../devLock';
import * as Log from '../../log';
import { withLeaseExtendedAsync } from '../../deviceBinding/renew';
import { autoSyncSkillsAsync } from '../../skills/skillsAsync';
import { runExpoAsync, spawnExpoAsync } from '../../utils/expoCli';
import { resolveStartOptions } from '../resolveOptions';
import { probeBundlerAsync } from '../../runtime/bundlerStatus';
import {
  runDevServerAsync,
  SKILLS_SYNC_IDLE_DELAY_MS,
  startAsync,
  STATUS_POLL_INTERVAL_MS,
} from '../startAsync';
import { printed } from '../../utils/__tests__/printed';
import { createStartupScope, withStartupTasksAsync } from '../../utils/startupTasks';

vi.mock('../../log');
vi.mock('../../utils/expoCli', () => ({ runExpoAsync: vi.fn(), spawnExpoAsync: vi.fn() }));
vi.mock('../../skills/skillsAsync', () => ({ autoSyncSkillsAsync: vi.fn() }));
vi.mock('../../devLock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../devLock')>()),
  publishDevServerPortAsync: vi.fn(),
}));
vi.mock('../../deviceBinding/renew', () => ({
  withLeaseExtendedAsync: vi.fn((_root: string, work: () => Promise<unknown>) => work()),
}));
vi.mock('../../runtime/bundlerStatus', () => ({
  probeBundlerAsync: vi.fn(),
}));
// The ladder asks whether this machine has a device to open the app on (llp/0009 §Device-aware
// ladders). Mocked, because a unit test must not depend on whether a simulator happens to be
// booted on the machine running it — and `unknown` is the answer that leaves every rung as it was.
vi.mock('../../device/localDevice', () => ({
  probeLocalDeviceAsync: vi.fn(async () => ({ state: 'unknown', device: null, reason: null })),
}));

const projectRoot = '/project';

/** A step of a run, as `start` gives it: its own lock, `serving`. */
const step = () => ({ lock: new RunLock(projectRoot), phase: 'serving' as const });

/** `/status` answers, per what a probe of the named port learns. */
const silent = { answering: false, projectRootMatched: null, reportedProjectRoot: null };
const ours = { answering: true, projectRootMatched: true, reportedProjectRoot: projectRoot };
const foreign = { answering: true, projectRootMatched: false, reportedProjectRoot: '/other' };

/**
 * Let the follow-up ladder settle without advancing the clock.
 *
 * The ladder now awaits one bounded probe before it is printed, so the line that used to be
 * synchronous is one microtask away. What the tests below assert is unchanged: everything is
 * printed *before the subprocess exists*, which is the property that matters — nothing printed
 * after Metro starts streaming survives in a terminal.
 */
async function settleFollowUps(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Pin this host's LAN address, so the real-device follow-up does not depend on the machine. */
function mockLanAddress(address: string) {
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    en0: [{ address, family: 'IPv4', internal: false }],
  } as any);
}

/** Keep `expo start` "running" until the returned callback ends it. */
function mockLongRunningStart(): (code: number) => void {
  let end: (code: number) => void = () => {};
  vi.mocked(runExpoAsync).mockReturnValue(
    new Promise<number>((resolve) => {
      end = resolve;
    })
  );
  return (code) => end(code);
}

beforeEach(() => {
  vi.useFakeTimers();
  vol.reset();
  vi.mocked(autoSyncSkillsAsync).mockResolvedValue(undefined);
  vi.mocked(publishDevServerPortAsync).mockResolvedValue(undefined);
  vi.mocked(probeBundlerAsync).mockResolvedValue(silent);
  mockLanAddress('192.168.1.5');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe(startAsync, () => {
  it(`should run expo start with the forwarded arguments`, async () => {
    const end = mockLongRunningStart();
    const promise = startAsync(projectRoot, resolveStartOptions(['--web']));
    await settleFollowUps();

    expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['start', '--web'], {
      signal: undefined,
    });

    end(0);
    await promise;
  });

  it(`should not sync skills before the idle delay elapses`, async () => {
    const end = mockLongRunningStart();
    const promise = startAsync(projectRoot, resolveStartOptions([]));
    await settleFollowUps();

    vi.advanceTimersByTime(SKILLS_SYNC_IDLE_DELAY_MS - 1);
    expect(autoSyncSkillsAsync).not.toHaveBeenCalled();

    end(0);
    await promise;
  });

  it(`should sync skills after the idle delay while the dev server runs`, async () => {
    const end = mockLongRunningStart();
    const promise = startAsync(projectRoot, resolveStartOptions([]));
    await settleFollowUps();

    vi.advanceTimersByTime(SKILLS_SYNC_IDLE_DELAY_MS);
    expect(autoSyncSkillsAsync).toHaveBeenCalledWith(projectRoot, { silent: false });

    end(0);
    await promise;
  });

  it(`should not sync skills with --no-agent-skills`, async () => {
    const end = mockLongRunningStart();
    const promise = startAsync(projectRoot, resolveStartOptions(['--no-agent-skills']));
    await settleFollowUps();

    vi.advanceTimersByTime(SKILLS_SYNC_IDLE_DELAY_MS * 2);
    expect(autoSyncSkillsAsync).not.toHaveBeenCalled();

    end(0);
    await promise;
  });

  // @ref llp/0009-smart-followups.rfc.md §Examples per command
  it(`should print the follow-ups before handing the terminal to expo start`, async () => {
    const end = mockLongRunningStart();
    const promise = startAsync(projectRoot, resolveStartOptions([]));
    await settleFollowUps();

    // Printed synchronously, before the subprocess exists: nothing printed after Metro starts
    // streaming survives in a terminal a person or an agent reads.
    expect(printed(Log.log)).toContain('Suggested next:');
    // The step nothing else does: a dev server serves a bundle and opens no app.
    expect(printed(Log.log)).toContain('npx @expo/agent-cli navigate /');
    expect(printed(Log.log)).toContain('exp://192.168.1.5:8081');
    expect(printed(Log.log)).toContain('npx @expo/agent-cli runtime:errors');

    end(0);
    await promise;
  });

  it(`should offer a tunnel instead of an exp:// URL for a development build`, async () => {
    const end = mockLongRunningStart();
    const promise = startAsync(projectRoot, resolveStartOptions(['--dev-client']));
    await settleFollowUps();

    expect(printed(Log.log)).toContain('npx @expo/agent-cli start --tunnel');
    expect(printed(Log.log)).not.toContain('exp://');

    end(0);
    await promise;
  });

  // `expo start` reads the dependency, not only the flag, so the URL shape has to as well.
  it(`should offer a tunnel for a project that depends on expo-dev-client`, async () => {
    vol.fromJSON({
      [`${projectRoot}/package.json`]: JSON.stringify({
        dependencies: { 'expo-dev-client': '~5.0.0' },
      }),
    });
    const end = mockLongRunningStart();
    const promise = startAsync(projectRoot, resolveStartOptions([]));
    await settleFollowUps();

    expect(printed(Log.log)).toContain('npx @expo/agent-cli start --tunnel');
    expect(printed(Log.log)).not.toContain('exp://');

    end(0);
    await promise;
  });

  // @ref llp/0009-smart-followups.rfc.md §Examples per command — the web ladder.
  // A web run has no device steps and no debugger target, so its rungs are the site, the check
  // that proves it compiles, and the deploy that ships a web build.
  it(`should lead a web run with the site URL, not a native cloud build`, async () => {
    const end = mockLongRunningStart();
    const promise = startAsync(projectRoot, resolveStartOptions(['--web', '--port', '8134']));
    await settleFollowUps();

    expect(printed(Log.log)).toContain('http://localhost:8134');
    expect(printed(Log.log)).toContain('npx @expo/agent-cli typecheck');
    expect(printed(Log.log)).toContain('npx @expo/agent-cli deploy --web');
    expect(printed(Log.log)).not.toContain('npx --yes eas-cli build');

    end(0);
    await promise;
  });

  it(`should leave out the device hint when only the web bundle is served`, async () => {
    const end = mockLongRunningStart();
    const promise = startAsync(projectRoot, resolveStartOptions(['--web']));
    await settleFollowUps();

    expect(printed(Log.log)).toContain('Suggested next:');
    expect(printed(Log.log)).not.toContain('exp://');
    expect(printed(Log.log)).not.toContain('--tunnel');

    end(0);
    await promise;
  });

  it(`should print nothing with --no-followups`, async () => {
    const end = mockLongRunningStart();
    const promise = startAsync(projectRoot, resolveStartOptions(['--no-followups']));
    await settleFollowUps();

    expect(Log.log).not.toHaveBeenCalled();
    // The flag is @expo/agent-cli's own, so `expo start` never sees it.
    expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['start'], { signal: undefined });

    end(0);
    await promise;
  });

  it(`should cancel the pending sync when the dev server exits early`, async () => {
    const end = mockLongRunningStart();
    const promise = startAsync(projectRoot, resolveStartOptions([]));
    await settleFollowUps();

    end(1);
    await expect(promise).resolves.toBe(1);

    vi.advanceTimersByTime(SKILLS_SYNC_IDLE_DELAY_MS * 2);
    expect(autoSyncSkillsAsync).not.toHaveBeenCalled();
  });
});

describe(runDevServerAsync, () => {
  it(`should run any dev server command and sync skills`, async () => {
    const end = mockLongRunningStart();
    const promise = runDevServerAsync(projectRoot, ['run:ios'], { ...step(), agentSkills: true });

    expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['run:ios'], { signal: undefined });
    vi.advanceTimersByTime(SKILLS_SYNC_IDLE_DELAY_MS);
    expect(autoSyncSkillsAsync).toHaveBeenCalledWith(projectRoot, { silent: false });

    end(0);
    await promise;
  });

  // @ref llp/0035-one-device-per-worktree.rfc.md §Lease timer
  it(`should renew the worktree's device lease while the dev server runs`, async () => {
    const end = mockLongRunningStart();
    const promise = runDevServerAsync(projectRoot, ['run:ios'], { ...step(), agentSkills: false });

    expect(withLeaseExtendedAsync).toHaveBeenCalledWith(projectRoot, expect.any(Function));
    expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['run:ios'], { signal: undefined });

    end(0);
    await promise;
  });

  it(`should skip the sync when agent skills are off`, async () => {
    const end = mockLongRunningStart();
    const promise = runDevServerAsync(projectRoot, ['run:android'], {
      ...step(),
      agentSkills: false,
    });

    vi.advanceTimersByTime(SKILLS_SYNC_IDLE_DELAY_MS * 2);
    expect(autoSyncSkillsAsync).not.toHaveBeenCalled();

    end(0);
    await promise;
  });

  // @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol — layer 2.
  // The one thing about a captured dev server that is not the same as any other captured `expo`
  // run: it must keep watching files. `CI=1` would freeze Metro on the code it read at start-up,
  // and the readiness gate would then certify a project the agent had already broken [observed — friction
  // run 2, 2026-08-23].
  describe('the environment the dev server is spawned with', () => {
    beforeEach(() => {
      vi.mocked(spawnExpoAsync).mockResolvedValue({
        cli: { command: 'expo', args: [] },
        result: { exitCode: 0, stdout: '', stderr: '' },
      });
    });

    it.each(['tee', 'capture'] as const)(
      `should never tell a %s dev server that it is CI`,
      async (output) => {
        await runDevServerAsync(projectRoot, ['start', '--go'], {
          ...step(),
          agentSkills: false,
          output,
        });

        expect(spawnExpoAsync).toHaveBeenCalledWith(projectRoot, ['start', '--go'], {
          output,
          ci: false,
        });
      }
    );

    it.each(['run:ios', 'run:android'])(
      `should keep the watcher on for %s, which ends in a dev server too`,
      async (command) => {
        await runDevServerAsync(projectRoot, [command], {
          ...step(),
          agentSkills: false,
          output: 'capture',
        });

        expect(spawnExpoAsync).toHaveBeenCalledWith(
          projectRoot,
          [command],
          expect.objectContaining({ ci: false })
        );
      }
    );
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Status
  describe('the dev server lock', () => {
    it(`should publish the dev server alongside the subprocess`, async () => {
      const end = mockLongRunningStart();
      const promise = runDevServerAsync(projectRoot, ['start', '--port', '8082'], {
        ...step(),
        agentSkills: false,
      });

      // The arguments go along, because the requested port is the fallback when the dev server
      // never reports the one it took.
      expect(publishDevServerPortAsync).toHaveBeenCalledWith(
        projectRoot,
        ['start', '--port', '8082'],
        expect.objectContaining({
          since: expect.any(Number),
          isRunning: expect.any(Function),
          easPlatform: null,
        })
      );

      end(0);
      await promise;
    });

    // @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
    it(`should name the EAS platform of the run on the lock`, async () => {
      const end = mockLongRunningStart();
      const promise = runDevServerAsync(projectRoot, ['start', '--port', '8082'], {
        ...step(),
        agentSkills: false,
        easPlatform: 'android',
      });

      expect(publishDevServerPortAsync).toHaveBeenCalledWith(
        projectRoot,
        ['start', '--port', '8082'],
        expect.objectContaining({ easPlatform: 'android' })
      );

      end(0);
      await promise;
    });

    // `dev` passes `--port` on every serving step, so a port from the arguments alone is not proof
    // that anything listens there: the open waits for `/status`.
    it(`should open on the port it was given once /status answers there for this project`, async () => {
      const onDevServer = vi.fn();
      const end = mockLongRunningStart();
      vi.mocked(probeBundlerAsync).mockResolvedValueOnce(silent).mockResolvedValue(ours);
      const promise = runDevServerAsync(projectRoot, ['start', '--port', '8082'], {
        ...step(),
        agentSkills: false,
        onDevServer,
      });
      const { onResolved } = vi.mocked(publishDevServerPortAsync).mock.calls[0]![2];

      onResolved?.({ port: 8082, source: 'arg' });
      await vi.advanceTimersByTimeAsync(0);
      expect(onDevServer).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS);

      expect(probeBundlerAsync).toHaveBeenCalledWith('http://127.0.0.1:8082', {
        timeoutMs: STATUS_POLL_INTERVAL_MS,
        projectRoot,
      });
      expect(onDevServer).toHaveBeenCalledWith({ url: 'http://127.0.0.1:8082', port: 8082 });
      end(0);
      await promise;
    });

    // Another project's Metro on the named port answers `/status` too; its root says it is not ours.
    // A foreign answer does not end the wait: that server may leave before this Metro binds.
    it(`should not open on the port it was given while /status answers for another project`, async () => {
      const onDevServer = vi.fn();
      const end = mockLongRunningStart();
      vi.mocked(probeBundlerAsync).mockResolvedValue(foreign);
      const promise = runDevServerAsync(projectRoot, ['start', '--port', '8082'], {
        ...step(),
        agentSkills: false,
        onDevServer,
      });
      const { onResolved } = vi.mocked(publishDevServerPortAsync).mock.calls[0]![2];

      onResolved?.({ port: 8082, source: 'arg' });
      await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS * 3);

      expect(onDevServer).not.toHaveBeenCalled();
      expect(vi.mocked(probeBundlerAsync).mock.calls.length).toBeGreaterThan(1);
      end(0);
      await promise;
    });

    it.each(['foreground', 'cancelled'] as const)(
      'settles late port and Metro callbacks after the %s run ends',
      async (mode) => {
        const onDevServer = vi.fn();
        const end = mockLongRunningStart();
        let answer!: (value: typeof ours) => void;
        vi.mocked(probeBundlerAsync).mockReturnValue(new Promise((resolve) => (answer = resolve)));
        let publish!: () => void;
        const publication = new Promise<void>((resolve) => (publish = resolve));
        vi.mocked(publishDevServerPortAsync).mockImplementation(async (_root, _args, options) => {
          options.onResolved?.({ port: 8082, source: 'arg' });
          await publication;
          options.onResolved?.({ port: 8082, source: 'reported' });
        });
        const scope = createStartupScope();
        const run = () =>
          runDevServerAsync(projectRoot, ['start', '--port', '8082'], {
            ...step(),
            agentSkills: false,
            onDevServer,
          });
        const promise = (mode === 'foreground' ? run() : withStartupTasksAsync(run, scope)).catch(
          (error) => error
        );
        let settled = false;
        void promise.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        if (mode === 'cancelled') scope.requestStop('cancel-startup');
        end(0);
        publish();
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(mode === 'foreground');
        expect(onDevServer).toHaveBeenCalledTimes(mode === 'foreground' ? 1 : 0);
        answer(ours);
        const result = await promise;
        if (mode !== 'foreground') expect(result).toMatchObject({ code: 'DEV_INTERRUPTED' });
        expect(onDevServer).toHaveBeenCalledTimes(mode === 'foreground' ? 1 : 0);
      }
    );

    // The lock tells `arg` at the spawn and `log` when Metro reports: one open, not two.
    it(`should open once when the port arrives from the arguments and then from the log`, async () => {
      const onDevServer = vi.fn();
      const end = mockLongRunningStart();
      vi.mocked(probeBundlerAsync).mockResolvedValue(ours);
      const promise = runDevServerAsync(projectRoot, ['start', '--port', '8082'], {
        ...step(),
        agentSkills: false,
        onDevServer,
      });
      const { onResolved } = vi.mocked(publishDevServerPortAsync).mock.calls[0]![2];

      onResolved?.({ port: 8082, source: 'arg' });
      onResolved?.({ port: 8082, source: 'reported' });
      await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS * 3);

      expect(onDevServer).toHaveBeenCalledTimes(1);
      end(0);
      await promise;
    });

    // The `/status` poll is still pending when Metro logs its port: the log opens, and the poll
    // that answers afterwards opens nothing.
    it(`should open once through the log while the /status poll is pending`, async () => {
      const onDevServer = vi.fn();
      const end = mockLongRunningStart();
      vi.mocked(probeBundlerAsync).mockResolvedValue(silent);
      const promise = runDevServerAsync(projectRoot, ['start', '--port', '8082'], {
        ...step(),
        agentSkills: false,
        onDevServer,
      });
      const { onResolved } = vi.mocked(publishDevServerPortAsync).mock.calls[0]![2];

      onResolved?.({ port: 8082, source: 'arg' });
      await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS * 2);
      expect(onDevServer).not.toHaveBeenCalled();

      onResolved?.({ port: 8082, source: 'reported' });
      expect(onDevServer).toHaveBeenCalledTimes(1);
      expect(onDevServer).toHaveBeenCalledWith({ url: 'http://127.0.0.1:8082', port: 8082 });

      vi.mocked(probeBundlerAsync).mockResolvedValue(ours);
      const probes = vi.mocked(probeBundlerAsync).mock.calls.length;
      await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS * 3);
      expect(onDevServer).toHaveBeenCalledTimes(1);
      // The poll ends at its next turn, once the open has fired.
      expect(vi.mocked(probeBundlerAsync).mock.calls.length).toBeLessThanOrEqual(probes + 1);
      end(0);
      await promise;
    });

    // `dev` spawned this server on the port; a Metro that names no root is that server.
    it(`should open on the port it was given when /status names no project root`, async () => {
      const onDevServer = vi.fn();
      const end = mockLongRunningStart();
      vi.mocked(probeBundlerAsync).mockResolvedValue({ ...silent, answering: true });
      const promise = runDevServerAsync(projectRoot, ['start', '--port', '8082'], {
        ...step(),
        agentSkills: false,
        onDevServer,
      });
      const { onResolved } = vi.mocked(publishDevServerPortAsync).mock.calls[0]![2];

      onResolved?.({ port: 8082, source: 'arg' });
      await vi.advanceTimersByTimeAsync(0);

      expect(onDevServer).toHaveBeenCalledTimes(1);
      end(0);
      await promise;
    });

    it(`should report the dev server as running until it exits`, async () => {
      const end = mockLongRunningStart();
      const promise = runDevServerAsync(projectRoot, ['start'], { ...step(), agentSkills: false });
      const { isRunning } = vi.mocked(publishDevServerPortAsync).mock.calls[0]![2];

      expect(isRunning?.()).toBe(true);

      end(0);
      await promise;
      expect(isRunning?.()).toBe(false);
    });
  });
});
