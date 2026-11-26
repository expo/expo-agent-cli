// @ref llp/0005-runtime-loop-tools.rfc.md §The smoke gate
//
// The outcome table of `runSmokePhasesAsync`: starting, booting and opening the app. The rest of
// the table is in the other `phases*-test.ts` files, and the fakes are in `./phasesFixtures.ts`.

import type { SmokeDeps, SmokeEvaluateResult } from '../contract';
import { runSmokePhasesAsync } from '../phases';
import type { SmokeOptions } from '../resolveOptions';
import {
  APP_ATTACH_TIMEOUT_MS,
  APP_SETTLE_MS,
  FIRST_BUNDLE_TIMEOUT_MS,
  RUNTIME_UNSUPPORTED_GRACE_MS,
} from '../timeouts';
import type { SmokePhaseId } from '../types';
import { options, discovery, bundle, opened, deps, statusOf } from './phasesFixtures';

describe(runSmokePhasesAsync, () => {
  // @ref llp/0005-runtime-loop-tools.rfc.md §The run brings its own environment
  // (2026-08-30). Coming up is not reading. A run that starts a dev server pays
  // for that dev server's **first compile**, and a run that boots a simulator pays for the app's
  // **first launch** on it; neither is a measurement of the app, and charging them to the window
  // meant for measuring it leaves the measurement with nothing.
  describe('what a cold start costs', () => {
    /** The budget each dependency was given, so the accounting is readable as a table. */
    function budgets() {
      const given: {
        bundlerReady: number[];
        bundle: number[];
        attach: number[];
        settle: number[];
      } = { bundlerReady: [], bundle: [], attach: [], settle: [] };
      return {
        given,
        deps: (clock: { ms: number }): Partial<SmokeDeps> => ({
          waitForBundlerReady: async (_url, timeoutMs) => {
            given.bundlerReady.push(timeoutMs);
            return {
              ready: true,
              projectRootMatched: true,
              reportedProjectRoot: '/project',
              timedOut: false,
              waitedMs: 5,
              skippedApps: [],
            };
          },
          checkEntryBundle: async (_url, timeoutMs) => {
            given.bundle.push(timeoutMs);
            // A cold first compile, on the clock this run reads.
            clock.ms += 100_000;
            return bundle();
          },
          waitForAppConnection: async (_url, timeoutMs) => {
            given.attach.push(timeoutMs);
            return {
              appsConnected: given.attach.length > 1 ? 1 : 0,
              timedOut: false,
              waitedMs: 3,
              skippedApps: [],
            };
          },
          waitForStableTargets: async (_url, timeoutMs) => {
            given.settle.push(timeoutMs);
            return { stable: true };
          },
        }),
      };
    }

    it(`gives the first compile of a dev server it started a budget of its own`, async () => {
      const clock = { ms: 0 };
      const { given, deps: budgeted } = budgets();
      let reachable = false;

      const run = await runSmokePhasesAsync(
        deps({
          ...budgeted(clock),
          discoverDevServer: async () => {
            const found = discovery({ reachable });
            reachable = true;
            return found;
          },
          probeDevice: async () => ({
            deviceId: 'SIM-1',
            backend: 'local-ios' as const,
            reason: null,
          }),
          now: () => (clock.ms += 10),
        }),
        options({ bootstrap: true, timeoutMs: 60_000 })
      );

      expect(run.environment.devServer).toBe('started');
      // Its own generous budget, like the boot — not the sixty seconds the caller gave the reads.
      expect(given.bundle[0]).toBe(FIRST_BUNDLE_TIMEOUT_MS);
      expect(given.bundlerReady[0]).toBe(FIRST_BUNDLE_TIMEOUT_MS);
      // …and the hundred seconds it spent are not taken off them: the run still passes, and the
      // settle wait after it still has a budget to wait with.
      expect(run.outcome).toBe('passed');
      expect(given.settle[0]).toBeGreaterThan(0);
    });

    // The other half. A dev server somebody else started has bundled already, or has not and that
    // is a fact about their dev server: this run is reading it, so `--timeout` is the right bound.
    it(`charges the compile of a dev server it found to the reading window`, async () => {
      const clock = { ms: 0 };
      const { given, deps: budgeted } = budgets();

      await runSmokePhasesAsync(
        deps({ ...budgeted(clock), now: () => (clock.ms += 10) }),
        options({ bootstrap: true, timeoutMs: 60_000 })
      );

      // What is left of the minute, rather than a minute: the phases before it spent a little.
      expect(given.bundle[0]).toBeGreaterThan(50_000);
      expect(given.bundle[0]).toBeLessThanOrEqual(60_000);
    });

    it(`gives the first launch onto a device it booted a budget of its own`, async () => {
      const clock = { ms: 0 };
      const { given, deps: budgeted } = budgets();
      let booted = false;

      const run = await runSmokePhasesAsync(
        deps({
          ...budgeted(clock),
          probeDevice: async () => ({
            deviceId: booted ? 'SIM-BOOTED' : null,
            backend: booted ? ('local-ios' as const) : null,
            reason: booted ? null : 'no simulator',
          }),
          bootDevice: async () => {
            // A cold boot, on the clock.
            clock.ms += 60_000;
            booted = true;
            return {
              ok: true,
              deviceId: 'SIM-BOOTED',
              backend: 'local-ios' as const,
              reason: null,
            };
          },
          now: () => (clock.ms += 10),
        }),
        options({ bootstrap: true, timeoutMs: 60_000 })
      );

      expect(run.environment.device).toBe('booted');
      // The wait after the deep link, which is the app's first launch on a simulator that has just
      // come up. The probe before it is the short look, unchanged — and what is left of the cold
      // budget, because the open before it shares the same one.
      expect(given.attach[1]).toBeGreaterThan(APP_ATTACH_TIMEOUT_MS - 1_000);
      expect(given.attach[1]).toBeLessThanOrEqual(APP_ATTACH_TIMEOUT_MS);
      expect(run.outcome).toBe('passed');
    });

    // An app that is slow to attach to a dev server and a device that were both already there is
    // this run *reading* a slow app, and that is what the caller's budget is for.
    it(`charges the attach to the reading window when nothing was cold`, async () => {
      const clock = { ms: 0 };
      const { given, deps: budgeted } = budgets();

      await runSmokePhasesAsync(
        deps({
          ...budgeted(clock),
          // A warm dev server, so its compile is a lookup rather than the hundred seconds the
          // shared fake spends: the point of this case is what the *attach* is given.
          checkEntryBundle: async (_url, timeoutMs) => {
            given.bundle.push(timeoutMs);
            return bundle();
          },
          probeDevice: async () => ({
            deviceId: 'SIM-1',
            backend: 'local-ios' as const,
            reason: null,
          }),
          now: () => (clock.ms += 10),
        }),
        options({ bootstrap: true, timeoutMs: 60_000 })
      );

      expect(given.attach[1]).toBeLessThanOrEqual(60_000);
      expect(given.attach[1]).toBeGreaterThan(50_000);
    });

    // The whole point of the accounting, stated as the property rather than as a budget: after a
    // cold start *and* a cold boot, the phases that read the app still have the window the caller
    // asked for.
    it(`leaves the reading window intact after a cold start and a cold boot`, async () => {
      const clock = { ms: 0 };
      const { given, deps: budgeted } = budgets();
      let reachable = false;
      let booted = false;

      const run = await runSmokePhasesAsync(
        deps({
          ...budgeted(clock),
          discoverDevServer: async () => {
            const found = discovery({ reachable });
            reachable = true;
            return found;
          },
          startDevServer: async () => {
            clock.ms += 20_000;
            return { ok: true, devServerUrl: 'http://127.0.0.1:8081', reason: null };
          },
          probeDevice: async () => ({
            deviceId: booted ? 'SIM-BOOTED' : null,
            backend: booted ? ('local-ios' as const) : null,
            reason: booted ? null : 'no simulator',
          }),
          bootDevice: async () => {
            clock.ms += 60_000;
            booted = true;
            return {
              ok: true,
              deviceId: 'SIM-BOOTED',
              backend: 'local-ios' as const,
              reason: null,
            };
          },
          now: () => (clock.ms += 10),
        }),
        options({ bootstrap: true, timeoutMs: 60_000 })
      );

      // Three minutes of coming up — a start, a compile and a boot — against a one-minute window.
      expect(run.outcome).toBe('passed');
      expect(given.settle[0]).toBe(APP_SETTLE_MS);
    });
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §The run brings its own environment. The
  // deep link is a request, not a result: `simctl openurl` exits 0 as soon as the URL is handed
  // over, and on a simulator this run has just booted the app behind it may be a minute from
  // registering a debugger target — or may never register one, because it is not installed.
  describe('what counts as an app being there', () => {
    it(`never passes on the deep link alone: a target has to appear`, async () => {
      const run = await runSmokePhasesAsync(
        deps({
          probeDevice: async () => ({
            deviceId: 'SIM-BOOTED',
            backend: 'local-ios' as const,
            reason: null,
          }),
          // The open succeeds — exit code 0, a URL handed to the device — and nothing ever
          // attaches. This is Expo Go missing from a simulator, exactly.
          waitForAppConnection: async () => ({
            appsConnected: 0,
            timedOut: true,
            waitedMs: 1,
            skippedApps: [],
          }),
        }),
        options({ bootstrap: true })
      );

      expect(statusOf(run, 'app')).toBe('inconclusive');
      expect(run.outcome).toBe('inconclusive');
      expect(run.appsConnected).toBe(0);
      // And nothing after it claims to have read anything.
      for (const id of ['route', 'runtime', 'errors'] as SmokePhaseId[]) {
        expect(statusOf(run, id)).toBe('skipped');
      }
    });

    it(`passes only once the target list answers, and reports what opened it`, async () => {
      const seen: number[] = [];
      const run = await runSmokePhasesAsync(
        deps({
          probeDevice: async () => ({
            deviceId: 'SIM-BOOTED',
            backend: 'local-ios' as const,
            reason: null,
          }),
          waitForAppConnection: async () => {
            seen.push(seen.length);
            // Nothing on the first look; one target once the deep link has been opened.
            return {
              appsConnected: seen.length > 1 ? 1 : 0,
              timedOut: false,
              waitedMs: 3,
              skippedApps: [],
            };
          },
        }),
        options({ bootstrap: true })
      );

      expect(statusOf(run, 'app')).toBe('ok');
      expect(run.phases.find((phase) => phase.id === 'app')?.reason).toContain('to connect one');
      expect(run.appsConnected).toBe(1);
    });
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §The run brings its own environment.
  // A cold Expo Go attaches to the dev server, *then* downloads and runs the bundle — and the
  // debugger target it registered on the way in goes away and comes back when the JS runtime is
  // created. A single read landing in that gap answers "No target found" about an app that is
  // running perfectly well.
  describe('the runtime of an app this run opened', () => {
    /** Deps for a run that opens the app itself, with an evaluate that answers on the nth try. */
    function readableOnAttempt(attempt: number, overrides: Partial<SmokeDeps> = {}) {
      let tries = 0;
      const seen = { tries: () => tries };
      return {
        seen,
        deps: deps({
          probeDevice: async () => ({
            deviceId: 'SIM-BOOTED',
            backend: 'local-ios' as const,
            reason: null,
          }),
          waitForAppConnection: vi
            .fn()
            .mockResolvedValueOnce({
              appsConnected: 0,
              timedOut: true,
              waitedMs: 1,
              skippedApps: [],
            })
            .mockResolvedValue({ appsConnected: 1, timedOut: false, waitedMs: 1, skippedApps: [] }),
          evaluate: async () => {
            tries += 1;
            return tries >= attempt
              ? { ok: true, unsupported: false, reason: null }
              : { ok: false, unsupported: false, reason: 'No target found.' };
          },
          ...overrides,
        }),
      };
    }

    it(`waits for the runtime to answer rather than deciding on one read`, async () => {
      const { seen, deps: fakes } = readableOnAttempt(3);

      const run = await runSmokePhasesAsync(fakes, options({ bootstrap: true }));

      expect(seen.tries()).toBe(3);
      expect(statusOf(run, 'runtime')).toBe('ok');
      expect(run.outcome).toBe('passed');
      expect(run.runtimeSupported).toBe(true);
    });

    // The limit stays: a wait that never answers is still `inconclusive`, and the reason is the
    // runtime's own rather than a sentence about waiting.
    it(`still reports a runtime that never answers, with its own reason`, async () => {
      // A clock that runs a minute per read, so the budget is spent in two of them rather than in
      // sixty real seconds of this suite's time.
      let clock = 0;
      const { deps: fakes } = readableOnAttempt(Number.MAX_SAFE_INTEGER, {
        now: () => (clock += 60_000),
      });

      const run = await runSmokePhasesAsync(fakes, options({ bootstrap: true }));

      expect(statusOf(run, 'runtime')).toBe('inconclusive');
      expect(run.phases.find((phase) => phase.id === 'runtime')?.reason).toContain(
        'No target found.'
      );
    });

    /**
     * A run whose app answers by the clock, which steps 1 s per answer. Timers are fake, so the
     * 500 ms polls cost nothing.
     */
    async function runAnsweringBy(
      answerAt: (ms: number) => SmokeEvaluateResult,
      runOptions: SmokeOptions = options()
    ) {
      vi.useFakeTimers();
      try {
        let clock = 0;
        let tries = 0;
        const running = runSmokePhasesAsync(
          deps({
            now: () => clock,
            evaluate: async () => {
              tries += 1;
              clock += 1_000;
              return answerAt(clock);
            },
          }),
          runOptions
        );
        await vi.runAllTimersAsync();
        return { run: await running, tries };
      } finally {
        vi.useRealTimers();
      }
    }

    const readable: SmokeEvaluateResult = { ok: true, unsupported: false, reason: null };
    const noTarget: SmokeEvaluateResult = {
      ok: false,
      unsupported: false,
      reason: 'No target found.',
    };
    const methodNotFound: SmokeEvaluateResult = {
      ok: false,
      unsupported: true,
      reason: 'method not found',
    };

    // @ref llp/0005-runtime-loop-tools.rfc.md §A reloading runtime answers like one with no debugger.
    // A development build on Android answers `Runtime.evaluate` with `-32601` for about 1.5 s after
    // a reload, on the same target id, until its new runtime exists. One read in that gap is not
    // Expo Go's permanent `-32601`. The grace counts from the first "method not found", and it
    // does not shorten the wait for a runtime that is not there yet.
    it.each([
      ['"method not found" until 2 s', (ms: number) => (ms < 3_000 ? methodNotFound : readable)],
      ['"No target found." until 8 s', (ms: number) => (ms < 9_000 ? noTarget : readable)],
      [
        '"No target found." until 6 s, then "method not found"',
        (ms: number) => (ms < 7_000 ? noTarget : ms < 8_000 ? methodNotFound : readable),
      ],
    ])(`reads a reloaded app that answers %s`, async (_answers, answerAt) => {
      const { run } = await runAnsweringBy(answerAt);

      expect(statusOf(run, 'runtime')).toBe('ok');
      expect(run.runtimeSupported).toBe(true);
      expect(run.outcome).toBe('passed');
    });

    // @ref llp/0005-runtime-loop-tools.rfc.md §Android. A runtime with no debugger keeps its answer,
    // so a moved app is asked for the grace after its first "method not found", never for the
    // whole runtime-ready wait, and an app that nothing moved is asked once.
    it.each([
      ['an app this run reloaded', RUNTIME_UNSUPPORTED_GRACE_MS / 1_000 + 1, options()],
      ['an app nothing moved', 1, options({ reload: false })],
    ])(`asks a runtime with no debugger in %s %i time(s)`, async (_app, expected, runOptions) => {
      const { run, tries } = await runAnsweringBy(() => methodNotFound, runOptions);

      expect(tries).toBe(expected);
      expect(statusOf(run, 'runtime')).toBe('inconclusive');
      expect(run.runtimeSupported).toBe(false);
    });

    // An app that was already attached when this run arrived **and was not reloaded** is not one
    // this run is waiting on. Reading it once and reporting the answer is right, and `--no-reload`
    // is what puts the run in that state now: a reload leaves the app coming back, and an app that
    // is coming back gets the poll (@ref ../timeouts §RUNTIME_READY_TIMEOUT_MS).
    it(`asks once when the app was already there and nothing moved it`, async () => {
      let tries = 0;
      await runSmokePhasesAsync(
        deps({
          evaluate: async () => {
            tries += 1;
            return { ok: false, unsupported: false, reason: 'No target found.' };
          },
        }),
        options({ bootstrap: true, reload: false })
      );

      expect(tries).toBe(1);
    });
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §Loading the app is not navigating it —
  // 2026-09-01. `<scheme>://<route>` navigates an app that is already running against a
  // dev server; `<scheme>://?__expo_url=<origin>` is what *loads* it. F123 built
  // that ladder into `openRouteAsync` and gated it on an attach budget — and `smoke` passed none,
  // so a cold development build got the link only a loaded app understands and sat on the dev
  // launcher's own screen.
  describe('loading the app rather than navigating it', () => {
    it.each([false, null])(
      'skips the pending route when bundle readiness is %s',
      async (loaded) => {
        const openRoute = vi.fn(async () =>
          opened({
            expoGoProjectOpen: 'project-then-route',
            attach: { ...opened().attach, checked: true, targets: 1, loaded },
          })
        );
        const run = await runSmokePhasesAsync(
          deps({
            openRoute,
            waitForAppConnection: async () => ({
              appsConnected: openRoute.mock.calls.length,
              waitedMs: 1,
              timedOut: false,
              skippedApps: [],
            }),
          }),
          options({ route: '/explore' })
        );
        expect(statusOf(run, 'app')).toBe('inconclusive');
        expect(statusOf(run, 'route')).toBe('skipped');
        expect(openRoute).toHaveBeenCalledTimes(1);
      }
    );

    it(`gives the open a budget, so the loading link is opened first`, async () => {
      const budgets: number[] = [];
      let booted = false;

      await runSmokePhasesAsync(
        deps({
          discoverDevServer: async () => discovery(),
          probeDevice: async () => ({
            deviceId: booted ? 'SIM-BOOTED' : null,
            backend: booted ? ('local-ios' as const) : null,
            reason: booted ? null : 'no simulator',
          }),
          bootDevice: async () => {
            booted = true;
            return {
              ok: true,
              deviceId: 'SIM-BOOTED',
              backend: 'local-ios' as const,
              reason: null,
            };
          },
          waitForAppConnection: async () => ({
            appsConnected: booted ? 1 : 0,
            timedOut: false,
            waitedMs: 3,
            skippedApps: [],
          }),
          openRoute: async (route, _url, attachBudgetMs) => {
            budgets.push(attachBudgetMs);
            return opened({ route });
          },
        }),
        options({ bootstrap: true })
      );

      // A device this run booted is a cold launch, so the open gets the cold budget rather than
      // whatever is left of the caller's reading window.
      // The cold budget, minus the tick the deadline was read on.
      expect(budgets).toHaveLength(1);
      expect(budgets[0]).toBeGreaterThan(APP_ATTACH_TIMEOUT_MS - 1_000);
      expect(budgets[0]).toBeLessThanOrEqual(APP_ATTACH_TIMEOUT_MS);
    });

    // A warm app on a warm device is this run *reading* something, so the caller's budget bounds
    // the open exactly as it bounds everything else it reads.
    it(`bounds the open by the reading window when nothing was cold`, async () => {
      const budgets: number[] = [];

      await runSmokePhasesAsync(
        deps({
          waitForAppConnection: vi
            .fn()
            .mockResolvedValueOnce({
              appsConnected: 0,
              timedOut: true,
              waitedMs: 1,
              skippedApps: [],
            })
            .mockResolvedValue({ appsConnected: 1, timedOut: false, waitedMs: 1, skippedApps: [] }),
          openRoute: async (route, _url, attachBudgetMs) => {
            budgets.push(attachBudgetMs);
            return opened({ route });
          },
        }),
        options({ bootstrap: true, timeoutMs: 60_000 })
      );

      expect(budgets).toHaveLength(1);
      expect(budgets[0]).toBeGreaterThan(50_000);
      expect(budgets[0]).toBeLessThanOrEqual(60_000);
    });

    // The guard for the false-green class the round went looking for. Measured on a real
    // development build: with the dev launcher on the screen the dev server lists **no debugger
    // target at all** — the launcher's own runtime registers none [observed — 2026-09-01,
    // `wave29-devclient/dcapp`]. So there is no launcher runtime for this gate to read by mistake,
    // and this pins the consequence rather than the cause: nothing green is reachable without a
    // target, whatever is on the screen.
    it(`reaches no green verdict while nothing is attached, however the open went`, async () => {
      const evaluate = vi.fn();
      const collectErrors = vi.fn();

      const run = await runSmokePhasesAsync(
        deps({
          probeDevice: async () => ({
            deviceId: 'SIM-1',
            backend: 'local-ios' as const,
            reason: null,
          }),
          // The open succeeded — the launcher took the link and showed its own screen — and the
          // project never loaded, so nothing registered a target.
          openRoute: async (route) => opened({ route, launch: null }),
          waitForAppConnection: async () => ({
            appsConnected: 0,
            timedOut: true,
            waitedMs: 1,
            skippedApps: [],
          }),
          evaluate,
          collectErrors,
        }),
        options({ bootstrap: true })
      );

      expect(run.outcome).not.toBe('passed');
      expect(run.runtimeSupported).toBeNull();
      // And neither reading phase was even asked: there was nothing to ask.
      expect(evaluate).not.toHaveBeenCalled();
      expect(collectErrors).not.toHaveBeenCalled();
    });
  });
});
