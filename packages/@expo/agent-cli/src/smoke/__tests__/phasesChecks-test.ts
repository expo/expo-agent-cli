// @ref llp/0005-runtime-loop-tools.rfc.md §The smoke gate
//
// The outcome table of `runSmokePhasesAsync`: the bundler, the app, the route, the runtime and the
// screenshot. The rest of the table is in the other `phases*-test.ts` files, and the fakes are in
// `./phasesFixtures.ts`.

import { runSmokePhasesAsync } from '../phases';
import { RUNTIME_UNSUPPORTED_GRACE_MS } from '../timeouts';
import {
  options,
  discovery,
  bundle,
  opened,
  screenshot,
  record,
  deps,
  statusOf,
  steppingClock,
} from './phasesFixtures';

describe(runSmokePhasesAsync, () => {
  describe('the bundler', () => {
    // Decided rather than pending: no amount of looking again turns another project's dev server
    // into this one's, so it is `failed` and never `inconclusive` (llp/0010 §Other gates, in brief).
    it(`fails for another project's dev server, and reads nothing of its app`, async () => {
      const waitForAppConnection = vi.fn();
      const run = await runSmokePhasesAsync(
        deps({
          waitForBundlerReady: async () => ({
            ready: true,
            projectRootMatched: false,
            reportedProjectRoot: '/other',
            timedOut: false,
            waitedMs: 4,
            skippedApps: [],
          }),
          waitForAppConnection,
        }),
        options()
      );

      expect(run.outcome).toBe('failed');
      expect(statusOf(run, 'bundler-ready')).toBe('failed');
      expect(statusOf(run, 'bundle')).toBe('skipped');
      expect(waitForAppConnection).not.toHaveBeenCalled();
    });

    // `null` is not `false`: a dev server that named no project root has not been shown to be the
    // wrong one, and failing on undecidable would fail every dev server too old to send the header.
    it(`carries on when the project root could not be decided`, async () => {
      const run = await runSmokePhasesAsync(
        deps({
          waitForBundlerReady: async () => ({
            ready: true,
            projectRootMatched: null,
            reportedProjectRoot: null,
            timedOut: false,
            waitedMs: 4,
            skippedApps: [],
          }),
        }),
        options()
      );

      expect(run.outcome).toBe('passed');
      expect(run.projectRootMatched).toBeNull();
    });

    it(`is inconclusive when the wait expired, and failed when something else answered`, async () => {
      const expired = await runSmokePhasesAsync(
        deps({
          waitForBundlerReady: async () => ({
            ready: false,
            projectRootMatched: null,
            reportedProjectRoot: null,
            timedOut: true,
            waitedMs: 60_000,
            reason: 'still bundling',
          }),
        }),
        options()
      );
      const stranger = await runSmokePhasesAsync(
        deps({
          waitForBundlerReady: async () => ({
            ready: false,
            projectRootMatched: null,
            reportedProjectRoot: null,
            timedOut: false,
            waitedMs: 8,
            reason: 'answered "<!DOCTYPE html>" instead',
          }),
        }),
        options()
      );

      expect(expired.outcome).toBe('inconclusive');
      expect(stranger.outcome).toBe('failed');
    });
  });

  describe('the entry bundle', () => {
    // The gate's whole reason for existing. An app cannot be running code that does not compile,
    // so nothing after this is worth asking.
    it(`fails a bundle that does not compile, and reads no app afterwards`, async () => {
      const waitForAppConnection = vi.fn();
      const run = await runSmokePhasesAsync(
        deps({
          checkEntryBundle: async () =>
            bundle({
              outcome: 'broken',
              error: {
                type: 'TransformError',
                filename: 'src/app/notes.tsx',
                lineNumber: 77,
                column: 4,
                message: "SyntaxError: Unexpected keyword 'const'",
                snippet: null,
              },
            }),
          waitForAppConnection,
        }),
        options()
      );

      expect(run.outcome).toBe('failed');
      expect(statusOf(run, 'bundle')).toBe('failed');
      expect(run.phases.find((phase) => phase.id === 'bundle')!.reason).toContain(
        'src/app/notes.tsx:77:4'
      );
      expect(statusOf(run, 'app')).toBe('skipped');
      expect(waitForAppConnection).not.toHaveBeenCalled();
    });

    // Fail-open, unchanged from `dev:wait`: a dev server that answered nothing this CLI
    // understands has not shown the project to be broken. It does not *pass* either, because
    // nothing was proved.
    it(`is inconclusive for a bundle the dev server said nothing about`, async () => {
      const run = await runSmokePhasesAsync(
        deps({
          checkEntryBundle: async () =>
            bundle({ outcome: 'unknown', url: null, reason: 'no launchAsset.url' }),
        }),
        options()
      );

      expect(statusOf(run, 'bundle')).toBe('inconclusive');
      // The run went on: an unknown bundle is not a reason to stop reading the app.
      expect(statusOf(run, 'runtime')).toBe('ok');
      expect(run.outcome).toBe('passed');
    });

    it(`is inconclusive for a first build that was still running`, async () => {
      const run = await runSmokePhasesAsync(
        deps({ checkEntryBundle: async () => bundle({ outcome: 'timeout' }) }),
        options()
      );

      expect(run.outcome).toBe('inconclusive');
      expect(statusOf(run, 'app')).toBe('skipped');
    });
  });

  describe('the app', () => {
    // Friction run 1's F4, absorbed: a wait for an app cannot succeed while nothing is opening
    // one, so the gate opens one rather than spending its budget on a state it can change.
    it(`opens an app when none is attached, and passes once one is`, async () => {
      let connected = 0;
      const openRoute = vi.fn(async () => {
        connected = 1;
        return opened();
      });
      const run = await runSmokePhasesAsync(
        deps({
          waitForAppConnection: async () => ({
            appsConnected: connected,
            timedOut: connected === 0,
            waitedMs: 2,
            skippedApps: [],
          }),
          openRoute,
        }),
        options()
      );

      expect(openRoute).toHaveBeenCalledWith(
        '/',
        'http://127.0.0.1:8081',
        expect.any(Number),
        'project-only'
      );
      expect(run.outcome).toBe('passed');
      expect(run.appsConnected).toBe(1);
      expect(run.phases.find((phase) => phase.id === 'app')!.reason).toContain('to connect one');
    });

    it(`opens the route that was asked for, rather than the root, when connecting one`, async () => {
      let connected = 0;
      const openRoute = vi.fn(async (route: string) => {
        connected = 1;
        return opened({ route });
      });
      const run = await runSmokePhasesAsync(
        deps({
          waitForAppConnection: async () => ({
            appsConnected: connected,
            timedOut: false,
            waitedMs: 2,
            skippedApps: [],
          }),
          openRoute,
        }),
        options({ route: '/notes' })
      );

      expect(openRoute).toHaveBeenCalledTimes(1);
      expect(openRoute).toHaveBeenCalledWith(
        '/notes',
        'http://127.0.0.1:8081',
        expect.any(Number),
        'project-then-route'
      );
      expect(statusOf(run, 'route')).toBe('ok');
      expect(run.routeCheck).toMatchObject({ ok: true });
    });

    it(`is inconclusive when nothing is attached and there is no device to open one on`, async () => {
      const run = await runSmokePhasesAsync(
        deps({
          waitForAppConnection: async () => ({
            appsConnected: 0,
            timedOut: true,
            waitedMs: 2,
            skippedApps: [],
          }),
          probeDevice: async () => ({
            backend: null,
            deviceId: null,
            reason: 'no booted iOS simulator was found',
          }),
        }),
        options()
      );

      expect(run.outcome).toBe('inconclusive');
      expect(statusOf(run, 'app')).toBe('inconclusive');
      expect(statusOf(run, 'runtime')).toBe('skipped');
      expect(run.screenshot.ok).toBe(false);
      expect(run.screenshot.reason).toContain('no booted iOS simulator');
    });

    it(`fails when the device refused the link that would have opened one`, async () => {
      const run = await runSmokePhasesAsync(
        deps({
          waitForAppConnection: async () => ({
            appsConnected: 0,
            timedOut: true,
            waitedMs: 2,
            skippedApps: [],
          }),
          openRoute: async () => opened({ exitCode: 4 }),
        }),
        options()
      );

      expect(run.outcome).toBe('failed');
      expect(statusOf(run, 'app')).toBe('failed');
    });

    // A device is still there, so the most useful thing left is a picture of what is on it.
    it(`still photographs the device when no app attached`, async () => {
      const run = await runSmokePhasesAsync(
        deps({
          waitForAppConnection: async () => ({
            appsConnected: 0,
            timedOut: true,
            waitedMs: 2,
            skippedApps: [],
          }),
          openRoute: async () => opened(),
        }),
        options()
      );

      expect(run.outcome).toBe('inconclusive');
      expect(run.screenshot.ok).toBe(true);
      expect(statusOf(run, 'screenshot')).toBe('ok');
    });
  });

  describe('the route', () => {
    it(`opens it when an app is already attached`, async () => {
      const openRoute = vi.fn(async (route: string) => opened({ route }));
      const run = await runSmokePhasesAsync(deps({ openRoute }), options({ route: '/notes' }));

      expect(openRoute).toHaveBeenCalledWith('/notes', 'http://127.0.0.1:8081', expect.any(Number));
      expect(statusOf(run, 'route')).toBe('ok');
      expect(run.outcome).toBe('passed');
    });

    it(`fails when the device refused it, and reads nothing afterwards`, async () => {
      const evaluate = vi.fn();
      const run = await runSmokePhasesAsync(
        deps({ openRoute: async () => opened({ exitCode: 1 }), evaluate }),
        options({ route: '/notes' })
      );

      expect(run.outcome).toBe('failed');
      expect(statusOf(run, 'route')).toBe('failed');
      expect(statusOf(run, 'runtime')).toBe('skipped');
      expect(evaluate).not.toHaveBeenCalled();
      // The screen is still worth photographing: it says where the app actually is.
      expect(run.screenshot.ok).toBe(true);
      expect(run.phases.find((phase) => phase.id === 'screenshot')?.reason).toContain(
        'before the requested route could be delivered'
      );
    });

    // A route the project has not got is the caller's own argument being wrong, which is exit 1
    // and not a verdict on the project — so it leaves this function as an exception.
    it(`lets a route the project has not got out as a tool error`, async () => {
      await expect(
        runSmokePhasesAsync(
          deps({
            openRoute: async () => {
              throw new Error('ROUTE_NOT_FOUND');
            },
          }),
          options({ route: '/nope' })
        )
      ).rejects.toThrow('ROUTE_NOT_FOUND');
    });
  });

  describe('the runtime and the window', () => {
    // @ref llp/0005-runtime-loop-tools.rfc.md §The smoke gate. The regression this exists for,
    // measured live on 2026-08-24: an uncaught `throw` arrives as `source: 'console'`, because
    // React Native catches it and reports it through the console path rather than as
    // `Runtime.exceptionThrown`. A gate reading `source` passed seventeen crashes in one window.
    it(`fails on a throw React Native reported through the console path`, async () => {
      const run = await runSmokePhasesAsync(
        deps({
          collectErrors: async () => ({
            ok: true,
            records: [
              {
                source: 'console',
                timestamp: 1,
                message: 'Error: WAVE6_UNCAUGHT',
                stack: '  at setTimeout$argument_0 (src/app/index.tsx:112:18)',
                isError: true,
              },
            ],
            reason: null,
          }),
        }),
        options()
      );

      expect(run.outcome).toBe('failed');
      expect(statusOf(run, 'errors')).toBe('failed');
    });

    // The other channel is still read, because a runtime that uses it exists — a gate that only
    // watched the console path would be the same mistake pointed the other way.
    it(`fails on an uncaught exception in the window`, async () => {
      const run = await runSmokePhasesAsync(
        deps({ collectErrors: async () => ({ ok: true, records: [record()], reason: null }) }),
        options()
      );

      expect(run.outcome).toBe('failed');
      expect(statusOf(run, 'errors')).toBe('failed');
      expect(run.errors).toHaveLength(1);
    });

    // A project that logs one on purpose would otherwise never pass, and a `console.error` is
    // something the app chose to report rather than a crash.
    it(`passes a window holding only console.error calls, and counts them`, async () => {
      const run = await runSmokePhasesAsync(
        deps({
          collectErrors: async () => ({
            ok: true,
            records: [record({ message: 'deprecated', stack: undefined, isError: false })],
            reason: null,
          }),
        }),
        options()
      );

      expect(run.outcome).toBe('passed');
      expect(statusOf(run, 'errors')).toBe('ok');
      expect(run.errors).toHaveLength(1);
    });

    // @ref llp/0005-runtime-loop-tools.rfc.md §Android. Expo Go for Android acknowledges
    // `Runtime.enable` and reports nothing, so an empty window there is silence and not health.
    // This is the case that must never be a pass, whatever the window says.
    it(`never passes a runtime with no debugger, however empty the window`, async () => {
      const run = await runSmokePhasesAsync(
        deps({
          evaluate: async () => ({
            ok: false,
            unsupported: true,
            reason: 'the runtime answered Runtime.evaluate with "method not found"',
          }),
          collectErrors: async () => ({ ok: true, records: [], reason: null }),
          now: steppingClock(RUNTIME_UNSUPPORTED_GRACE_MS),
        }),
        options({ platform: 'android' })
      );

      expect(run.outcome).toBe('inconclusive');
      expect(run.runtimeSupported).toBe(false);
      expect(statusOf(run, 'runtime')).toBe('inconclusive');
      expect(statusOf(run, 'errors')).toBe('inconclusive');
    });

    // The other half of the same rule: a runtime that cannot be read is still read *for
    // exceptions*, and one that arrives is a failure — that is a fact, not an absence.
    it(`still fails an unreadable runtime that did report an exception`, async () => {
      const run = await runSmokePhasesAsync(
        deps({
          evaluate: async () => ({ ok: false, unsupported: true, reason: 'method not found' }),
          collectErrors: async () => ({ ok: true, records: [record()], reason: null }),
          now: steppingClock(RUNTIME_UNSUPPORTED_GRACE_MS),
        }),
        options()
      );

      expect(run.outcome).toBe('failed');
    });

    it(`is inconclusive when the window could not be opened at all`, async () => {
      const run = await runSmokePhasesAsync(
        deps({
          collectErrors: async () => ({ ok: false, records: [], reason: 'no target found' }),
        }),
        options()
      );

      expect(run.outcome).toBe('inconclusive');
      expect(statusOf(run, 'errors')).toBe('inconclusive');
    });

    // `reload: false` so this stays a test of the *verdict*: a run that reloaded the app polls the
    // runtime for `RUNTIME_READY_TIMEOUT_MS` before it gives up, which is its own case above, and
    // spending that wait here would measure the poll rather than what the poll's answer decides.
    it(`is inconclusive when the runtime did not answer for another reason`, async () => {
      const run = await runSmokePhasesAsync(
        deps({
          evaluate: async () => ({ ok: false, unsupported: false, reason: 'socket hang up' }),
        }),
        options({ reload: false })
      );

      expect(run.outcome).toBe('inconclusive');
      expect(run.runtimeSupported).toBeNull();
    });
  });

  describe('the screenshot', () => {
    // It is evidence attached to an answer, not the answer. A run that could not take one has
    // still established whether the app throws.
    it(`never decides the outcome`, async () => {
      const failed = await runSmokePhasesAsync(
        deps({ captureScreenshot: async () => screenshot({ ok: false, reason: 'xcrun refused' }) }),
        options()
      );

      expect(failed.outcome).toBe('passed');
      expect(statusOf(failed, 'screenshot')).toBe('skipped');
      expect(failed.screenshot.reason).toBe('xcrun refused');
    });

    it(`is skipped, with the flag named, for --no-screenshot`, async () => {
      const captureScreenshot = vi.fn();
      const run = await runSmokePhasesAsync(
        deps({ captureScreenshot }),
        options({ screenshot: false })
      );

      expect(captureScreenshot).not.toHaveBeenCalled();
      expect(statusOf(run, 'screenshot')).toBe('skipped');
      expect(run.screenshot.reason).toContain('--no-screenshot');
      expect(run.outcome).toBe('passed');
    });

    it(`looks for a device when no phase before it drove one`, async () => {
      const probeDevice = vi.fn(async () => ({
        deviceId: 'SIM-9',
        backend: 'local-ios' as const,
        reason: null,
      }));
      const captureScreenshot = vi.fn(async () => screenshot({ deviceId: 'SIM-9' }));
      const run = await runSmokePhasesAsync(deps({ probeDevice, captureScreenshot }), options());

      // The backend travels with the device: the picture is taken through a different tool for
      // each, and the phase that takes it must not guess.
      expect(captureScreenshot).toHaveBeenCalledWith('SIM-9', 'local-ios');
      // And it travels back out. This used to assert `null` — the device the screenshot phase found
      // was reported nowhere but inside the screenshot — and live that read as "no device was
      // involved" over a run that had driven a billed cloud session (F98).
      expect(run.deviceId).toBe('SIM-9');
      expect(run.deviceBackend).toBe('local-ios');
      expect(run.screenshot.deviceId).toBe('SIM-9');
    });
  });

  it(`times every phase and the run`, async () => {
    const run = await runSmokePhasesAsync(deps(), options());

    expect(run.durationMs).toBeGreaterThan(0);
    for (const phase of run.phases.filter((entry) => entry.status !== 'skipped')) {
      expect(phase.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it(`gives every phase that did not run a reason`, async () => {
    const run = await runSmokePhasesAsync(
      deps({ discoverDevServer: async () => discovery({ reachable: false }) }),
      options()
    );

    for (const phase of run.phases.filter((entry) => entry.status === 'skipped')) {
      expect(phase.reason).toEqual(expect.any(String));
      expect(phase.reason).not.toBe('');
    }
  });
});
