// @ref llp/0005-runtime-loop-tools.rfc.md §The smoke gate
//
// The outcome table of `runSmokePhasesAsync`: narration, an app that never attached, a refused
// link, and an EAS session. The rest of the table is in the other `phases*-test.ts` files, and the
// fakes are in `./phasesFixtures.ts`.

import type { SmokeDeps } from '../contract';
import { runSmokePhasesAsync } from '../phases';
import type { SmokeOptions } from '../resolveOptions';
import type { SmokePhaseId } from '../types';
import {
  options,
  discovery,
  bundle,
  opened,
  deps,
  bootableDevice,
  statusOf,
} from './phasesFixtures';

// @ref llp/0005-runtime-loop-tools.rfc.md §The gate says what it is doing while it does it
//
// The gate can spend three minutes between its first output and its report, and until it narrated
// itself a caller had no way to tell a long run from a hung one. What is worth pinning here is not
// the prose — that is `./progress-test.ts` — but that the walk says a phase is starting **before**
// it starts it, and that it says nothing about a phase it did not perform.
describe(`${runSmokePhasesAsync.name} and what it says while it runs`, () => {
  /** Every phase the walk narrated, in the order it narrated them. */
  function narrated(overrides: Partial<SmokeDeps> = {}, over: Partial<SmokeOptions> = {}) {
    const said: SmokePhaseId[] = [];
    return {
      said,
      runAsync: () =>
        runSmokePhasesAsync(
          deps({ progress: (phase) => said.push(phase), ...overrides }),
          options(over)
        ),
    };
  }

  it(`names every phase it performs, in the order it performs them`, async () => {
    const { said, runAsync } = narrated({}, { route: '/notes' });
    await runAsync();

    // No `start-dev-server` and no `boot-device`: the default machine has both already, which is
    // the same reason those rows are absent from the report (@ref ../walk/walk §CONDITIONAL_PHASES).
    expect(said).toEqual([
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
  });

  // Said before the work rather than after it: a line's only job is to name the wait the caller is
  // in, and one printed on the way out would arrive at the moment it stopped being needed.
  it(`says a phase is starting before that phase runs`, async () => {
    const order: string[] = [];
    await runSmokePhasesAsync(
      deps({
        progress: (phase) => order.push(`say:${phase}`),
        checkEntryBundle: async () => {
          order.push('do:bundle');
          return bundle();
        },
      }),
      options()
    );

    expect(order.indexOf('say:bundle')).toBeLessThan(order.indexOf('do:bundle'));
  });

  // The acts, which only a run that performs them reports — and only such a run narrates.
  it(`names the start, the boot and the install only when it does them`, async () => {
    // Nothing there to begin with and a dev server there afterwards, which is what makes the run
    // perform the start rather than report that nothing answered.
    let looks = 0;
    const { said, runAsync } = narrated(
      {
        discoverDevServer: async () => discovery({ reachable: looks++ > 0 }),
        waitForAppConnection: async () => ({
          appsConnected: 0,
          timedOut: true,
          waitedMs: 1,
          skippedApps: [],
        }),
        ...bootableDevice(),
        installNeededOnDevice: async () => true,
      },
      // The three acts are only performed by a run allowed to bring its own environment, and this
      // table defaults that off (@ref ./phasesFixtures §options).
      { bootstrap: true }
    );
    await runAsync();

    expect(said.slice(0, 2)).toEqual(['dev-server', 'start-dev-server']);
    expect(said).toContain('boot-device');
    expect(said).toContain('install-app');
  });

  // And a machine that has both says neither, for the same reason the report has no row for them:
  // there was nothing to do, which is not the same as something skipped
  // (@ref ../walk/walk §CONDITIONAL_PHASES).
  it(`says nothing about an act it had no need to perform`, async () => {
    const { said, runAsync } = narrated({}, { bootstrap: true });
    await runAsync();

    expect(said).not.toContain('start-dev-server');
    expect(said).not.toContain('boot-device');
    expect(said).not.toContain('install-app');
  });

  // @ref ../progress §phaseSentence. The `app` phase is two things — a two-second look, then an
  // open and a wait that on a cold environment is two minutes — so it says two lines, and the
  // budget on the second is what makes them read differently.
  it(`says the app phase twice when it has to open the app, with the wait's budget`, async () => {
    const budgets: (number | null)[] = [];
    await runSmokePhasesAsync(
      deps({
        progress: (phase, budgetMs) => {
          if (phase === 'app') {
            budgets.push(budgetMs);
          }
        },
        // Nothing attached, so the phase opens one and waits.
        waitForAppConnection: async () => ({
          appsConnected: 0,
          timedOut: true,
          waitedMs: 1,
          skippedApps: [],
        }),
      }),
      options()
    );

    expect(budgets).toHaveLength(2);
    expect(budgets[0]).toBeNull();
    expect(budgets[1]).toBeGreaterThan(0);
  });

  // And once when it does not: an app that is already attached is the phase's cheap half only.
  it(`says the app phase once when an app is already attached`, async () => {
    const { said, runAsync } = narrated();
    await runAsync();

    expect(said.filter((phase) => phase === 'app')).toEqual(['app']);
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §The Expo Go on the device is not the Expo Go the SDK wants
// @ref ../contract §SmokeDeps.explainSilentApp
//
// Nothing attached is a symptom, and the device often holds the cause. Found live and at full
// price: an emulator holding Expo Go 54.0.8, a project on SDK 57, and **119 seconds** spent to
// report `no app had attached when the budget ran out` — while the reason sat on the device the
// whole time, and the follow-ups went on to suggest opening the app again, which would fail the
// same way for ever [observed — emulator-5554, 2026-09-04].
describe(`${runSmokePhasesAsync.name} and an app that never attached`, () => {
  const SILENT = {
    mismatch: 'the Expo Go on the device is 54.0.8, and 57.0.9 is the release this SDK ships',
    kind: 'expo-go-version' as const,
    note: null,
  };

  /** A run whose app never turns up, which is the only path this question is asked on. */
  function nothingAttaches(overrides: Partial<SmokeDeps> = {}) {
    return deps({
      waitForAppConnection: async () => ({
        appsConnected: 0,
        timedOut: true,
        waitedMs: 1,
        skippedApps: [],
      }),
      ...overrides,
    });
  }

  it(`names the device-side reason beside the wait that expired`, async () => {
    const run = await runSmokePhasesAsync(
      nothingAttaches({ explainSilentApp: async () => SILENT }),
      options()
    );

    const app = run.phases.find((phase) => phase.id === 'app')!;
    // Both: the phase measured that the link was opened and nothing came of it, and the device
    // says why. The second without the first would not say that the open itself succeeded.
    expect(app.reason).toContain('no app had attached');
    expect(app.reason).toContain('54.0.8');
  });

  // Reported as a fact and not only as a sentence, so the follow-ups can lead with the command that
  // fixes it rather than with "open the app again" (llp/0021 §The rules).
  it(`carries the finding as a value the follow-ups can branch on`, async () => {
    const run = await runSmokePhasesAsync(
      nothingAttaches({ explainSilentApp: async () => SILENT }),
      options()
    );

    expect(run.appMismatch).toContain('54.0.8');
    expect(run.appMismatchKind).toBe('expo-go-version');
  });

  // The ordinary answer, and the one that must not be dressed up: a slow app is not a wrong app.
  it(`says nothing extra when the device explains nothing`, async () => {
    const run = await runSmokePhasesAsync(
      nothingAttaches({ explainSilentApp: async () => null }),
      options()
    );

    expect(run.appMismatch).toBeNull();
    expect(run.appMismatchKind).toBeNull();
    expect(run.phases.find((phase) => phase.id === 'app')?.reason).toContain('no app had attached');
  });

  // Never on the healthy path. The question costs an `adb` call or a `plutil` read, and a run whose
  // app answered has nothing for it to explain.
  it(`never asks the device when an app did attach`, async () => {
    let asked = false;
    await runSmokePhasesAsync(
      deps({
        explainSilentApp: async () => {
          asked = true;
          return null;
        },
      }),
      options()
    );

    expect(asked).toBe(false);
  });

  // The device this run settled on, handed over rather than resolved again: a second resolution
  // would be a second chance for the run to be about two devices (F98).
  it(`asks about the device the run is about`, async () => {
    const asked: (string | null)[] = [];
    await runSmokePhasesAsync(
      nothingAttaches({
        explainSilentApp: async (deviceId) => {
          asked.push(deviceId);
          return null;
        },
      }),
      options()
    );

    expect(asked).toEqual(['SIM-1']);
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §A refused link is a device without the app
//
// The device refused this run's deep link. Two things went wrong in that report and both were found
// in one live run [observed — Kudo, 2026-09-04, a development build and a simulator that had not got
// it]: the screenshot was captioned as the dev launcher's screen when nothing had been opened at
// all, and the reason said only that the device refused the link — which reads as a fault in the
// device, and sent the reader to `navigate`, refused identically for ever.
describe(`${runSmokePhasesAsync.name} and a device that refused the link`, () => {
  const NOT_INSTALLED = {
    mismatch: 'the app this project runs (com.example.app) is not installed on SIM-1',
    kind: 'app-not-installed' as const,
    note: null,
  };

  /** A run whose deep link is refused, the way `simctl openurl` refuses one with `115`. */
  function refused(overrides: Partial<SmokeDeps> = {}) {
    return deps({
      waitForAppConnection: async () => ({
        appsConnected: 0,
        timedOut: true,
        waitedMs: 1,
        skippedApps: [],
      }),
      openRoute: async (route) =>
        opened({
          route,
          exitCode: 115,
          // The launcher link was refused too — same scheme, same missing app. This is the shape
          // that made the caption lie: a refused launcher open also reports `attached: false`.
          launch: {
            url: 'com.example.app://?__expo_url=http%3A%2F%2F127.0.0.1%3A8081',
            command: 'xcrun simctl openurl SIM-1 …',
            exitCode: 115,
            attached: false,
            waitedMs: 0,
          },
        }),
      ...overrides,
    });
  }

  // The bug that matters most, because a picture is the one piece of evidence a reader believes
  // without checking it (llp/0021 §The rules).
  it(`never says the dev launcher is on screen when the launch was refused`, async () => {
    const run = await runSmokePhasesAsync(
      refused({ explainSilentApp: async () => NOT_INSTALLED }),
      options()
    );

    const shot = run.phases.find((phase) => phase.id === 'screenshot')!;
    expect(shot.reason).not.toContain('dev launcher');
    expect(shot.reason).not.toContain('the loading link was opened');
    // What it is a picture of instead: the device, with nothing of this project on it.
    expect(shot.reason).toContain("the device's screen");
  });

  // And the caption is still right for the state it was written for: a launcher open that
  // **succeeded** and left the launcher's own screen up because the bundle never arrived.
  it(`still says so for a launch that was opened and never loaded`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        waitForAppConnection: async () => ({
          appsConnected: 0,
          timedOut: true,
          waitedMs: 1,
          skippedApps: [],
        }),
        openRoute: async (route) =>
          opened({
            route,
            launch: {
              url: 'com.example.app://?__expo_url=http%3A%2F%2F127.0.0.1%3A8081',
              command: 'xcrun simctl openurl SIM-1 …',
              exitCode: 0,
              attached: false,
              waitedMs: 1_000,
            },
          }),
      }),
      options()
    );

    expect(run.phases.find((phase) => phase.id === 'screenshot')?.reason).toContain('dev launcher');
  });

  it(`names why the device refused it, beside the refusal itself`, async () => {
    const run = await runSmokePhasesAsync(
      refused({ explainSilentApp: async () => NOT_INSTALLED }),
      options()
    );

    const app = run.phases.find((phase) => phase.id === 'app')!;
    // Both: what the device did, and why it did it.
    expect(app.reason).toContain('refused the deep link');
    expect(app.reason).toContain('is not installed on SIM-1');
    // Once, not twice — the no-attach branch below must not append the same finding again.
    expect(app.reason!.match(/is not installed/g)).toHaveLength(1);
  });

  it(`carries the finding as a value the follow-ups can branch on`, async () => {
    const run = await runSmokePhasesAsync(
      refused({ explainSilentApp: async () => NOT_INSTALLED }),
      options()
    );

    expect(run.appMismatchKind).toBe('app-not-installed');
  });

  // A device read that answered nothing adds nothing: the refusal is still reported, on its own.
  it(`reports the refusal alone when the device explains nothing`, async () => {
    const run = await runSmokePhasesAsync(
      refused({ explainSilentApp: async () => null }),
      options()
    );

    const app = run.phases.find((phase) => phase.id === 'app')!;
    expect(app.reason).toContain('refused the deep link');
    expect(app.status).toBe('failed');
    expect(run.appMismatchKind).toBeNull();
  });

  // The device the open actually used, handed over rather than resolved again (F98).
  it(`asks about the device the open was performed on`, async () => {
    const asked: (string | null)[] = [];
    await runSmokePhasesAsync(
      refused({
        explainSilentApp: async (deviceId) => {
          asked.push(deviceId);
          return null;
        },
      }),
      options()
    );

    expect(asked).toEqual(['SIM-1']);
  });
});

// @ref llp/0027-everything-on-eas.rfc.md §smoke
// The EAS device's bootstrap: a session instead of a boot. Conditional like the boot, cleaned up
// like the boot, and a run that cannot reach one stops at the same place a run with no device does.
describe('the start-session phase, on --eas', () => {
  const cloudDeps = (overrides: Partial<SmokeDeps> = {}) =>
    deps({
      cloudRoute: { current: 'required' },
      probeDevice: async () => ({ deviceId: 'sess-up', backend: 'cloud' as const, reason: null }),
      waitForAppConnection: async () => ({
        appsConnected: 1,
        timedOut: false,
        waitedMs: 3,
        skippedApps: [],
      }),
      ...overrides,
    });

  it(`records a session this run started, and ends it again afterwards`, async () => {
    const stopEasSession = vi.fn(async (sessionId: string) => ({
      ok: true,
      target: sessionId,
      reason: null,
    }));
    const run = await runSmokePhasesAsync(
      cloudDeps({
        ensureEasSession: async () => ({
          ok: true,
          sessionId: 'sess-new',
          started: true,
          reason: null,
        }),
        stopEasSession,
      }),
      options({ bootstrap: true, cloud: 'required' })
    );

    expect(statusOf(run, 'start-session')).toBe('ok');
    expect(run.phases.find((phase) => phase.id === 'start-session')?.reason).toContain(
      'started EAS Simulator session sess-new for this run'
    );
    expect(run.environment.device).toBe('booted');
    expect(stopEasSession).toHaveBeenCalledWith('sess-new');
  });

  it('cleans up a created session even when readiness fails', async () => {
    const stopEasSession = vi.fn(async (sessionId: string) => ({
      ok: true,
      target: sessionId,
      reason: null,
    }));
    const run = await runSmokePhasesAsync(
      cloudDeps({
        ensureEasSession: async () => ({
          ok: false,
          sessionId: 'sess-billed',
          started: true,
          reason: 'readiness timed out',
        }),
        stopEasSession,
      }),
      options({ bootstrap: true, cloud: 'required' })
    );
    expect(run.outcome).toBe('failed');
    expect(stopEasSession).toHaveBeenCalledWith('sess-billed');
    expect(run.environment.cleanup).toContainEqual(
      expect.objectContaining({ resource: 'session', target: 'sess-billed', ok: true })
    );
  });

  it('does not claim a session stopped when cleanup fails', async () => {
    const run = await runSmokePhasesAsync(
      cloudDeps({
        ensureEasSession: async () => ({
          ok: true,
          sessionId: 'sess-new',
          started: true,
          reason: null,
        }),
        stopEasSession: async () => ({ ok: false, target: 'sess-new', reason: 'offline' }),
      }),
      options({ bootstrap: true, cloud: 'required' })
    );
    expect(run.phases.find((phase) => phase.id === 'start-session')?.reason).not.toContain(
      'stopped'
    );
    expect(run.environment.cleanup).toContainEqual(
      expect.objectContaining({ resource: 'session', ok: false })
    );
  });

  it.each([true, false])(
    'reloads an attached EAS app only when the session was reused (started: %s)',
    async (started) => {
      const reloadApp = vi.fn(async () => ({
        ok: true,
        verifiedBy: 'fresh-debugger-target' as const,
        knownTargetIds: ['old'],
        freshTargets: 1,
        commandSocketReconnected: false,
        targetOutcomes: [],
        bundleServed: false,
        reason: null,
      }));
      const openRoute = vi.fn(async (route: string) =>
        opened({ route, deviceId: 'sess-up', deviceBackend: 'cloud' })
      );
      const run = await runSmokePhasesAsync(
        cloudDeps({
          ensureEasSession: async () => ({ ok: true, sessionId: 'sess-up', started, reason: null }),
          openRoute,
          reloadApp,
        }),
        options({ bootstrap: true, cloud: 'required' })
      );
      expect(openRoute).toHaveBeenCalledTimes(started ? 1 : 0);
      expect(reloadApp).toHaveBeenCalledTimes(started ? 0 : 1);
      expect(statusOf(run, 'reload')).toBe(started ? 'skipped' : 'ok');
    }
  );

  it(`records a session that was already up, and leaves it running`, async () => {
    const stopEasSession = vi.fn();
    const run = await runSmokePhasesAsync(
      cloudDeps({
        ensureEasSession: async () => ({
          ok: true,
          sessionId: 'sess-up',
          started: false,
          reason: null,
        }),
        stopEasSession,
      }),
      options({ bootstrap: true, cloud: 'required' })
    );

    expect(statusOf(run, 'start-session')).toBe('ok');
    expect(run.environment.device).toBe('reused');
    expect(stopEasSession).not.toHaveBeenCalled();
  });

  it(`stops the run where a missing device stops it when no session can be reached`, async () => {
    const run = await runSmokePhasesAsync(
      cloudDeps({
        ensureEasSession: async () => ({
          ok: false,
          sessionId: null,
          started: false,
          reason: 'no EAS Simulator session is up, and EAS has no finished build to start one with',
        }),
      }),
      options({ bootstrap: true, cloud: 'required' })
    );

    expect(run.outcome).toBe('failed');
    expect(statusOf(run, 'start-session')).toBe('failed');
    expect(run.phases.find((phase) => phase.id === 'start-session')?.reason).toContain(
      'no finished build'
    );
    expect(statusOf(run, 'app')).toBe('skipped');
    expect(run.environment.device).toBe('failed');
  });

  // @ref llp/0015-backend-selection-and-config.rfc.md §The device backend
  it(`moves a config EAS run to the session only when it starts the dev server`, async () => {
    const ensureEasSession = vi.fn(async () => ({
      ok: true,
      sessionId: 'sess-new',
      started: true,
      reason: null,
    }));
    let looks = 0;
    const discoverDevServer = async () => discovery({ reachable: looks++ > 0 });
    const startDevServer = vi.fn(async () => ({
      ok: true,
      devServerUrl: 'http://127.0.0.1:8081',
      built: false,
      reason: null,
    }));
    const starting = options({ bootstrap: true, configuredEas: true });
    const run = await runSmokePhasesAsync(
      cloudDeps({
        cloudRoute: { current: 'fallback' },
        ensureEasSession,
        discoverDevServer,
        startDevServer,
      }),
      starting
    );
    expect(startDevServer).toHaveBeenCalled();
    expect(run.cloudRoute).toBe('required');
    expect(statusOf(run, 'start-session')).toBe('ok');

    ensureEasSession.mockClear();
    const reusing = options({ bootstrap: true, configuredEas: true });
    const reused = await runSmokePhasesAsync(deps({ ensureEasSession }), reusing);
    expect(reused.cloudRoute).toBe('fallback');
    expect(statusOf(reused, 'start-session')).toBeUndefined();
    expect(ensureEasSession).not.toHaveBeenCalled();
  });

  it(`has no such phase on a run that may not bring its own environment, or on a local device`, async () => {
    const ensureEasSession = vi.fn();
    const noStart = await runSmokePhasesAsync(
      cloudDeps({ ensureEasSession }),
      options({ bootstrap: false, cloud: 'required' })
    );
    expect(statusOf(noStart, 'start-session')).toBeUndefined();

    const local = await runSmokePhasesAsync(
      deps({ ensureEasSession }),
      options({ bootstrap: true, cloud: 'fallback' })
    );
    expect(statusOf(local, 'start-session')).toBeUndefined();
    expect(ensureEasSession).not.toHaveBeenCalled();
  });
});
