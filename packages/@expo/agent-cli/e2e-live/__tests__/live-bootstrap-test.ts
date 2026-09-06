// @ref llp/0022-live-tier.plan.md §live-bootstrap
// @ref llp/0005-runtime-loop-tools.rfc.md §The run brings its own environment
//
// The eighth suite, and the one that runs where every other suite refuses. `live-local`'s gate
// demands a **booted** simulator, and `pickSimulator` prefers a booted device — so on the machine
// this tier usually runs on, `smoke`'s `boot-device` phase never runs, and the claim "a run on a
// cold machine brings its own device and puts it back" had only ever been made by the stub tier,
// which cannot boot anything. This suite's gate is the inverse: it skips while any simulator is
// booted, and runs on the machine nobody is using — a CI box, or a laptop whose simulators are
// shut down for the night.
//
// One test, one `smoke` run, and that is the budget on purpose: the run this suite exists for
// costs a scaffold, a simulator boot (~1 min), a first Metro compile, and possibly an Expo Go
// download — every one of them an act `smoke` performs itself, which is exactly what is being
// measured. A second test would pay the boot again and answer nothing new: after the first run
// the machine is back to cold, because putting it back is one of the assertions.

import fs from 'node:fs';

import { allOf, bootstrapSimulatorGate, builtBinGate, describeLive } from '../prereq';
import {
  LiveRun,
  execAsync,
  expectExit,
  httpStatusAsync,
  parseJson,
  runLiveAsync,
  waitForAsync,
} from '../utils';

const simulatorProbe = bootstrapSimulatorGate();
const gate = allOf(builtBinGate(), simulatorProbe.gate);

/** The simulators smoke may pick from, so the suite can tell its device from a stranger's. */
const POOL = new Set(simulatorProbe.simulators.map((simulator) => simulator.udid));

describeLive('live-bootstrap', gate)('live-bootstrap: smoke brings its own device', () => {
  const run = new LiveRun('live-bootstrap');
  let projectRoot = '';

  beforeAll(async () => {
    run.prepare();

    const created = await runLiveAsync(
      run,
      run.tempDir,
      ['new', 'bootapp', '--name', 'Boot App', '--json'],
      { label: 'new' }
    );
    run.spend.scaffolds += 1;
    expectExit(created, 0, '@expo/agent-cli new must create and install a project');
    projectRoot = parseJson(created).projectRoot;

    // Registered first so it runs last, after the two safety nets below have nothing left to need.
    run.onCleanup('scratch project', () => {
      if (!process.env.AGENT_CLI_LIVE_KEEP) {
        fs.rmSync(run.tempDir, { recursive: true, force: true });
      }
    });
    // Both of these are `smoke`'s own job — it stops the dev server it started and shuts down the
    // device it booted on every path out. They are here for the run that dies where smoke cannot
    // clean: a vitest timeout kills the child mid-walk, and a booted simulator this suite caused
    // must not outlive it ([[0022-live-tier]] §Every suite cleans up after itself).
    run.onCleanup('dev:stop', async () => {
      await runLiveAsync(run, projectRoot, ['dev:stop', '--json'], { label: 'cleanup-dev-stop' });
    });
    run.onCleanup('shut down a leaked simulator', async () => {
      const listed = await execAsync('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'], {
        timeoutMs: 60_000,
      });
      for (const devices of Object.values(
        JSON.parse(listed.stdout || '{"devices":{}}').devices as Record<string, any[]>
      )) {
        for (const device of devices) {
          if (device.state === 'Booted' && POOL.has(device.udid)) {
            await execAsync('xcrun', ['simctl', 'shutdown', device.udid], { timeoutMs: 60_000 });
          }
        }
      }
    });
  }, 600_000);

  afterAll(async () => {
    await run.cleanUpAsync();
    console.log(run.costLine());
  });

  it('smoke boots a simulator it chose, passes the gate, and puts the machine back', async () => {
    const result = await runLiveAsync(run, projectRoot, ['smoke', '--ios', '--json'], {
      label: 'smoke-bootstrap',
    });
    expectExit(result, 0, 'a cold machine is not a broken app: smoke brings what the gate needs');
    const report = parseJson(result);
    expect(report.ok).toBe(true);
    // `passed` is the strong form: every phase that ran answered yes — so the boot, the start, the
    // attach, the runtime read, and the screenshot all worked on a device this run brought itself.
    expect(report.outcome).toBe('passed');

    const status = Object.fromEntries(report.phases.map((phase: any) => [phase.id, phase.status]));
    // The two conditional phases this suite exists for. `boot-device` must be in the list — a run
    // reports only the acts it performed, so its presence *is* the claim that nothing was booted
    // when it started. `start-dev-server` likewise: no other suite lets smoke start its own.
    expect(status['boot-device']).toBe('ok');
    expect(status['start-dev-server']).toBe('ok');
    expect(status.app).toBe('ok');
    expect(status.runtime).toBe('ok');
    expect(status.screenshot).toBe('ok');
    expect(fs.existsSync(report.screenshot.path)).toBe(true);
    expect(fs.statSync(report.screenshot.path).size).toBeGreaterThan(1000);

    // The environment block is the report saying what it did to the machine, and here it must say
    // everything: nothing was found, so everything the run needed it started — and put back.
    expect(report.environment.device).toBe('booted');
    expect(report.environment.deviceChoice).not.toBeNull();
    expect(POOL.has(report.deviceId)).toBe(true);
    expect(report.environment.devServer).toBe('started');
    const cleanup = Object.fromEntries(
      report.environment.cleanup.map((entry: any) => [entry.resource, entry])
    );
    expect(cleanup['device']).toMatchObject({ ok: true, target: report.deviceId });
    expect(cleanup['dev-server']).toMatchObject({ ok: true });

    // The report's word, checked against the machine: the simulator it booted is shut down again,
    // and the port its dev server held answers nothing. A cleanup that only exists in the JSON is
    // the exact failure this tier is for.
    const shutDown = await waitForAsync(async () => {
      const listed = await execAsync('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'], {
        timeoutMs: 60_000,
      });
      const devices = Object.values(
        JSON.parse(listed.stdout || '{"devices":{}}').devices as Record<string, any[]>
      ).flat();
      return !devices.some((device) => device.state === 'Booted');
    }, 60_000);
    expect(shutDown).toBe(true);
    expect(await httpStatusAsync(`${report.devServerUrl}/status`)).toBe(0);
  });
});
