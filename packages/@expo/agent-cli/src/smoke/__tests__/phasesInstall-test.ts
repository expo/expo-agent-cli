// @ref llp/0005-runtime-loop-tools.rfc.md §The smoke gate
//
// The outcome table of `runSmokePhasesAsync`: installing the app. The rest of the table is in the
// other `phases*-test.ts` files, and the fakes are in `./phasesFixtures.ts`.

import { runSmokePhasesAsync } from '../phases';
import { options, discovery, opened, deps, bootableDevice, statusOf } from './phasesFixtures';

// @ref llp/0005-runtime-loop-tools.rfc.md §Putting Expo Go on a simulator that has not got it
//
// The gate used to refuse a machine with no Expo Go and name `npx expo start --ios`. Correct, and a
// dead end for the caller this CLI is for: an agent cannot take that instruction without leaving
// its loop. So the app is installed — and because installing is an *act* rather than a question,
// the phase is conditional like the start and the boot, and it is reported only by a run that did
// it (llp/0005 §The run brings its own environment).
describe(`${runSmokePhasesAsync.name} and installing the app`, () => {
  /** A device this run settled on that has not got the app. */
  const missingApp = { installNeededOnDevice: async () => true };

  /**
   * A run that has to boot: nothing attached, and no device found by the probe.
   *
   * A factory rather than a shared object, because `clearMocks` wipes a `vi.fn`'s queued
   * implementations between tests — a shared one answers `undefined` from the second test on, and
   * silently skips the phase under test.
   */
  const needsBoot = () => ({
    bootstrap: true,
    ...bootableDevice(),
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
  });

  it(`installs the app onto a device that was booted without it`, async () => {
    const installApp = vi.fn(async () => ({ ok: true, version: '57.0.9', reason: null }));
    const run = await runSmokePhasesAsync(
      deps({ ...needsBoot(), ...missingApp, installApp }),
      options({ bootstrap: true })
    );

    // Onto the device this run settled on, and no other.
    expect(installApp).toHaveBeenCalledWith('SIM-BOOTED');
    expect(statusOf(run, 'install-app')).toBe('ok');
    expect(run.outcome).toBe('passed');
  });

  // Conditional, like the start and the boot: a machine that already had the app did not *skip* an
  // install, it never had one to do, and a `skipped` row there reads as work that was owed.
  it(`says nothing at all on a run that had no install to do`, async () => {
    const run = await runSmokePhasesAsync(deps(), options());

    expect(run.phases.some((phase) => phase.id === 'install-app')).toBe(false);
  });

  // Row 2 is the walk's: with no device the install question is not asked, so no plan is read.
  it(`asks nothing about an install when there is no device`, async () => {
    const installNeededOnDevice = vi.fn(async () => true);
    const installApp = vi.fn();
    const run = await runSmokePhasesAsync(
      deps({
        probeDevice: async () => ({ deviceId: null, backend: null, reason: 'no booted device' }),
        installNeededOnDevice,
        installApp,
      }),
      options({ bootstrap: true })
    );

    expect(installNeededOnDevice).not.toHaveBeenCalled();
    expect(installApp).not.toHaveBeenCalled();
    expect(run.phases.some((phase) => phase.id === 'install-app')).toBe(false);
  });

  it(`does not install when the device already has the app`, async () => {
    const installApp = vi.fn(async () => ({ ok: true, version: null, reason: null }));
    await runSmokePhasesAsync(deps({ ...needsBoot(), installApp }), options({ bootstrap: true }));

    expect(installApp).not.toHaveBeenCalled();
  });

  // An install that failed leaves nothing to open, so the run stops there rather than deep-linking
  // into a device it has just been told has no app.
  it(`stops when the install failed, and says why`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        ...needsBoot(),
        ...missingApp,
        installApp: async () => ({ ok: false, version: null, reason: 'the download timed out' }),
      }),
      options({ bootstrap: true })
    );

    expect(statusOf(run, 'install-app')).toBe('failed');
    expect(run.phases.find((phase) => phase.id === 'install-app')?.reason).toContain(
      'the download timed out'
    );
    expect(run.outcome).toBe('failed');
    expect(statusOf(run, 'app')).toBe('skipped');
  });

  // The version that was installed is worth naming: it is the answer to "which Expo Go am I
  // testing against", which is the question the version check exists for.
  it(`names the version it installed`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        ...needsBoot(),
        ...missingApp,
        installApp: async () => ({ ok: true, version: '57.0.9', reason: null }),
      }),
      options({ bootstrap: true })
    );

    expect(run.phases.find((phase) => phase.id === 'install-app')?.reason).toContain('57.0.9');
  });

  // The install is bootstrap, like the boot that preceded it: a 423 MB download is this run paying
  // for cold it caused, and charging it to `--timeout` would leave the error window with nothing.
  it(`does not charge the install to the reading budget`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        ...needsBoot(),
        ...missingApp,
        installApp: async () => ({ ok: true, version: '57.0.9', reason: null }),
        collectErrors: async (_url, windowMs) => {
          expect(windowMs).toBe(3_000);
          return { ok: true, records: [], reason: null };
        },
      }),
      options({ bootstrap: true, timeoutMs: 20_000 })
    );

    expect(run.outcome).toBe('passed');
  });
});

// @ref ../contract §SmokeInstallResult.replaced — an addition and a replacement are different things
// to do to somebody's machine, and the row has to say which.
describe(`${runSmokePhasesAsync.name} and what the install replaced`, () => {
  const needsInstall = {
    installNeededOnDevice: async () => true,
    probeDevice: async () => ({ deviceId: 'SIM-1', backend: 'local-ios' as const, reason: null }),
  };

  it(`names the version it replaced`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        ...needsInstall,
        installApp: async () => ({
          ok: true,
          version: '57.0.9',
          replaced: '56.0.4',
          reason: null,
        }),
      }),
      options({ bootstrap: true })
    );

    expect(run.phases.find((phase) => phase.id === 'install-app')?.reason).toContain(
      'replacing 56.0.4'
    );
  });

  it(`says nothing about replacing when there was nothing there`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        ...needsInstall,
        installApp: async () => ({ ok: true, version: '57.0.9', replaced: null, reason: null }),
      }),
      options({ bootstrap: true })
    );

    expect(run.phases.find((phase) => phase.id === 'install-app')?.reason).not.toContain(
      'replacing'
    );
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §Putting Expo Go on a simulator that has not got it
//
// The install invalidates the probe that came before it. `simctl install` over a running app
// replaces the bundle and takes the process with it, so an app that was attached a moment earlier
// is gone — and the dev server's target list does not forget it that quickly.
//
// Live, that produced a run whose phases argued with each other [observed, Kudo, 2026-09-03]:
//
//   ok       install-app 4.8s · installed 57.0.9 …, replacing 54.0.7, and left it there
//   ok       app
//   unknown  reload · no app is connected to the dev server, so there is nothing to broadcast to
//   unknown  runtime · No app connected to the dev server could be shown to be running on ios
//
// The `app` row is the tell: `ok` with no reason and no duration is the already-attached shortcut,
// which reused a count taken before the install. The run that followed it passed, because it found
// nothing attached and opened the app — which is what this one should have done.
describe(`${runSmokePhasesAsync.name} and the app the install replaced`, () => {
  /** Attached when the run starts, and gone by the time the install has finished. */
  const attachedThenReplaced = () => ({
    bootstrap: true,
    installNeededOnDevice: async () => true,
    probeDevice: async () => ({ deviceId: 'SIM-1', backend: 'local-ios' as const, reason: null }),
    installApp: async () => ({ ok: true, version: '57.0.9', replaced: '54.0.7', reason: null }),
  });

  it('does not report a pending route when the device disappears after install on bare smoke', async () => {
    let installed = false;
    const run = await runSmokePhasesAsync(
      deps({
        ...attachedThenReplaced(),
        installApp: async () => {
          installed = true;
          return { ok: true, version: '57.0.9', replaced: '54.0.7', reason: null };
        },
        probeDevice: async () =>
          installed
            ? { deviceId: null, backend: null, reason: 'device disappeared' }
            : { deviceId: 'SIM-1', backend: 'local-ios', reason: null },
      }),
      options({ bootstrap: true })
    );
    expect(run.phases.find((phase) => phase.id === 'app')?.reason).toContain('device disappeared');
    expect(run.phases.find((phase) => phase.id === 'route')?.reason).toContain('no --route');
  });

  it(`opens the app again after replacing it, rather than trusting the earlier probe`, async () => {
    const openRoute = vi.fn(async (route: string) => opened({ route }));
    const run = await runSmokePhasesAsync(
      deps({
        ...attachedThenReplaced(),
        // One app all along, which is the stale target the live run tripped over: the count says
        // yes both before the install and after it.
        waitForAppConnection: async () => ({
          appsConnected: 1,
          timedOut: false,
          waitedMs: 1,
          skippedApps: [],
        }),
        openRoute,
      }),
      options({ bootstrap: true })
    );

    expect(openRoute).toHaveBeenCalledWith(
      '/',
      'http://127.0.0.1:8081',
      expect.any(Number),
      'project-only'
    );
    expect(run.phases.find((phase) => phase.id === 'app')?.reason).toContain('to connect one');
    expect(run.outcome).toBe('passed');
  });

  it('skips the route when iOS refuses to open the replacement and Metro still lists the old app', async () => {
    const run = await runSmokePhasesAsync(
      deps({
        ...attachedThenReplaced(),
        waitForAppConnection: async () => ({
          appsConnected: 1,
          timedOut: false,
          waitedMs: 1,
          skippedApps: [],
        }),
        openRoute: async () => opened({ expoGoProjectOpen: 'project-then-route', exitCode: 115 }),
      }),
      options({ bootstrap: true, route: '/explore' })
    );
    expect(run.appsConnected).toBe(0);
    expect(statusOf(run, 'app')).toBe('failed');
    expect(statusOf(run, 'route')).toBe('skipped');
  });

  // And the app it opened is one this run moved, so it owes the settle and the runtime poll — and
  // owes **no** reload, because it fetched the served bundle on its way up.
  it(`treats the reopened app as one this run opened`, async () => {
    const reloadApp = vi.fn();
    const run = await runSmokePhasesAsync(
      deps({
        ...attachedThenReplaced(),
        waitForAppConnection: async () => ({
          appsConnected: 1,
          timedOut: false,
          waitedMs: 1,
          skippedApps: [],
        }),
        reloadApp,
      }),
      options({ bootstrap: true })
    );

    expect(reloadApp).not.toHaveBeenCalled();
    expect(statusOf(run, 'reload')).toBe('skipped');
    expect(run.reload.disposition).toBe('not-needed');
  });

  // A run that installed nothing keeps the shortcut: re-opening an app that is already there costs
  // a launch and answers nothing new.
  it(`still trusts the probe when nothing was installed`, async () => {
    const openRoute = vi.fn(async (route: string) => opened({ route }));
    await runSmokePhasesAsync(
      deps({ installNeededOnDevice: async () => false, openRoute }),
      options({ bootstrap: true })
    );

    expect(openRoute).not.toHaveBeenCalled();
  });

  // An install that **failed** never gets here — the run stops at the phase — but the flag must not
  // be set by the attempt either, or a failed install would send the run looking for an app it
  // never put there.
  it(`does not reopen after an install that failed`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        ...attachedThenReplaced(),
        installApp: async () => ({ ok: false, version: null, replaced: null, reason: 'no space' }),
      }),
      options({ bootstrap: true })
    );

    expect(statusOf(run, 'install-app')).toBe('failed');
    expect(statusOf(run, 'app')).toBe('skipped');
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §A build changes the project it was read from
//
// The start phase can **compile**, and a compile is one of the few things that changes the answer
// to "which app is this run about": `expo prebuild` writes `android.package` and
// `ios.bundleIdentifier` into the app config when they were not declared. A run that read the
// project once, before the build, then decided about the install from that reading — and on an
// Android project whose package the prebuild was about to write, the reading was `null`, so no
// install ever fired and the deep link was refused [observed — Kudo, local run, 2026-09-04].
//
// The walk cannot see any of that: the target is the wiring's (`deps/target.ts`, `deps/shared.ts`). What it *can*
// pin is the order the phases run in, which is what makes a re-read possible at all — the install
// decision has to come after the start, not beside it.
describe(`${runSmokePhasesAsync.name} and a start that changed the project`, () => {
  it(`asks whether an install is needed only after the start phase has finished`, async () => {
    const order: string[] = [];
    let looks = 0;

    await runSmokePhasesAsync(
      deps({
        // Nothing there to begin with, so the run performs the start.
        discoverDevServer: async () => discovery({ reachable: looks++ > 0 }),
        startDevServer: async () => {
          order.push('start');
          return { ok: true, devServerUrl: 'http://127.0.0.1:8081', reason: null };
        },
        installNeededOnDevice: async () => {
          order.push('install-needed');
          return false;
        },
        waitForAppConnection: async () => ({
          appsConnected: 0,
          timedOut: true,
          waitedMs: 1,
          skippedApps: [],
        }),
      }),
      options({ bootstrap: true })
    );

    expect(order).toEqual(['start', 'install-needed']);
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §An app that cannot be named still has to be installed
//
// The install decision is the wiring's, not the walk's, so what this pins is the one thing the walk
// owns: that it *asks*, and that it installs whatever the answer says — including for a run whose
// app the wiring could not name. Three runs in a row booted an emulator, installed nothing and had
// the deep link refused because the answer was "no" for the wrong reason [observed — Kudo,
// 2026-09-04].
describe(`${runSmokePhasesAsync.name} and an install it was told is needed`, () => {
  it(`installs whenever the decision says so, whatever the run knows about the app`, async () => {
    const run = await runSmokePhasesAsync(
      deps({
        installNeededOnDevice: async () => true,
        installApp: async () => ({
          ok: true,
          // A native build knows neither, and that is the shape this case is about: nothing about
          // the install phase may depend on the app being nameable.
          version: null,
          replaced: null,
          reason: null,
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

    const install = run.phases.find((phase) => phase.id === 'install-app');
    expect(install).toMatchObject({ status: 'ok' });
    // The row reads without a version, rather than printing `null` or omitting the act.
    expect(install!.reason).toContain('installed the app');
  });
});
