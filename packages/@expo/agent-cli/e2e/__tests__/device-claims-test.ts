// @ref llp/0030-one-device-per-agent.rfc.md §The registry
//
// Two worktrees on one machine get two devices, through the published bin. The unit tests prove the
// allocation against a fake registry; this proves the claim crosses processes: `dev --ios` in one
// project claims and boots one simulator and builds onto it, the second project's takes the other,
// and `dev:stop` gives the first one back.
//
// The fixture's plan builds (its fingerprint cannot be proven), and the build step is where the
// device is claimed, so the stub `expo run:ios` receiving `--device` is part of what is pinned.
import fs from 'node:fs';
import path from 'node:path';

import type { DeviceClaim } from '../../src/deviceClaims';
import {
  canonicalRoot,
  executeAgentCliAsync,
  getTemporaryPath,
  pathEnvVars,
  readStubExpoInvocations,
  setupFixtureAsync,
  stubExpoEnv,
} from '../utils';
import { installStubXcrunAsync } from './installedAppStubs';

const SIMULATORS = [
  { udid: 'E2E-CLAIM-SIM-A', name: 'iPhone 17' },
  { udid: 'E2E-CLAIM-SIM-B', name: 'iPhone 17 Pro' },
];

describe('device claims across two worktrees', () => {
  let machine: string;
  let expoHome: string;
  let xcrunBin: string;
  let readXcrun: () => string[][];
  const projects: string[] = [];

  beforeEach(async () => {
    // One machine: one stub simctl whose boots both projects see, and one registry.
    machine = getTemporaryPath();
    expoHome = path.join(machine, 'expo-home');
    await fs.promises.mkdir(expoHome, { recursive: true });
    const xcrun = await installStubXcrunAsync(machine, { simulators: SIMULATORS });
    xcrunBin = xcrun.binDir;
    readXcrun = xcrun.calls;
  });

  afterEach(async () => {
    for (const projectRoot of projects.splice(0)) {
      await executeAgentCliAsync(projectRoot, ['dev:stop', '--json'], {
        env: envFor(projectRoot),
        reject: false,
      });
    }
  });

  function envFor(projectRoot: string): Record<string, string> {
    const { PATH: withExpo = '' } = stubExpoEnv(projectRoot);
    return {
      ...pathEnvVars(`${xcrunBin}${path.delimiter}${withExpo}`),
      __UNSAFE_EXPO_HOME_DIRECTORY: expoHome,
      // This test is about the device, so the harness switch that keeps runs off devices is off;
      // the only device tool here is the stub above.
      AGENT_CLI_NO_DEVICE: '0',
    };
  }

  function claims(): DeviceClaim[] {
    const directory = path.join(expoHome, 'agent-cli', 'devices');
    return fs.existsSync(directory)
      ? fs
          .readdirSync(directory)
          .filter((name) => name.endsWith('.json'))
          .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')))
      : [];
  }

  /** `dev --ios` in a new project; the device its build step was pinned to, and its root. */
  async function devAsync(): Promise<{ projectRoot: string; runDevice: string | undefined }> {
    const projectRoot = await setupFixtureAsync('dev-client-fresh-app');
    projects.push(projectRoot);
    // The exit code is the stub build's business; the claim is made before the build runs.
    await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--json'], {
      env: envFor(projectRoot),
      reject: false,
    });
    const run = readStubExpoInvocations(projectRoot).find(({ args }) => args[0] === 'run:ios');
    return {
      projectRoot: canonicalRoot(projectRoot),
      runDevice: run?.args[run.args.indexOf('--device') + 1],
    };
  }

  // Off macOS the toolchain probe settles iOS as impossible, so the plan never runs `expo run:ios`.
  it.skipIf(process.platform !== 'darwin')(
    'gives each worktree its own simulator, and dev:stop gives it back',
    async () => {
      const first = await devAsync();
      const second = await devAsync();

      const byRoot = new Map(claims().map((claim) => [claim.projectRoot, claim.id]));
      expect(byRoot.get(first.projectRoot)).toBe(first.runDevice);
      expect(byRoot.get(second.projectRoot)).toBe(second.runDevice);
      expect(first.runDevice).toBeDefined();
      expect(first.runDevice).not.toBe(second.runDevice);
      expect(
        readXcrun()
          .filter((args) => args[0] === 'simctl' && args[1] === 'boot')
          .map((args) => args[2])
          .sort()
      ).toEqual(SIMULATORS.map(({ udid }) => udid).sort());

      const stopped = await executeAgentCliAsync(projects[0]!, ['dev:stop', '--json'], {
        env: envFor(projects[0]!),
      });
      // This CLI booted the simulator, so the stop shuts it down before it gives the claim back.
      expect(JSON.parse(stopped.stdout).devices).toEqual([
        { id: first.runDevice, backend: 'local-ios', released: true, shutDown: true, reason: null },
      ]);
      expect(readXcrun().filter((args) => args[0] === 'simctl' && args[1] === 'shutdown')).toEqual([
        ['simctl', 'shutdown', first.runDevice],
      ]);
      expect(claims().map(({ projectRoot }) => projectRoot)).toEqual([second.projectRoot]);
    }
  );

  // @ref llp/0021-honest-reports.rfc.md — a session left running is named, not dropped.
  it('keeps an EAS session claim that a plain dev:stop did not stop, and says it still runs', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    projects.push(projectRoot);
    const directory = path.join(expoHome, 'agent-cli', 'devices');
    await fs.promises.mkdir(directory, { recursive: true });
    const now = new Date().toISOString();
    const claim: DeviceClaim = {
      backend: 'eas',
      platform: 'android',
      id: 'e2e-session-1',
      projectRoot: canonicalRoot(projectRoot),
      pid: 1,
      claimedAt: now,
      touchedAt: now,
      created: true,
      booted: false,
    };
    fs.writeFileSync(path.join(directory, 'eas-e2e-session-1.json'), JSON.stringify(claim));

    const stopped = await executeAgentCliAsync(projectRoot, ['dev:stop', '--json'], {
      env: envFor(projectRoot),
    });

    expect(stopped.exitCode).toBe(0);
    expect(JSON.parse(stopped.stdout).devices).toEqual([
      {
        id: 'e2e-session-1',
        backend: 'eas',
        released: false,
        shutDown: false,
        reason: expect.stringContaining('dev:stop --eas'),
      },
    ]);
    expect(claims()).toEqual([claim]);
  });
});
