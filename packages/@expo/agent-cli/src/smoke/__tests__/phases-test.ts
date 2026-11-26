// @ref llp/0005-runtime-loop-tools.rfc.md §The smoke gate
// @ref llp/0010-agent-conventions.rfc.md §Exit codes
//
// The outcome table. This is the half of `smoke` that can be wrong in a way nothing else notices:
// every phase is a function that is already tested where it lives, and what is decided *here* is
// which combination of their answers is a pass, a failure and an "I could not tell" — plus which
// phases stop the run and which are only reported.
//
// The dependencies are fakes rather than mocks of the real modules, which is what makes the table
// readable: a case is a set of answers and the verdict they add up to.
//
// This file holds the core of the table and the exit codes. The other `phases*-test.ts` files hold
// the rest, one topic each, and `./phasesFixtures.ts` holds the fakes they share.

import type { SmokeDeps } from '../contract';
import { runSmokePhasesAsync, smokeExitCode } from '../phases';
import { RUNTIME_UNSUPPORTED_GRACE_MS } from '../timeouts';
import type { SmokePhaseId } from '../types';
import {
  options,
  discovery,
  bundle,
  opened,
  screenshot,
  record,
  deps,
  bootableDevice,
  statusOf,
  steppingClock,
} from './phasesFixtures';

describe(runSmokePhasesAsync, () => {
  it(`passes a healthy app, with every phase answered`, async () => {
    const run = await runSmokePhasesAsync(deps(), options());

    expect(run.outcome).toBe('passed');
    expect(statusOf(run, 'dev-server')).toBe('ok');
    expect(statusOf(run, 'bundler-ready')).toBe('ok');
    expect(statusOf(run, 'bundle')).toBe('ok');
    expect(statusOf(run, 'app')).toBe('ok');
    // The app was already attached, so it was put back on the served bundle before it was read.
    expect(statusOf(run, 'reload')).toBe('ok');
    // No `--route`, so the route phase did not run — and says so rather than reading as a pass.
    expect(statusOf(run, 'route')).toBe('skipped');
    expect(statusOf(run, 'runtime')).toBe('ok');
    expect(statusOf(run, 'errors')).toBe('ok');
    expect(statusOf(run, 'screenshot')).toBe('ok');
    expect(run.screenshot.ok).toBe(true);
  });

  // @ref llp/0021-honest-reports.rfc.md §The rules — F98,
  // the second live-cloud run.
  //
  // A healthy app opens nothing: the `app` phase finds it already connected and the `route` phase
  // is skipped, so the two steps that used to set these fields never run. The device was still
  // found and still photographed — the screenshot phase resolves one of its own — and a report that
  // left `deviceBackend` null said "no device was involved" over a run that had used a billed cloud
  // session for its picture [observed — live cloud, 2026-08-27: `deviceBackend: null` beside
  // `screenshot.command: "eas simulator:exec … screenshot"` and a 64 KB PNG].
  it(`names the device it photographed, even when it opened nothing`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        cloudRoute: { current: 'required' },
        probeDevice: async () => ({
          deviceId: 'sess-live',
          backend: 'cloud' as const,
          reason: null,
        }),
        captureScreenshot: async () => screenshot({ deviceId: 'sess-live' }),
      }),
      options({ cloud: 'required' })
    );

    expect(statusOf(run, 'route')).toBe('skipped');
    expect(run.deviceBackend).toBe('cloud');
    expect(run.deviceId).toBe('sess-live');
  });

  // The other side of it: a run that found no device to photograph has no device to name, and
  // inventing one would be worse than the null this keeps.
  it(`names no device when there was none to find`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        probeDevice: async () => ({ deviceId: null, backend: null, reason: 'no booted device' }),
      }),
      options()
    );

    expect(run.deviceBackend).toBeNull();
    expect(run.deviceId).toBeNull();
  });

  // The property that makes the phase list readable at all.
  // @ref llp/0005-runtime-loop-tools.rfc.md §The smoke gate — observed live, 2026-08-24. Every
  // phase has to be about the *same* dev server. `navigate` finds its own, so a run that had
  // settled on one in phase 1 went looking again in phase 4, found nothing, and exited 1 from a
  // run whose first three phases had all answered.
  it(`opens the route on the dev server this run settled on`, async () => {
    const openRoute = vi.fn(async (route: string) => opened({ route }));
    await runSmokePhasesAsync(
      deps({
        discoverDevServer: async () => discovery({ devServerUrl: 'http://127.0.0.1:8210' }),
        openRoute,
      }),
      options({ route: '/notes' })
    );

    expect(openRoute).toHaveBeenCalledWith('/notes', 'http://127.0.0.1:8210', expect.any(Number));
  });

  it(`reports every phase exactly once, in order, whatever happened`, async () => {
    const runs = await Promise.all([
      runSmokePhasesAsync(deps(), options()),
      runSmokePhasesAsync(
        deps({ discoverDevServer: async () => discovery({ reachable: false }) }),
        options()
      ),
      runSmokePhasesAsync(
        deps({ checkEntryBundle: async () => bundle({ outcome: 'broken' }) }),
        options()
      ),
      runSmokePhasesAsync(
        deps({
          waitForAppConnection: async () => ({
            appsConnected: 0,
            timedOut: true,
            waitedMs: 1,
            skippedApps: [],
          }),
        }),
        options()
      ),
    ]);

    for (const run of runs) {
      expect(run.phases.map((phase) => phase.id)).toEqual([
        'dev-server',
        'bundler-ready',
        'bundle',
        'app',
        'reload',
        'route',
        'runtime',
        'errors',
        'screenshot',
      ]);
    }
  });

  describe('the dev server', () => {
    it(`fails attach-only when none answers, and starts nothing`, async () => {
      const startDevServer = vi.fn();
      const run = await runSmokePhasesAsync(
        deps({
          discoverDevServer: async () => discovery({ reachable: false, reason: 'ECONNREFUSED' }),
          startDevServer,
        }),
        options()
      );

      expect(run.outcome).toBe('failed');
      expect(statusOf(run, 'dev-server')).toBe('failed');
      expect(startDevServer).not.toHaveBeenCalled();
      expect(run.started).toBe(false);
    });

    it(`starts one by default, and reports that it did`, async () => {
      let reachable = false;
      const run = await runSmokePhasesAsync(
        deps({
          discoverDevServer: async () => {
            const found = discovery({ reachable });
            reachable = true;
            return found;
          },
        }),
        options({ bootstrap: true })
      );

      expect(run.outcome).toBe('passed');
      expect(run.started).toBe(true);
      expect(run.environment.devServer).toBe('started');
      expect(statusOf(run, 'start-dev-server')).toBe('ok');
      expect(statusOf(run, 'dev-server')).toBe('ok');
    });

    it(`fails when it could not start one, and says why`, async () => {
      const run = await runSmokePhasesAsync(
        deps({
          discoverDevServer: async () => discovery({ reachable: false }),
          startDevServer: async () => ({
            ok: false,
            devServerUrl: null,
            reason: 'port 8081 is taken',
          }),
        }),
        options({ bootstrap: true })
      );

      expect(run.outcome).toBe('failed');
      expect(statusOf(run, 'start-dev-server')).toBe('failed');
      expect(run.phases[0]!.reason).toContain('port 8081 is taken');
      expect(run.started).toBe(false);
      expect(run.environment.devServer).toBe('failed');
    });
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §The run brings its own environment.
  // Start what is missing, stop only what this run started, and leave what was already there.
  describe('the environment this run brings', () => {
    /** A machine with nothing on it: no dev server, and no device. */
    function bareMachine({
      bootDevice,
      ...overrides
    }: Partial<SmokeDeps> = {}): Partial<SmokeDeps> {
      let reachable = false;
      const device = bootableDevice(bootDevice);
      return {
        discoverDevServer: async () => {
          const found = discovery({ reachable });
          reachable = true;
          return found;
        },
        ...device,
        // Nothing is attached until the run opens the app on the simulator it booted.
        waitForAppConnection: async () => ({
          appsConnected: (await device.probeDevice()).deviceId ? 1 : 0,
          timedOut: false,
          waitedMs: 3,
          skippedApps: [],
        }),
        ...overrides,
      };
    }

    it(`starts the dev server and boots a device, then releases the device through dev:stop`, async () => {
      const stopDevServer = vi.fn(async () => ({
        ok: true,
        target: 'http://127.0.0.1:8081',
        reason: null,
      }));

      const run = await runSmokePhasesAsync(
        deps({ ...bareMachine(), stopDevServer }),
        options({ bootstrap: true })
      );

      expect(run.environment.devServer).toBe('started');
      expect(run.environment.device).toBe('booted');
      expect(stopDevServer).toHaveBeenCalled();
      // dev:stop owns the device release after its child exits; no second device cleanup.
      expect(run.environment.cleanup.map((entry) => entry.resource)).toEqual(['dev-server']);
    });

    it.each([
      ['started', {}],
      ['reused', { discoverDevServer: async () => discovery() }],
    ] as const)(
      'names the device it bound and its release, after a %s dev server',
      async (_, server) => {
        const released = {
          backend: 'local-ios' as const,
          platform: 'ios' as const,
          id: 'SIM-BOOTED',
          name: 'agent-cli 0000',
          released: true,
          shutDown: true,
          reason: null,
        };
        const run = await runSmokePhasesAsync(
          deps({
            ...bareMachine({
              ...server,
              bootDevice: async () => ({
                ok: true,
                deviceId: 'SIM-BOOTED',
                backend: 'local-ios' as const,
                reason: null,
                bound: { name: 'agent-cli 0000', action: 'created' as const },
              }),
            }),
            stopDevServer: async () => ({
              ok: true,
              target: 'http://127.0.0.1:8081',
              reason: null,
              devices: [released],
            }),
            releaseDevice: async () => ({
              ok: true,
              target: 'SIM-BOOTED',
              reason: null,
              devices: [released],
            }),
          }),
          options({ bootstrap: true })
        );

        expect(run.environment.boundDevice).toEqual({
          id: 'SIM-BOOTED',
          name: 'agent-cli 0000',
          action: 'created',
          released: true,
          shutDown: true,
        });
      }
    );

    it('names the device its started dev server bound, and lists the release dev:stop did', async () => {
      const released = {
        backend: 'local-android' as const,
        platform: 'android' as const,
        id: 'emulator-5556',
        name: 'emulator-5556',
        released: true,
        shutDown: true,
        reason: null,
      };
      const bootDevice = vi.fn();
      const run = await runSmokePhasesAsync(
        deps({
          ...bareMachine({
            probeDevice: async () => ({
              deviceId: 'emulator-5556',
              backend: 'local-ios' as const,
              reason: null,
            }),
            bootDevice,
          }),
          startDevServer: async () => ({
            ok: true,
            devServerUrl: 'http://127.0.0.1:8081',
            reason: null,
            bound: { id: 'emulator-5556', name: 'emulator-5556', action: 'spawned' as const },
          }),
          stopDevServer: async () => ({
            ok: true,
            target: 'http://127.0.0.1:8081',
            reason: null,
            devices: [released],
          }),
        }),
        options({ bootstrap: true, platform: 'android' })
      );

      expect(bootDevice).not.toHaveBeenCalled();
      expect(run.environment.device).toBe('reused');
      expect(run.environment.boundDevice).toEqual({
        id: 'emulator-5556',
        name: 'emulator-5556',
        action: 'spawned',
        released: true,
        shutDown: true,
      });
      expect(
        run.environment.cleanup.map(({ resource, target, ok }) => [resource, target, ok])
      ).toEqual([
        ['dev-server', 'http://127.0.0.1:8081', true],
        ['device', 'emulator-5556', true],
      ]);
    });

    it('lists a device dev:stop kept as a cleanup row that is not ok, with the refusal as its reason', async () => {
      const kept = {
        backend: 'local-android' as const,
        platform: 'android' as const,
        id: 'emulator-5556',
        name: 'emulator-5556',
        released: null,
        shutDown: false,
        reason: "Devices were kept because this worktree's dev server is still running.",
      };
      const run = await runSmokePhasesAsync(
        deps({
          ...bareMachine({
            probeDevice: async () => ({
              deviceId: 'emulator-5556',
              backend: 'local-ios' as const,
              reason: null,
            }),
            bootDevice: vi.fn(),
          }),
          startDevServer: async () => ({
            ok: true,
            devServerUrl: 'http://127.0.0.1:8081',
            reason: null,
            bound: { id: 'emulator-5556', name: 'emulator-5556', action: 'spawned' as const },
          }),
          stopDevServer: async () => ({
            ok: true,
            target: 'http://127.0.0.1:8081',
            reason: null,
            devices: [kept],
          }),
        }),
        options({ bootstrap: true, platform: 'android' })
      );

      expect(run.environment.cleanup).toContainEqual(
        expect.objectContaining({
          resource: 'device',
          target: 'emulator-5556',
          ok: false,
          reason: kept.reason,
        })
      );
      expect(run.environment.boundDevice).toMatchObject({ released: null });
    });

    it('keeps the device its started dev server found bound and up before the run', async () => {
      const run = await runSmokePhasesAsync(
        deps({
          ...bareMachine({
            probeDevice: async () => ({
              deviceId: 'SIM-UP',
              backend: 'local-ios' as const,
              reason: null,
            }),
          }),
          startDevServer: async () => ({
            ok: true,
            devServerUrl: 'http://127.0.0.1:8081',
            reason: null,
            bound: { id: 'SIM-UP', name: 'agent-cli f5ce27a6', action: 'existing' as const },
          }),
        }),
        options({ bootstrap: true })
      );

      expect(run.environment.boundDevice).toEqual({
        id: 'SIM-UP',
        name: 'agent-cli f5ce27a6',
        action: 'existing',
        released: null,
        shutDown: false,
      });
      expect(run.environment.cleanup.map(({ resource }) => resource)).toEqual(['dev-server']);
    });

    it.each([
      ['the device its started dev server bound, which the run releases', true, false],
      ['a device this run did not bind', false, true],
    ] as const)(
      `says it left the app it installed on %s only when the device stays`,
      async (_, bound, left) => {
        const run = await runSmokePhasesAsync(
          deps({
            ...bareMachine({
              probeDevice: async () => ({
                deviceId: 'emulator-5556',
                backend: 'local-android' as const,
                reason: null,
              }),
            }),
            startDevServer: async () => ({
              ok: true,
              devServerUrl: 'http://127.0.0.1:8081',
              reason: null,
              bound: bound
                ? { id: 'emulator-5556', name: 'emulator-5556', action: 'spawned' as const }
                : undefined,
            }),
            installNeededOnDevice: async () => true,
          }),
          options({ bootstrap: true, platform: 'android' })
        );

        const install = run.phases.find((phase) => phase.id === 'install-app')?.reason;
        expect(install).toContain('installed the app on emulator-5556');
        expect(install?.includes('left it there')).toBe(left);
      }
    );

    it('releases its own boot after a reused server, without stopping that server', async () => {
      const releaseDevice = vi.fn(async () => ({ ok: true, target: 'SIM-BOOTED', reason: null }));
      const stopDevServer = vi.fn();
      const run = await runSmokePhasesAsync(
        deps({
          ...bareMachine({ discoverDevServer: async () => discovery() }),
          releaseDevice,
          stopDevServer,
        }),
        options({ bootstrap: true })
      );
      expect(releaseDevice).toHaveBeenCalledTimes(1);
      expect(stopDevServer).not.toHaveBeenCalled();
      expect(run.environment.cleanup.map((entry) => entry.resource)).toEqual(['device']);
    });

    it('no-start binds and releases nothing', async () => {
      const bootDevice = vi.fn();
      const releaseDevice = vi.fn();
      const stopDevServer = vi.fn();
      await runSmokePhasesAsync(
        deps({ bootDevice, releaseDevice, stopDevServer }),
        options({ bootstrap: false })
      );
      expect(bootDevice).not.toHaveBeenCalled();
      expect(releaseDevice).not.toHaveBeenCalled();
      expect(stopDevServer).not.toHaveBeenCalled();
    });

    it(`leaves a dev server and a device it found, and cleans nothing up`, async () => {
      const stopDevServer = vi.fn();

      const run = await runSmokePhasesAsync(deps({ stopDevServer }), options({ bootstrap: true }));

      expect(run.environment.devServer).toBe('reused');
      expect(run.environment.device).toBe('reused');
      expect(stopDevServer).not.toHaveBeenCalled();
      expect(run.environment.cleanup).toEqual([]);
      // Neither bootstrap phase happened, so neither is reported — a `skipped` row for a step
      // nothing needed reads as a step that was owed and not done.
      expect(statusOf(run, 'start-dev-server')).toBeUndefined();
      expect(statusOf(run, 'boot-device')).toBeUndefined();
    });

    it.each([
      ['the device it found', 'SIM-1', { action: 'existing', released: null, shutDown: false }],
      ['no device for a binding of another device', 'SIM-OTHER', null],
    ] as const)(`names this worktree's binding when it reuses %s`, async (_, id, expected) => {
      const run = await runSmokePhasesAsync(
        deps({ readBoundDevice: () => ({ id, name: 'dogfood-explicit' }) }),
        options({ bootstrap: true })
      );

      expect(run.environment.device).toBe('reused');
      expect(run.environment.boundDevice).toEqual(
        expected && { id, name: 'dogfood-explicit', ...expected }
      );
      expect(run.environment.cleanup).toEqual([]);
    });

    it(`boots nothing when the caller named the cloud as the device`, async () => {
      const bootDevice = vi.fn();
      const run = await runSmokePhasesAsync(
        deps({
          ...bareMachine(),
          cloudRoute: { current: 'required' },
          bootDevice,
          probeDevice: async () => ({
            deviceId: 'sess-live',
            backend: 'cloud' as const,
            reason: null,
          }),
          waitForAppConnection: async () => ({
            appsConnected: 1,
            timedOut: false,
            waitedMs: 3,
            skippedApps: [],
          }),
        }),
        options({ bootstrap: true, cloud: 'required' })
      );

      expect(bootDevice).not.toHaveBeenCalled();
      expect(statusOf(run, 'start-session')).toBe('ok');
      expect(run.environment.device).toBe('reused');
    });

    // A phone on the same network is a device this machine's tools cannot see and a *connected app*
    // all the same. Booting a simulator for it would spend a minute and then photograph an empty
    // screen to answer for the app that is really running.
    it(`boots nothing when an app is already attached`, async () => {
      const bootDevice = vi.fn();
      const run = await runSmokePhasesAsync(
        deps({
          bootDevice,
          probeDevice: async () => ({ deviceId: null, backend: null, reason: 'no simulator' }),
          waitForAppConnection: async () => ({
            appsConnected: 1,
            timedOut: false,
            waitedMs: 3,
            skippedApps: [],
          }),
        }),
        options({ bootstrap: true })
      );

      expect(bootDevice).not.toHaveBeenCalled();
      expect(run.environment.device).toBe('absent');
      expect(statusOf(run, 'boot-device')).toBeUndefined();
    });

    // @ref llp/0035-one-device-per-worktree.rfc.md §Lifecycle smoke — the simulator is this worktree's bound one, so
    // nothing is registered to shut it down, and the phase says nothing about putting it back.
    it(`keeps a bound simulator that registered no cleanup, and says so`, async () => {
      const run = await runSmokePhasesAsync(
        deps({
          ...bareMachine({
            bootDevice: async () => ({
              ok: true,
              deviceId: 'SIM-BOUND',
              backend: 'local-ios' as const,
              reason: null,
              choice: 'agent-cli 0000',
              bound: { name: 'agent-cli 0000', action: 'created' as const },
            }),
            installNeededOnDevice: async (_deviceId, _backend, createdByBoot) => createdByBoot,
          }),
        }),
        options({ bootstrap: true })
      );

      expect(run.environment.device).toBe('booted');
      expect(run.environment.deviceChoice).toBe('agent-cli 0000');
      const reason = run.phases.find((phase) => phase.id === 'boot-device')?.reason;
      expect(reason).toContain('booted SIM-BOUND for this run because agent-cli 0000');
      expect(reason).not.toContain('shut it down');
      expect(run.environment.cleanup.map((entry) => entry.resource)).toEqual(['dev-server']);
      // A created simulator has no app, and its disk holds nothing to read.
      expect(statusOf(run, 'install-app')).toBe('ok');
    });

    it(`says why it chose the emulator instance it booted, and keeps it bound`, async () => {
      const run = await runSmokePhasesAsync(
        deps({
          ...bareMachine({
            bootDevice: async () => ({
              ok: true,
              deviceId: 'emulator-5554',
              backend: 'local-android' as const,
              reason: null,
              choice: 'Pixel_9',
            }),
          }),
        }),
        options({ bootstrap: true })
      );

      expect(run.environment.deviceChoice).toBe('Pixel_9');
      const reason = run.phases.find((phase) => phase.id === 'boot-device')?.reason;
      expect(reason).toBe('booted emulator-5554 for this run because Pixel_9');
      expect(run.environment.cleanup.map((entry) => entry.resource)).toEqual(['dev-server']);
    });

    it(`fails the boot phase when the device would not come up, and skips what needed it`, async () => {
      const run = await runSmokePhasesAsync(
        deps({
          ...bareMachine({
            bootDevice: async () => ({
              ok: false,
              deviceId: null,
              backend: null,
              reason: 'no iOS runtime is installed',
            }),
          }),
        }),
        options({ bootstrap: true })
      );

      expect(run.outcome).toBe('failed');
      expect(statusOf(run, 'boot-device')).toBe('failed');
      expect(run.environment.device).toBe('failed');
      for (const id of ['app', 'route', 'runtime', 'errors', 'screenshot'] as SmokePhaseId[]) {
        expect(statusOf(run, id)).toBe('skipped');
      }
      // The dev server this run started still goes back, on the failing path.
      expect(run.environment.cleanup.map((entry) => entry.resource)).toEqual(['dev-server']);
    });

    // Registered before the resource is started, so a start that half-worked — a child that
    // published its lock and then died in the readiness wait — is still cleaned up.
    it(`stops a dev server whose start it could not finish`, async () => {
      const stopDevServer = vi.fn(async () => ({ ok: true, target: null, reason: null }));
      await runSmokePhasesAsync(
        deps({
          discoverDevServer: async () => discovery({ reachable: false }),
          startDevServer: async () => ({
            ok: false,
            devServerUrl: 'http://127.0.0.1:8081',
            reason: 'its bundler never answered',
          }),
          stopDevServer,
        }),
        options({ bootstrap: true })
      );

      expect(stopDevServer).toHaveBeenCalled();
    });

    // Reported, never swallowed: a leaked dev server is the caller's problem the moment they run
    // anything else, and a run that hid it would have them debug a port they never started.
    it(`reports a cleanup that failed, and keeps the verdict about the app`, async () => {
      const run = await runSmokePhasesAsync(
        deps({
          ...bareMachine(),
          stopDevServer: async () => ({
            ok: false,
            target: 'http://127.0.0.1:8081',
            reason: 'SIGTERM was sent to 4242 and it was still running',
          }),
        }),
        options({ bootstrap: true })
      );

      expect(run.outcome).toBe('passed');
      expect(run.environment.cleanup).toContainEqual(
        expect.objectContaining({
          resource: 'dev-server',
          ok: false,
          reason: expect.stringContaining('still running'),
        })
      );
    });

    // `--no-start` is the run this command used to be, and it has to stay reachable: a caller
    // verifying the dev server *they* started must not have one started for them.
    it(`starts and boots nothing with --no-start`, async () => {
      const startDevServer = vi.fn();
      const bootDevice = vi.fn();
      const run = await runSmokePhasesAsync(
        deps({ ...bareMachine(), startDevServer, bootDevice }),
        options({ bootstrap: false })
      );

      expect(run.outcome).toBe('failed');
      expect(startDevServer).not.toHaveBeenCalled();
      expect(bootDevice).not.toHaveBeenCalled();
      expect(run.environment).toMatchObject({ devServer: 'absent', device: 'absent', cleanup: [] });
    });

    // The bootstrap is not charged to `--timeout`: a cold simulator takes a minute to boot, and a
    // budget that paid for it would leave the phases the budget is *about* with nothing.
    it(`spends the bootstrap outside the run's budget`, async () => {
      let clock = 0;
      const budgets: number[] = [];
      let booted = false;
      const run = await runSmokePhasesAsync(
        deps({
          discoverDevServer: async () => discovery(),
          probeDevice: async () => ({
            deviceId: booted ? 'SIM-BOOTED' : null,
            backend: booted ? ('local-ios' as const) : null,
            reason: booted ? null : 'no simulator',
          }),
          // A boot that costs a minute of the clock this run reads.
          bootDevice: async () => {
            clock += 60_000;
            booted = true;
            return {
              ok: true,
              deviceId: 'SIM-BOOTED',
              backend: 'local-ios' as const,
              reason: null,
            };
          },
          waitForAppConnection: async (_url, timeoutMs) => {
            budgets.push(timeoutMs);
            // Nothing until the run opened the app on the device it booted.
            return { appsConnected: booted ? 1 : 0, timedOut: false, waitedMs: 3, skippedApps: [] };
          },
          now: () => (clock += 10),
        }),
        options({ bootstrap: true, timeoutMs: 60_000 })
      );

      expect(run.outcome).toBe('passed');
      expect(run.environment.device).toBe('booted');
      // The wait after the app was opened is the first one the boot could have eaten, and it still
      // has most of the minute the caller asked for.
      expect(budgets[1]).toBeGreaterThan(50_000);
    });
  });
});

// @ref llp/0010-agent-conventions.rfc.md §Exit codes. Three answers, three codes, and the split
// between the last two is the whole reason the band exists: after `20` the next action is to fix
// something, and after `22` it is to look again. One test asserting "some non-zero code" would
// pass while the distinction was broken.
describe(smokeExitCode, () => {
  it.each([
    ['passed', 0],
    ['failed', 20],
    ['inconclusive', 22],
  ] as const)(`answers %s with %i`, (outcome, code) => {
    expect(smokeExitCode(outcome)).toBe(code);
  });

  it(`never answers 1, which is reserved for the command itself being wrong`, () => {
    for (const outcome of ['passed', 'failed', 'inconclusive'] as const) {
      expect(smokeExitCode(outcome)).not.toBe(1);
    }
  });

  // The end-to-end binding: a run's verdict and the code it leaves with are one decision.
  it.each([
    [{}, 0],
    [{ collectErrors: async () => ({ ok: true, records: [record()], reason: null }) }, 20],
    [{ checkEntryBundle: async () => bundle({ outcome: 'broken' }) }, 20],
    [{ discoverDevServer: async () => discovery({ reachable: false }) }, 20],
    [
      {
        evaluate: async () => ({ ok: false, unsupported: true, reason: 'method not found' }),
        now: steppingClock(RUNTIME_UNSUPPORTED_GRACE_MS),
      },
      22,
    ],
    [{ checkEntryBundle: async () => bundle({ outcome: 'timeout' }) }, 22],
    [
      {
        waitForAppConnection: async () => ({
          appsConnected: 0,
          timedOut: true,
          waitedMs: 1,
          skippedApps: [],
        }),
        probeDevice: async () => ({ deviceId: null, backend: null, reason: 'no simulator' }),
      },
      22,
    ],
  ])(`exits %#, which is code %i`, async (overrides, code) => {
    const run = await runSmokePhasesAsync(deps(overrides as Partial<SmokeDeps>), options());
    expect(smokeExitCode(run.outcome)).toBe(code);
  });
});
