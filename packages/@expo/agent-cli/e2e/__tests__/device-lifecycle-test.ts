// @ref llp/0035-one-device-per-worktree.rfc.md §Lifecycle tests
// Two worktrees share one machine registry and simctl, through the published bin.
import fs from 'node:fs';
import path from 'node:path';

import { canonicalizeExistingPath as canonicalRoot } from '../../src/utils/dir';
import type { Binding } from '../../src/deviceBinding/types';
import {
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

describe('device lifecycle across two worktrees', () => {
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
      await executeAgentCliAsync(projectRoot, ['dev:stop', '--release', '--json'], {
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

  function bindings(): Binding[] {
    const directory = path.join(expoHome, 'agent-cli', 'bindings');
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
    // The exit code is the stub build's business; the binding is made before the build runs.
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
    'creates one simulator per worktree, keeps it on stop, and parks it on release',
    async () => {
      const first = await devAsync();
      const second = await devAsync();

      const byRoot = new Map(
        bindings().map((binding) => [
          binding.projectRoot,
          binding.device.backend === 'local-ios' ? binding.device.udid : null,
        ])
      );
      expect(byRoot.get(first.projectRoot)).toBe(first.runDevice);
      expect(byRoot.get(second.projectRoot)).toBe(second.runDevice);
      expect(first.runDevice).toBeDefined();
      expect(first.runDevice).not.toBe(second.runDevice);
      expect(
        readXcrun()
          .filter((args) => args[0] === 'simctl' && args[1] === 'bootstatus')
          .map((args) => args[2])
          .sort()
      ).toEqual([first.runDevice, second.runDevice].sort());

      expect(bindings()).toHaveLength(2);

      const kept = await executeAgentCliAsync(projects[0]!, ['dev:stop', '--json'], {
        env: envFor(projects[0]!),
      });
      expect(JSON.parse(kept.stdout).devices).toEqual([
        expect.objectContaining({ id: first.runDevice, released: null }),
      ]);
      expect(readXcrun().some((args) => args[1] === 'shutdown')).toBe(false);
      const stopped = await executeAgentCliAsync(
        projects[0]!,
        ['dev:stop', '--release', '--json'],
        {
          env: envFor(projects[0]!),
        }
      );
      // This CLI booted the simulator, so the stop shuts it down before it gives the binding back.
      expect(JSON.parse(stopped.stdout).devices).toEqual([
        expect.objectContaining({
          id: first.runDevice,
          backend: 'local-ios',
          platform: 'ios',
          released: true,
          shutDown: true,
          reason: null,
        }),
      ]);
      expect(readXcrun().filter((args) => args[0] === 'simctl' && args[1] === 'shutdown')).toEqual([
        ['simctl', 'shutdown', first.runDevice],
      ]);
      expect(bindings()).toHaveLength(2);
      expect(
        Date.parse(bindings().find((b) => b.projectRoot === first.projectRoot)!.expiresAt)
      ).toBeLessThanOrEqual(Date.now());
    }
  );
});
