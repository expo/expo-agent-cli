// @ref llp/0022-live-tier.plan.md §live-devclient
// @ref llp/0005-runtime-loop-tools.rfc.md §The gate installs the app
//
// The iOS twin of `live-devclient`. `live-devclient` runs the runtime family on an Android
// development build and records that iOS was a wall: every local iOS open goes through
// `xcrun simctl openurl`, and on iOS 26.5 that raised a springboard "Open in …?" that nothing here
// could answer, on every call and not only the first. That wall is what `src/device/approveScheme.ts`
// was written to remove — it pre-approves the scheme and marks the dev-menu onboarding seen with
// `simctl spawn … defaults write` before the open, so the link launches the app instead of a modal.
//
// So this suite is the check on that claim: the same runtime family, on an iOS development build,
// with no person to tap Open. If it ever regresses, `navigate` here goes back to exit 22 and this
// file says so.
//
// Shaped like `live-devclient`: it does not scaffold. An iOS development build costs about fifteen
// minutes of Xcode, and a live suite may not spend that ([[0022-live-tier]] §What green claims). So
// `AGENT_CLI_LIVE_IOS_DEVCLIENT_PROJECT` names a project somebody has run `npx expo run:ios` in, the
// gate checks the app is installed on the booted simulator **and** that the build is recorded, and
// the project is used in place. The lab screen is written into it in `beforeAll` — that is served by
// Metro over the wire, so it needs no rebuild — to give the interact commands known testIDs.

import fs from 'node:fs';
import path from 'node:path';

import {
  allOf,
  bootedSimulatorGate,
  builtBinGate,
  iosDevBuildGate,
  iosDevClientProjectGate,
  type DevClientProject,
  type Simulator,
} from '../prereq';
import {
  LIVE_PORT_BASE,
  LiveRun,
  expectExit,
  findFreePortAsync,
  fixturesDir,
  httpStatusAsync,
  parseJson,
  runLiveAsync,
  waitForAsync,
} from '../utils';

const projectProbe = iosDevClientProjectGate();
const simulatorProbe = bootedSimulatorGate();
const project = projectProbe.project as DevClientProject;
const simulator = simulatorProbe.simulator as Simulator;
const gate = allOf(
  builtBinGate(),
  simulatorProbe.gate,
  projectProbe.gate,
  iosDevBuildGate(projectProbe.project, simulatorProbe.simulator)
);

if (!gate.ok) {
  console.log(`[live] SKIPPED live-ios-devclient: ${gate.reason}`);
}
const describeIosDevClient = gate.ok ? describe : describe.skip;

/** The port this suite's dev server runs on, chosen in `beforeAll`. */
let PORT = LIVE_PORT_BASE + 80;

/** @ref llp/0022 §What a live assertion may be — a bound, never an expectation. */
const BOUND_MS = 120_000;

/** The route the lab screen lives at, reachable because the suite registers a tab trigger for it. */
const LAB_ROUTE = '/lab';

describeIosDevClient('live-ios-devclient: the loop on a real iOS development build', () => {
  const run = new LiveRun('live-ios-devclient');
  const projectRoot = project?.root ?? '';
  const labSource = gate.ok
    ? fs.readFileSync(path.join(fixturesDir, 'lab', 'lab.tsx'), 'utf8')
    : '';

  beforeAll(async () => {
    run.prepare();
    PORT = await findFreePortAsync(LIVE_PORT_BASE + 80);

    // The project is somebody's, not this run's, so cleanups touch only its dev server and the app —
    // never the directory. Registered before the start that needs them.
    run.onCleanup('runtime:stop', async () => {
      await runLiveAsync(run, projectRoot, ['runtime:stop', '--ios', '--json'], {
        label: 'cleanup-runtime-stop',
      });
    });
    run.onCleanup('dev:stop', async () => {
      await runLiveAsync(run, projectRoot, ['dev:stop', '--json'], { label: 'cleanup-dev-stop' });
      const freed = await waitForAsync(
        async () => (await httpStatusAsync(`http://127.0.0.1:${PORT}/status`)) === 0,
        30_000
      );
      if (!freed) {
        throw new Error(`something still answers on port ${PORT} after dev:stop`);
      }
    });

    // The lab screen and the tab trigger that makes its route reachable — an insertion into the
    // scaffold's own tabs, so a template change fails here loudly rather than going stale. Written
    // to the project's src; Metro serves it, so no rebuild is needed.
    fs.writeFileSync(path.join(projectRoot, 'src', 'app', 'lab.tsx'), labSource);
    const tabsFile = path.join(projectRoot, 'src', 'components', 'app-tabs.tsx');
    const tabs = fs.readFileSync(tabsFile, 'utf8');
    const anchor = '</NativeTabs>';
    if (!tabs.includes(anchor)) {
      throw new Error(
        `${tabsFile} has no ${anchor} to insert the lab tab before — the template changed shape, so ` +
          `this harness needs updating (not a finding about the CLI)`
      );
    }
    if (!tabs.includes('name="lab"')) {
      fs.writeFileSync(
        tabsFile,
        tabs.replace(
          anchor,
          `  <NativeTabs.Trigger name="lab">\n` +
            `        <NativeTabs.Trigger.Label>Lab</NativeTabs.Trigger.Label>\n` +
            `      </NativeTabs.Trigger>\n    ${anchor}`
        )
      );
    }
    run.onCleanup('restore src', () => {
      fs.rmSync(path.join(projectRoot, 'src', 'app', 'lab.tsx'), { force: true });
      fs.writeFileSync(tabsFile, tabs);
    });

    // One detached dev server per project (llp/0004 §Daemonization), so stop any first — the project
    // is not this run's and may already have one on a port this suite did not choose.
    await runLiveAsync(run, projectRoot, ['dev:stop', '--json'], { label: 'dev-stop-before' });

    const started = await runLiveAsync(
      run,
      projectRoot,
      ['dev', '--detach', '--wait-ready', '--ios', '--yes', '--port', String(PORT), '--json'],
      { label: 'dev-detach' }
    );
    expectExit(started, 0, 'the gate said this project has a recorded ios build, so this must serve');
    const report = parseJson(started);
    expect(report.ready).toBe(true);
    expect(report.port).toBe(PORT);

    const attached = await waitForRuntimeAsync('beforeAll');
    if (!attached) {
      throw new Error(
        `the development build ${project.iosBundleId} did not connect to the dev server on port ` +
          `${PORT} within ${BOUND_MS}ms — open it by hand and read what it shows; a launcher stuck on ` +
          `its error screen is upstream, not this CLI`
      );
    }
  }, 300_000);

  afterAll(async () => {
    await run.cleanUpAsync();
    console.log(run.costLine());
  });

  /**
   * Wait until the development build's runtime answers. `runtime:eval` rather than a listed target:
   * a reload leaves the old page listed for a second with nothing behind it (F56).
   */
  async function waitForRuntimeAsync(label: string): Promise<boolean> {
    return waitForAsync(
      async () => {
        const probe = await runLiveAsync(run, projectRoot, ['runtime:eval', '1', '--ios', '--json'], {
          label: `await-runtime-${label}`,
        });
        return probe.exitCode === 0 && parseJson(probe).value === 1;
      },
      BOUND_MS,
      3_000
    );
  }

  // --- the plan and the launcher URL --------------------------------------------------------------

  it('plans a dev server rather than a build, and names the dev-client flag', async () => {
    const result = await runLiveAsync(run, projectRoot, ['dev', '--plan', '--ios', '--json'], {
      label: 'dev-plan',
    });
    expectExit(result, 0);
    const report = parseJson(result);
    // `expo prebuild` gives a CNG project checked-in native dirs, so a `dev-client-fresh` project
    // becomes `bare-fresh` after its first local build — the claim is the step, not the label.
    expect(['bare-fresh', 'dev-client-fresh']).toContain(report.rule);
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0].argv).toEqual(['expo', 'start', '--dev-client', '--ios']);
    expect(report.buildLocation).toBeNull();
  });

  it('offers the dev launcher URL and never the Expo Go one', async () => {
    const result = await runLiveAsync(run, projectRoot, ['status', '--json'], { label: 'status' });
    expectExit(result, 0);
    const report = parseJson(result);
    expect(report.devServer.running).toBe(true);
    const urls = report.devServer.openUrls as { target: string; url: string }[];
    expect(urls.map((entry) => entry.target)).toEqual(['dev-build']);
    expect(urls[0]!.url).toContain(`${project.scheme}://expo-development-client/?url=`);
    expect(urls[0]!.url).not.toContain('exp://');
  });

  // --- the wall this suite exists to prove is gone ------------------------------------------------

  // @ref llp/0005-runtime-loop-tools.rfc.md §The gate installs the app. On iOS 26.5 this used to
  // exit 22 with the simulator on a springboard "Open in …?" modal. `approveScheme` pre-approves the
  // scheme before the open, so the build's own screen comes up and the app attaches — no dialog.
  it('navigates a development build on iOS with no dialog to answer', async () => {
    const result = await runLiveAsync(run, projectRoot, ['navigate', LAB_ROUTE, '--ios', '--json'], {
      label: 'navigate',
    });
    expectExit(result, 0, 'approveScheme suppresses the springboard dialog that was the iOS wall');
    const report = parseJson(result);
    expect(report.deviceBackend).toBe('local-ios');
    expect(report.deviceId).toBe(simulator.udid);
    expect(report.url).toContain(`${project.scheme}://`);
    expect(report.url).not.toContain('exp://');
    expect(report.attached).toBe(true);
  });

  // --- the runtime family, which is the whole point of this file ----------------------------------

  it('evaluates JavaScript on the iOS development build', async () => {
    const result = await runLiveAsync(run, projectRoot, ['runtime:eval', '1+1', '--ios', '--json'], {
      label: 'runtime-eval',
    });
    expectExit(result, 0);
    expect(parseJson(result)).toMatchObject({ threw: false, type: 'number', value: 2 });
  });

  it('reads the screen with its testIDs', async () => {
    const result = await runLiveAsync(run, projectRoot, ['runtime:tree', '--ios', '--json'], {
      label: 'runtime-tree',
    });
    expectExit(result, 0);
    const testIDs = JSON.stringify(parseJson(result));
    expect(testIDs).toContain('inc-btn');
    expect(testIDs).toContain('name-input');
  });

  it('taps an element and verifies what changed', async () => {
    const result = await runLiveAsync(
      run,
      projectRoot,
      ['runtime:tap', 'inc-btn', '--verify', '--ios', '--json'],
      { label: 'runtime-tap' }
    );
    expectExit(result, 0);
    const report = parseJson(result);
    expect(report.tapped).toBe(true);
    expect(report.verified?.changed).toBe(true);
  });

  it('types into a real input, and refuses a testID that is not one with 20', async () => {
    const typed = await runLiveAsync(
      run,
      projectRoot,
      ['runtime:type', 'live-ios', '--testID', 'name-input', '--ios', '--json'],
      { label: 'runtime-type' }
    );
    expectExit(typed, 0);
    expect(parseJson(typed)).toMatchObject({ called: true, text: 'live-ios' });

    const refused = await runLiveAsync(
      run,
      projectRoot,
      ['runtime:type', 'x', '--testID', 'plain-text', '--ios', '--json'],
      { label: 'runtime-type-non-input' }
    );
    expectExit(refused, 20);
    expect(parseJson(refused).called).toBe(false);
  });

  it('reads the runtime error window over its own debugger connection', async () => {
    const result = await runLiveAsync(
      run,
      projectRoot,
      ['runtime:errors', '--ios', '--duration', '2s', '--json'],
      { label: 'runtime-errors' }
    );
    expectExit(result, 0);
    expect(parseJson(result).runtimeReadable).toBe(true);
  });

  it('reloads and is verified by the app reconnecting', async () => {
    const result = await runLiveAsync(run, projectRoot, ['runtime:reload', '--ios', '--json'], {
      label: 'runtime-reload',
    });
    expectExit(result, 0);
    expect(parseJson(result).reloaded).toBe(true);
    expect(await waitForRuntimeAsync('after-reload')).toBe(true);
  });

  it('smoke passes with eight phases on the iOS development build', async () => {
    const result = await runLiveAsync(run, projectRoot, ['smoke', '--ios', '--json'], {
      label: 'smoke',
    });
    expectExit(result, 0, 'a development build carries a CDP debugger on iOS, so every phase is reachable');
    const report = parseJson(result);
    expect(report.outcome).toBe('passed');
    const status = Object.fromEntries(report.phases.map((p: any) => [p.id, p.status]));
    expect(status.runtime).toBe('ok');
    expect(status.errors).toBe('ok');
  });

  it('stops the app on the device by its bundle identifier', async () => {
    const result = await runLiveAsync(run, projectRoot, ['runtime:stop', '--ios', '--json'], {
      label: 'runtime-stop',
    });
    expectExit(result, 0);
    expect(parseJson(result).stopped).toBe(true);
  });
});
