import { vol } from 'memfs';
import os from 'os';

import { claimDevServerLockAsync, holdDevServerLockAsync } from '../../devLock';
import type { DevServerLockHandle } from '../../devLock';
import * as Log from '../../log';
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

vi.mock('../../log');
vi.mock('../../utils/expoCli', () => ({ runExpoAsync: vi.fn(), spawnExpoAsync: vi.fn() }));
vi.mock('../../skills/skillsAsync', () => ({ autoSyncSkillsAsync: vi.fn() }));
vi.mock('../../devLock', () => ({
  claimDevServerLockAsync: vi.fn(async () => ({ status: 'unclaimed' })),
  holdDevServerLockAsync: vi.fn(),
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

/** Let the lock claim that comes before the spawn settle, without advancing the clock. */
async function settleSpawn(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Everything the wrapper printed before handing the terminal to `expo start`. */
function printed(): string {
  return vi.mocked(Log.log).mock.calls.flat().join('\n');
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

/** A held lock whose `release` can be asserted on. */
function mockHeldLock(): DevServerLockHandle {
  const lock: DevServerLockHandle = {
    address: '/project/.expo/agent-cli-dev-server.sock',
    replacedStale: false,
    release: vi.fn(),
    update: vi.fn(),
  };
  vi.mocked(holdDevServerLockAsync).mockResolvedValue(lock);
  return lock;
}

/** A live dev server of this project holds the lock on port 8190. */
function mockLiveHolder() {
  vi.mocked(claimDevServerLockAsync).mockResolvedValueOnce({
    status: 'in-use',
    holder: {
      url: 'http://127.0.0.1:8190',
      port: 8190,
      pid: 4242,
      startedAt: '2026-10-06T00:00:00.000Z',
      projectRoot,
      args: ['start', '--port', '8190'],
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vol.reset();
  vi.mocked(autoSyncSkillsAsync).mockResolvedValue(undefined);
  // No lock unless a test asks for one: the wrapper must work either way.
  vi.mocked(holdDevServerLockAsync).mockResolvedValue(null);
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

    expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['start', '--web']);

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
    expect(printed()).toContain('Suggested next:');
    // The step nothing else does: a dev server serves a bundle and opens no app.
    expect(printed()).toContain('npx @expo/agent-cli navigate /');
    expect(printed()).toContain('exp://192.168.1.5:8081');
    expect(printed()).toContain('npx @expo/agent-cli runtime:errors');

    end(0);
    await promise;
  });

  it(`should offer a tunnel instead of an exp:// URL for a development build`, async () => {
    const end = mockLongRunningStart();
    const promise = startAsync(projectRoot, resolveStartOptions(['--dev-client']));
    await settleFollowUps();

    expect(printed()).toContain('npx @expo/agent-cli start --tunnel');
    expect(printed()).not.toContain('exp://');

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

    expect(printed()).toContain('npx @expo/agent-cli start --tunnel');
    expect(printed()).not.toContain('exp://');

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

    expect(printed()).toContain('http://localhost:8134');
    expect(printed()).toContain('npx @expo/agent-cli typecheck');
    expect(printed()).toContain('npx @expo/agent-cli deploy --web');
    expect(printed()).not.toContain('npx --yes eas-cli@latest build');

    end(0);
    await promise;
  });

  it(`should leave out the device hint when only the web bundle is served`, async () => {
    const end = mockLongRunningStart();
    const promise = startAsync(projectRoot, resolveStartOptions(['--web']));
    await settleFollowUps();

    expect(printed()).toContain('Suggested next:');
    expect(printed()).not.toContain('exp://');
    expect(printed()).not.toContain('--tunnel');

    end(0);
    await promise;
  });

  it(`should print nothing with --no-followups`, async () => {
    const end = mockLongRunningStart();
    const promise = startAsync(projectRoot, resolveStartOptions(['--no-followups']));
    await settleFollowUps();

    expect(Log.log).not.toHaveBeenCalled();
    // The flag is @expo/agent-cli's own, so `expo start` never sees it.
    expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['start']);

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
    const promise = runDevServerAsync(projectRoot, ['run:ios'], { agentSkills: true });
    await settleSpawn();

    expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['run:ios']);
    vi.advanceTimersByTime(SKILLS_SYNC_IDLE_DELAY_MS);
    expect(autoSyncSkillsAsync).toHaveBeenCalledWith(projectRoot, { silent: false });

    end(0);
    await promise;
  });

  it(`should skip the sync when agent skills are off`, async () => {
    const end = mockLongRunningStart();
    const promise = runDevServerAsync(projectRoot, ['run:android'], { agentSkills: false });
    await settleSpawn();

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
        await runDevServerAsync(projectRoot, ['start', '--go'], { agentSkills: false, output });

        expect(spawnExpoAsync).toHaveBeenCalledWith(projectRoot, ['start', '--go'], {
          output,
          ci: false,
        });
      }
    );

    it.each(['run:ios', 'run:android'])(
      `should keep the watcher on for %s, which ends in a dev server too`,
      async (command) => {
        await runDevServerAsync(projectRoot, [command], { agentSkills: false, output: 'capture' });

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
        agentSkills: false,
      });
      await settleSpawn();

      // The arguments go along, because the requested port is the fallback when the dev server
      // never reports the one it took.
      expect(holdDevServerLockAsync).toHaveBeenCalledWith(
        projectRoot,
        ['start', '--port', '8082'],
        expect.objectContaining({ since: expect.any(Number), isRunning: expect.any(Function) })
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
        agentSkills: false,
        onDevServer,
      });
      await settleSpawn();
      const { onResolved } = vi.mocked(holdDevServerLockAsync).mock.calls[0]![2];

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
    it(`should not open on the port it was given when /status answers for another project`, async () => {
      const onDevServer = vi.fn();
      const end = mockLongRunningStart();
      vi.mocked(probeBundlerAsync).mockResolvedValue(foreign);
      const promise = runDevServerAsync(projectRoot, ['start', '--port', '8082'], {
        agentSkills: false,
        onDevServer,
      });
      await settleSpawn();
      const { onResolved } = vi.mocked(holdDevServerLockAsync).mock.calls[0]![2];

      onResolved?.({ port: 8082, source: 'arg' });
      await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS * 3);

      expect(onDevServer).not.toHaveBeenCalled();
      expect(probeBundlerAsync).toHaveBeenCalledTimes(1);
      end(0);
      await promise;
    });

    it(`should not open on the port it was given when the dev server exits before /status answers`, async () => {
      const onDevServer = vi.fn();
      const end = mockLongRunningStart();
      vi.mocked(probeBundlerAsync).mockResolvedValue(silent);
      const promise = runDevServerAsync(projectRoot, ['start', '--port', '8082'], {
        agentSkills: false,
        onDevServer,
      });
      await settleSpawn();
      const { onResolved } = vi.mocked(holdDevServerLockAsync).mock.calls[0]![2];

      onResolved?.({ port: 8082, source: 'arg' });
      await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS * 3);
      end(0);
      await promise;
      await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS * 3);

      expect(onDevServer).not.toHaveBeenCalled();
      onResolved?.({ port: 8082, source: 'default' });
      onResolved?.({ port: 8082, source: 'log' });
      expect(onDevServer).toHaveBeenCalledTimes(1);
    });

    // The lock tells `arg` at the spawn and `log` when Metro reports: one open, not two.
    it(`should open once when the port arrives from the arguments and then from the log`, async () => {
      const onDevServer = vi.fn();
      const end = mockLongRunningStart();
      vi.mocked(probeBundlerAsync).mockResolvedValue(ours);
      const promise = runDevServerAsync(projectRoot, ['start', '--port', '8082'], {
        agentSkills: false,
        onDevServer,
      });
      await settleSpawn();
      const { onResolved } = vi.mocked(holdDevServerLockAsync).mock.calls[0]![2];

      onResolved?.({ port: 8082, source: 'arg' });
      onResolved?.({ port: 8082, source: 'log' });
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
        agentSkills: false,
        onDevServer,
      });
      await settleSpawn();
      const { onResolved } = vi.mocked(holdDevServerLockAsync).mock.calls[0]![2];

      onResolved?.({ port: 8082, source: 'arg' });
      await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS * 2);
      expect(onDevServer).not.toHaveBeenCalled();

      onResolved?.({ port: 8082, source: 'log' });
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
        agentSkills: false,
        onDevServer,
      });
      await settleSpawn();
      const { onResolved } = vi.mocked(holdDevServerLockAsync).mock.calls[0]![2];

      onResolved?.({ port: 8082, source: 'arg' });
      await vi.advanceTimersByTimeAsync(0);

      expect(onDevServer).toHaveBeenCalledTimes(1);
      end(0);
      await promise;
    });

    it(`should report the dev server as running until it exits`, async () => {
      const end = mockLongRunningStart();
      const promise = runDevServerAsync(projectRoot, ['start'], { agentSkills: false });
      await settleSpawn();
      const { isRunning } = vi.mocked(holdDevServerLockAsync).mock.calls[0]![2];

      expect(isRunning?.()).toBe(true);

      end(0);
      await promise;
      expect(isRunning?.()).toBe(false);
    });

    // One project has one dev server: a second one could not hold the lock, so nothing could find
    // or stop it. The stop says what the caller passed: the platform and what its steps built.
    it(`should not spawn a dev server while another of this project holds the lock`, async () => {
      mockLiveHolder();

      const error = await runDevServerAsync(projectRoot, ['start', '--port', '8191'], {
        agentSkills: true,
        oneDevServer: { platform: 'ios', built: 'the build this run did is recorded' },
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: 'DEV_SERVER_APPEARED',
        exitCode: 20,
        message: expect.stringContaining(
          'started a dev server on port 8190 while this one built, so this step did not start a second one.\nWhy: one dev server per project; the build this run did is recorded.'
        ),
      });
      expect((error as Error).message).toContain('"npx @expo/agent-cli smoke --ios"');
      expect(runExpoAsync).not.toHaveBeenCalled();
      expect(holdDevServerLockAsync).not.toHaveBeenCalled();
      vi.advanceTimersByTime(SKILLS_SYNC_IDLE_DELAY_MS);
      expect(autoSyncSkillsAsync).not.toHaveBeenCalled();
    });

    // The plain `start` wrapper forwards its arguments untouched: a second dev server of this
    // project runs without the lock, and the holder is on the event stream only.
    it(`should spawn without the lock while another holds it, when not asked for one dev server`, async () => {
      mockLiveHolder();
      const end = mockLongRunningStart();
      const promise = runDevServerAsync(projectRoot, ['start', '--port', '8191'], {
        agentSkills: false,
      });
      await settleSpawn();

      expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['start', '--port', '8191']);
      // Held with no lock, so the hold does not publish again.
      expect(holdDevServerLockAsync).toHaveBeenCalledWith(
        projectRoot,
        ['start', '--port', '8191'],
        expect.objectContaining({ claim: { status: 'held', lock: null } })
      );

      end(0);
      await expect(promise).resolves.toMatchObject({ exitCode: 0 });
    });

    it(`should spawn a second dev server that names no port`, async () => {
      const end = mockLongRunningStart();
      const promise = startAsync(projectRoot, resolveStartOptions([]));
      await settleFollowUps();
      await settleSpawn();

      expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['start']);
      expect(holdDevServerLockAsync).toHaveBeenCalledWith(
        projectRoot,
        ['start'],
        expect.objectContaining({ claim: { status: 'unclaimed' } })
      );

      end(0);
      await expect(promise).resolves.toBe(0);
    });

    it(`should spawn the start wrapper's dev server while another holds the lock`, async () => {
      mockLiveHolder();
      const end = mockLongRunningStart();
      const promise = startAsync(projectRoot, resolveStartOptions(['--port', '8191']));
      await settleFollowUps();
      await settleSpawn();

      expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['start', '--port', '8191']);

      end(0);
      await expect(promise).resolves.toBe(0);
    });

    it(`should hold the lock it claimed before the spawn`, async () => {
      const claim = { status: 'held' as const, lock: null };
      vi.mocked(claimDevServerLockAsync).mockResolvedValueOnce(claim);
      const end = mockLongRunningStart();
      const promise = runDevServerAsync(projectRoot, ['start', '--port', '8082'], {
        agentSkills: false,
      });
      await settleSpawn();

      expect(claimDevServerLockAsync).toHaveBeenCalledWith(
        projectRoot,
        ['start', '--port', '8082'],
        { since: expect.any(Number) }
      );
      expect(holdDevServerLockAsync).toHaveBeenCalledWith(
        projectRoot,
        ['start', '--port', '8082'],
        expect.objectContaining({ claim })
      );

      end(0);
      await promise;
    });

    it(`should release the lock when the dev server exits`, async () => {
      const lock = mockHeldLock();
      const end = mockLongRunningStart();
      const promise = runDevServerAsync(projectRoot, ['start'], { agentSkills: false });
      await settleSpawn();

      expect(lock.release).not.toHaveBeenCalled();

      end(0);
      await promise;
      expect(lock.release).toHaveBeenCalled();
    });

    it(`should release the lock when the dev server could not be spawned`, async () => {
      const lock = mockHeldLock();
      vi.mocked(runExpoAsync).mockRejectedValue(new Error('EXPO_CLI_NOT_FOUND'));

      await expect(
        runDevServerAsync(projectRoot, ['start'], { agentSkills: false })
      ).rejects.toThrow('EXPO_CLI_NOT_FOUND');
      expect(lock.release).toHaveBeenCalled();
    });

    it(`should run the dev server when no lock could be taken`, async () => {
      vi.mocked(holdDevServerLockAsync).mockResolvedValue(null);
      const end = mockLongRunningStart();
      const promise = runDevServerAsync(projectRoot, ['start'], { agentSkills: false });
      await settleSpawn();

      end(3);
      // The lock is a convenience; the exit code of the dev server is the answer either way.
      await expect(promise).resolves.toMatchObject({ exitCode: 3 });
    });
  });
});
