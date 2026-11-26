// @ref llp/0005-runtime-loop-tools.rfc.md §The smoke gate
//
// The outcome table of `runSmokePhasesAsync`: which app the run read, and whether it is the code on
// disk. The rest of the table is in the other `phases*-test.ts` files, and the fakes are in
// `./phasesFixtures.ts`.

import { runSmokePhasesAsync, smokeExitCode } from '../phases';
import { options, discovery, opened, screenshot, record, deps, statusOf } from './phasesFixtures';

// @ref llp/0005-runtime-loop-tools.rfc.md §The device that can open the app. A picture is the one
// piece of evidence a reader believes without checking, and a home screen looks exactly like an app
// that failed to render — so an `ok` on a run whose app never connected has to say what it is a
// picture of.
describe(`${runSmokePhasesAsync.name} and what the picture shows`, () => {
  it(`says the app was not connected, on a run where it was not`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        waitForAppConnection: async () => ({
          appsConnected: 0,
          timedOut: true,
          waitedMs: 1,
          skippedApps: [],
        }),
        probeDevice: async () => ({
          deviceId: 'SIM-1',
          backend: 'local-ios' as const,
          reason: null,
        }),
      }),
      options()
    );

    const shot = run.phases.find((phase) => phase.id === 'screenshot');
    expect(shot?.status).toBe('ok');
    expect(shot?.reason).toContain('no app of this project was connected');
  });

  // The third case, and the one a screenshot captured: the loading link was opened, the app did
  // not finish loading, and what a development build shows then is **the dev launcher's own
  // screen**. Saying "no app was connected" is true and leaves the reader to wonder what they are
  // looking at; naming the launcher is the whole difference.
  it(`names the dev launcher when the loading link was opened and nothing loaded`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        probeDevice: async () => ({
          deviceId: 'SIM-1',
          backend: 'local-ios' as const,
          reason: null,
        }),
        openRoute: async (route) =>
          opened({
            route,
            isExpoGo: false,
            launch: {
              url: 'dcapp://?__expo_url=http%3A%2F%2F127.0.0.1%3A8081',
              command: 'xcrun simctl openurl SIM-1 dcapp://?__expo_url=…',
              exitCode: 0,
              attached: false,
              waitedMs: 20_000,
            },
          }),
        waitForAppConnection: async () => ({
          appsConnected: 0,
          timedOut: true,
          waitedMs: 1,
          skippedApps: [],
        }),
      }),
      options({ bootstrap: true })
    );

    const shot = run.phases.find((phase) => phase.id === 'screenshot');
    expect(shot?.status).toBe('ok');
    expect(shot?.reason).toContain('dev launcher');
  });

  it(`says nothing extra when the app was there`, async () => {
    const run = await runSmokePhasesAsync(deps(), options());

    expect(run.phases.find((phase) => phase.id === 'screenshot')).toMatchObject({
      status: 'ok',
      reason: null,
    });
  });
});

// @ref ../timeouts §APP_SETTLE_MS — friction run 6, F57. A run that opened the app itself
// photographed it while it was still loading, so the picture the gate hands back — the half of
// "does it work" that no exit code answers — was of a splash screen.
describe(`${runSmokePhasesAsync.name} and the app it opened`, () => {
  it(`waits for the app to stop re-registering when this run opened it`, async () => {
    const waits: number[] = [];
    await runSmokePhasesAsync(
      deps({
        // Nothing attached at first, so the run opens the app itself.
        waitForAppConnection: vi
          .fn()
          .mockResolvedValueOnce({ appsConnected: 0, timedOut: true, waitedMs: 1, skippedApps: [] })
          .mockResolvedValue({ appsConnected: 1, timedOut: false, waitedMs: 1, skippedApps: [] }),
        waitForStableTargets: async (_url, timeoutMs) => {
          waits.push(timeoutMs);
          return { stable: true };
        },
      }),
      options()
    );

    // Once for the whole run, however many phases need it: it is one fact about one app.
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
  });

  // @ref ../timeouts §APP_SETTLE_MS — observed 2026-08-30, a cold-start run. The `app` phase
  // answered `ok` and the `runtime` phase two seconds later got `No target found`, so a run whose
  // own picture shows the app rendered reported `22`. The debugger target list is still churning
  // while an app boots, and the wait that was buying an honest picture has to come first.
  it(`waits before it reads the runtime, not only before the picture`, async () => {
    const order: string[] = [];
    await runSmokePhasesAsync(
      deps({
        waitForAppConnection: vi
          .fn()
          .mockResolvedValueOnce({ appsConnected: 0, timedOut: true, waitedMs: 1, skippedApps: [] })
          .mockResolvedValue({ appsConnected: 1, timedOut: false, waitedMs: 1, skippedApps: [] }),
        waitForStableTargets: async () => {
          order.push('settle');
          return { stable: true };
        },
        evaluate: async () => {
          order.push('evaluate');
          return { ok: true, unsupported: false, reason: null };
        },
        captureScreenshot: async () => {
          order.push('screenshot');
          return screenshot();
        },
      }),
      options()
    );

    expect(order).toEqual(['settle', 'evaluate', 'screenshot']);
  });

  // `--no-reload`, because that is now the only way a run reads an app it did not move: an app it
  // reloaded is re-registering and owes the wait for the same reason a cold launch does.
  it(`does not spend the wait on an app that was already attached and not reloaded`, async () => {
    const waitForStableTargets = vi.fn(async () => ({ stable: true }));

    await runSmokePhasesAsync(deps({ waitForStableTargets }), options({ reload: false }));

    expect(waitForStableTargets).not.toHaveBeenCalled();
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §The app under test is the code on disk
//
// The false green this phase was added to remove, and the one this command exists to prevent.
// Every phase below `app` reads the *running app*, and an app that was already attached when the
// run arrived is running whatever it last loaded. At the moment `smoke` is for — after an edit,
// before saying "done" — that is the bundle from before the edit.
//
// Observed on a plain Expo Go project [iOS 26.5 simulator, Expo Go SDK 57, 2026-09-03]: with a
// bare `throw new Error(...)` at the top of the entry component, `smoke --platform ios --no-start`
// reported `smoke passed` with `errors ok` at 3.1 s and exited 0, and its own screenshot showed
// the *previous* screen. Killing the app first made the identical run fail with the throw in the
// error window, which is what proved it was staleness and not the error reader.
describe(`${runSmokePhasesAsync.name} and the code on disk`, () => {
  it(`reloads an app that was already attached, before it reads it`, async () => {
    const reloadApp = vi.fn(async () => ({
      ok: true,
      verifiedBy: 'message-socket-peers' as const,
      knownTargetIds: ['page-1'],
      freshTargets: 0,
      commandSocketReconnected: true,
      targetOutcomes: [],
      bundleServed: false,
      reason: null,
    }));
    const run = await runSmokePhasesAsync(
      deps({
        discoverDevServer: async () => discovery({ devServerUrl: 'http://127.0.0.1:8210' }),
        reloadApp,
      }),
      options()
    );

    // On the dev server this run settled on, like every other phase.
    expect(reloadApp).toHaveBeenCalledWith('http://127.0.0.1:8210', expect.any(Number));
    expect(statusOf(run, 'reload')).toBe('ok');
    expect(run.reload.disposition).toBe('reloaded');
    expect(run.reload.verifiedBy).toBe('message-socket-peers');
    expect(run.outcome).toBe('passed');
  });

  // The reload has to come *before* the error window, or the window is of the session the reload
  // replaced and the whole phase buys nothing.
  it(`opens the error window after the reload, not before it`, async () => {
    const order: string[] = [];
    await runSmokePhasesAsync(
      deps({
        reloadApp: async () => {
          order.push('reload');
          return {
            ok: true,
            verifiedBy: 'message-socket-peers' as const,
            knownTargetIds: [],
            freshTargets: 0,
            commandSocketReconnected: true,
            targetOutcomes: [],
            bundleServed: false,
            reason: null,
          };
        },
        collectErrors: async () => {
          order.push('errors');
          return { ok: true, records: [], reason: null };
        },
      }),
      options()
    );

    expect(order).toEqual(['reload', 'errors']);
  });

  // And before the route, because a reload sends the app back to its initial route: reloading
  // after the open would throw away the screen the caller asked for.
  it(`reloads before it opens the route`, async () => {
    const order: string[] = [];
    await runSmokePhasesAsync(
      deps({
        reloadApp: async () => {
          order.push('reload');
          return {
            ok: true,
            verifiedBy: 'message-socket-peers' as const,
            knownTargetIds: [],
            freshTargets: 0,
            commandSocketReconnected: true,
            targetOutcomes: [],
            bundleServed: false,
            reason: null,
          };
        },
        openRoute: async (route) => {
          order.push('route');
          return opened({ route });
        },
      }),
      options({ route: '/notes' })
    );

    expect(order).toEqual(['reload', 'route']);
  });

  // An app this run opened fetched the served bundle on its way up, so there is no stale session
  // to replace and a reload would cost a second load to reach the state the run is already in.
  it(`does not reload an app it opened itself`, async () => {
    const reloadApp = vi.fn();
    const run = await runSmokePhasesAsync(
      deps({
        waitForAppConnection: vi
          .fn<
            () => Promise<{
              appsConnected: number;
              timedOut: boolean;
              waitedMs: number;
              skippedApps: [];
            }>
          >()
          .mockResolvedValueOnce({ appsConnected: 0, timedOut: true, waitedMs: 1, skippedApps: [] })
          .mockResolvedValue({ appsConnected: 1, timedOut: false, waitedMs: 2, skippedApps: [] }),
        reloadApp,
      }),
      options()
    );

    expect(reloadApp).not.toHaveBeenCalled();
    expect(statusOf(run, 'reload')).toBe('skipped');
    expect(run.reload.disposition).toBe('not-needed');
    expect(run.outcome).toBe('passed');
  });

  // @ref llp/0021-honest-reports.rfc.md §The rules band. The whole point: a reload nothing was
  // seen to come of leaves the run unable to say which session the window below is of, and a gate
  // that cannot say that must not report that the app is fine. `inconclusive` rather than
  // `failed` — nothing has been shown to be *wrong*, and the next action is to look again.
  it(`will not pass a run whose reload was never proved`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        reloadApp: async () => ({
          ok: false,
          verifiedBy: null,
          knownTargetIds: ['page-1'],
          freshTargets: 0,
          commandSocketReconnected: false,
          targetOutcomes: [],
          bundleServed: false,
          reason: 'no client reconnected',
        }),
      }),
      options()
    );

    expect(statusOf(run, 'reload')).toBe('inconclusive');
    expect(run.reload.disposition).toBe('unproved');
    expect(run.reload.verifiedBy).toBeNull();
    expect(run.outcome).toBe('inconclusive');
    expect(smokeExitCode(run.outcome)).toBe(22);
  });

  // A real error still decides the run, whatever the reload did: an app that threw has been shown
  // to be broken, and "which session" is no longer the open question.
  it(`still fails on an error, even when the reload was not proved`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        reloadApp: async () => ({
          ok: false,
          verifiedBy: null,
          knownTargetIds: [],
          freshTargets: 0,
          commandSocketReconnected: false,
          targetOutcomes: [],
          bundleServed: false,
          reason: 'nothing came of it',
        }),
        collectErrors: async () => ({ ok: true, records: [record()], reason: null }),
      }),
      options()
    );

    expect(run.outcome).toBe('failed');
    expect(smokeExitCode(run.outcome)).toBe(20);
  });

  // `--no-reload`. The one question a reload destroys is "is the app throwing right now, where I
  // navigated it to by hand", so the caller has to be able to say no — and the row then says which
  // of the two questions the run answered rather than reading as a step that was owed.
  it(`reads the app where it is when --no-reload says to`, async () => {
    const reloadApp = vi.fn();
    const run = await runSmokePhasesAsync(deps({ reloadApp }), options({ reload: false }));

    expect(reloadApp).not.toHaveBeenCalled();
    expect(statusOf(run, 'reload')).toBe('skipped');
    expect(run.reload.disposition).toBe('declined');
    expect(run.phases.find((phase) => phase.id === 'reload')?.reason).toContain('--no-reload');
    // Still a pass: the caller asked about the session that is running, and it was read.
    expect(run.outcome).toBe('passed');
  });

  // The proof is carried, not summarized. A label with nothing behind it is the shape llp/0021
  // exists to remove, so what the run reports is the evidence the label rests on.
  it(`carries the evidence the reload label rests on`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        reloadApp: async () => ({
          ok: true,
          verifiedBy: 'fresh-debugger-target' as const,
          knownTargetIds: ['page-1', 'page-2'],
          freshTargets: 1,
          commandSocketReconnected: false,
          targetOutcomes: [],
          bundleServed: false,
          reason: null,
        }),
      }),
      options()
    );

    expect(run.reload.verifiedBy).toBe('fresh-debugger-target');
    expect(run.reload.freshTargets).toBe(1);
    expect(run.reload.knownTargetIds).toEqual(['page-1', 'page-2']);
  });

  // A proved reload leaves the app re-registering exactly the way a cold launch does, so it owes
  // the same settle and the same runtime-ready poll — a single read landing in that gap answers
  // "No target found" about an app that is coming back fine (@ref ../timeouts §APP_SETTLE_MS).
  it(`waits for the app to settle after a reload it proved`, async () => {
    const waitForStableTargets = vi.fn(async () => ({ stable: true }));
    await runSmokePhasesAsync(deps({ waitForStableTargets }), options());

    expect(waitForStableTargets).toHaveBeenCalled();
  });

  // And does not wait on one it did not: an app that never acted is not coming up, so the wait
  // would spend the caller's budget proving nothing.
  it(`does not wait on a reload that was never proved`, async () => {
    const waitForStableTargets = vi.fn(async () => ({ stable: true }));
    await runSmokePhasesAsync(
      deps({
        waitForStableTargets,
        reloadApp: async () => ({
          ok: false,
          verifiedBy: null,
          knownTargetIds: [],
          freshTargets: 0,
          commandSocketReconnected: false,
          targetOutcomes: [],
          bundleServed: false,
          reason: 'nothing came of it',
        }),
      }),
      options()
    );

    expect(waitForStableTargets).not.toHaveBeenCalled();
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §Expo Go is only a target for a project that fits in it
//
// The other half of that section. Not opening Expo Go stops this gate *choosing* the wrong app; it
// does nothing about an Expo Go that is already attached, which is the state `expo start --ios`
// leaves behind and the one an agent is most likely to inherit. Reading that runtime answers about
// Expo Go, not about a project whose native code Expo Go does not contain.
//
// Live: with Expo Go opened by hand against an Expo-Go-incompatible project, every phase answered
// and the gate reported `passed` at exit 0 [observed — iOS 26.5 simulator, 2026-09-03].
describe(`${runSmokePhasesAsync.name} and whether the app fits the project`, () => {
  const MISMATCH =
    'the app that answered is Expo Go, and this project cannot run in Expo Go — its native code is not in that runtime';

  it(`will not pass a run whose runtime is an app the project cannot run`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        checkAppFitsProject: async () => ({
          mismatch: MISMATCH,
          kind: 'expo-go-incompatible' as const,
          note: null,
        }),
      }),
      options()
    );

    expect(statusOf(run, 'app')).toBe('inconclusive');
    expect(run.phases.find((phase) => phase.id === 'app')?.reason).toBe(MISMATCH);
    expect(run.outcome).toBe('inconclusive');
    expect(smokeExitCode(run.outcome)).toBe(22);
  });

  // The window is still opened and still reported, exactly as it is for a runtime with no debugger:
  // an empty window costs one wait and the report is more useful with it. What it must not do is
  // decide the verdict.
  it(`still reads the app it found, and still photographs it`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        checkAppFitsProject: async () => ({
          mismatch: MISMATCH,
          kind: 'expo-go-incompatible' as const,
          note: null,
        }),
      }),
      options()
    );

    expect(statusOf(run, 'errors')).toBe('ok');
    expect(statusOf(run, 'screenshot')).toBe('ok');
    expect(run.screenshot.ok).toBe(true);
  });

  // An error is an error. Expo Go threw while running this project's bundle, which is a fact about
  // the code whichever app was holding it — so `failed` outranks the mismatch.
  it(`still fails on an error the wrong app reported`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        checkAppFitsProject: async () => ({
          mismatch: MISMATCH,
          kind: 'expo-go-incompatible' as const,
          note: null,
        }),
        collectErrors: async () => ({ ok: true, records: [record()], reason: null }),
      }),
      options()
    );

    expect(run.outcome).toBe('failed');
    expect(smokeExitCode(run.outcome)).toBe(20);
  });

  // An app this run opened itself is asked the same question: the open picks the target from the
  // same decision, so a mismatch there would mean this gate had opened the wrong app.
  it(`asks the question for an app it opened as well as one it found`, async () => {
    const checkAppFitsProject = vi.fn(async () => ({ mismatch: null, kind: null, note: null }));
    await runSmokePhasesAsync(
      deps({
        checkAppFitsProject,
        waitForAppConnection: vi
          .fn<
            () => Promise<{
              appsConnected: number;
              timedOut: boolean;
              waitedMs: number;
              skippedApps: [];
            }>
          >()
          .mockResolvedValueOnce({ appsConnected: 0, timedOut: true, waitedMs: 1, skippedApps: [] })
          .mockResolvedValue({ appsConnected: 1, timedOut: false, waitedMs: 2, skippedApps: [] }),
      }),
      options()
    );

    expect(checkAppFitsProject).toHaveBeenCalled();
  });

  // And a run with no app at all never asks: there is no runtime to be about.
  it(`does not ask when nothing is connected`, async () => {
    const checkAppFitsProject = vi.fn(async () => ({ mismatch: null, kind: null, note: null }));
    await runSmokePhasesAsync(
      deps({
        checkAppFitsProject,
        waitForAppConnection: async () => ({
          appsConnected: 0,
          timedOut: true,
          waitedMs: 1,
          skippedApps: [],
        }),
        openRoute: async (route) => opened({ route, exitCode: 115 }),
      }),
      options()
    );

    expect(checkAppFitsProject).not.toHaveBeenCalled();
  });
});

// @ref ../contract §SmokeDeps.checkAppFitsProject
//
// The dep answers two things, and this is the one that decides nothing: a finding worth printing on
// the row it is about, which leaves the verdict alone. Nothing produces one today — the version
// mismatch that used to became an install instead (§The Expo Go on the device is not the Expo Go the
// SDK wants) — so this covers the mechanism rather than a caller of it, and the next finding that
// needs to be said without being fatal has somewhere to go.
describe(`${runSmokePhasesAsync.name} and a note about the app it read`, () => {
  const NOTE = 'something worth saying that decides nothing';

  it(`keeps the phase ok and still passes the run`, async () => {
    const run = await runSmokePhasesAsync(
      deps({ checkAppFitsProject: async () => ({ mismatch: null, kind: null, note: NOTE }) }),
      options()
    );

    expect(statusOf(run, 'app')).toBe('ok');
    expect(run.outcome).toBe('passed');
  });

  // Said out loud on the row it is about, because a fact nobody prints is a fact nobody has.
  it(`says it on the app phase`, async () => {
    const run = await runSmokePhasesAsync(
      deps({ checkAppFitsProject: async () => ({ mismatch: null, kind: null, note: NOTE }) }),
      options()
    );

    expect(run.phases.find((phase) => phase.id === 'app')?.reason).toBe(NOTE);
  });

  // A mismatch outranks a note: there is no use telling someone their Expo Go is a patch behind
  // when the real answer is that it cannot run their project at all.
  it(`prefers the mismatch when there is one`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        checkAppFitsProject: async () => ({
          mismatch: 'cannot run this project',
          kind: 'expo-go-incompatible' as const,
          note: NOTE,
        }),
      }),
      options()
    );

    expect(statusOf(run, 'app')).toBe('inconclusive');
    expect(run.phases.find((phase) => phase.id === 'app')?.reason).toBe('cannot run this project');
    expect(run.outcome).toBe('inconclusive');
  });

  // And a note never overwrites the sentence the phase already had, which says how the app got
  // there — that is the fact the row exists for.
  it(`does not lose the phase's own reason`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        checkAppFitsProject: async () => ({ mismatch: null, kind: null, note: NOTE }),
        waitForAppConnection: vi
          .fn<
            () => Promise<{
              appsConnected: number;
              timedOut: boolean;
              waitedMs: number;
              skippedApps: [];
            }>
          >()
          .mockResolvedValueOnce({ appsConnected: 0, timedOut: true, waitedMs: 1, skippedApps: [] })
          .mockResolvedValue({ appsConnected: 1, timedOut: false, waitedMs: 2, skippedApps: [] }),
      }),
      options()
    );

    const reason = run.phases.find((phase) => phase.id === 'app')?.reason ?? '';
    expect(reason).toContain('to connect one');
    expect(reason).toContain(NOTE);
  });
});
