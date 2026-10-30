// @ref llp/0026-dev-owns-the-open.rfc.md
// @ref llp/0035-one-device-per-worktree.rfc.md §How `dev` uses it
//
// `dev` with devices on: the open it performs once the dev server reports its port, on the device
// it bound, and the device `--plan` previews. The harness turns devices off; these cases turn them
// on with the stub `adb` of a fake Android SDK, so they run on every OS and never touch this
// machine's devices.
import fs from 'node:fs';

import {
  executeAgentCliAsync,
  installStubFingerprintAsync,
  killAsync,
  readStubExpoInvocations,
  setupFixtureAsync,
  spawnAgentCli,
  stubExpoEnv,
  waitForDevLockAsync,
} from '../utils';
import {
  androidBindingFixture,
  EMULATOR_SERIAL,
  installStubAdbAsync,
  installStubXcrunAsync,
  stubEmulatorStatePath,
} from './installedAppStubs';

/** The second instance the stub `adb` lists, and the one each fixture binds. */
const BOUND_SERIAL = 'emulator-5556';

/** Copy a fixture with two emulator instances up, bound to the second one, and devices on. */
async function setupAsync(fixtureName: string) {
  const projectRoot = await setupFixtureAsync(fixtureName);
  await installStubFingerprintAsync(projectRoot);
  const adb = await installStubAdbAsync(projectRoot, 'host.exp.exponent', { bound: false });
  await fs.promises.writeFile(stubEmulatorStatePath(projectRoot), `${BOUND_SERIAL}\n`);
  await androidBindingFixture(projectRoot, BOUND_SERIAL);
  // No simulator, so nothing this run probes reaches the iOS devices of this machine.
  await installStubXcrunAsync(projectRoot);
  const env = { ...stubExpoEnv(projectRoot), ...adb.env, AGENT_CLI_NO_DEVICE: '0' };
  return { projectRoot, adb, env };
}

describe('@expo/agent-cli dev, with devices on', () => {
  // The open is armed when the dev server reports its port, so the stub serves for a while. The
  // first row is the control: the same window is long enough for an open that does happen.
  it.each([
    ['opens Expo Go on the bound device', ['--android'], {}, true],
    ['opens nothing under --no-open', ['--android', '--no-open'], {}, false],
    ['opens nothing for the web target, which is served rather than opened', ['--web'], {}, false],
    ['opens nothing with devices off', ['--android'], { AGENT_CLI_NO_DEVICE: '1' }, false],
  ])('%s once the dev server reports its port', async (_case, flags, devices, opened) => {
    const { projectRoot, adb, env } = await setupAsync('go-app');

    const result = await executeAgentCliAsync(projectRoot, ['dev', ...flags], {
      env: {
        ...env,
        ...devices,
        RCT_METRO_PORT: '8613',
        STUB_EXPO_LISTEN: '1',
        STUB_EXPO_DELAY_MS: '2000',
      },
    });

    expect(result.exitCode).toBe(0);
    const port = readStubExpoInvocations(projectRoot)[0]!.args.at(-1);
    const opens = adb
      .calls()
      .filter((args) => args.includes('am') && args.includes('start'))
      .map((args) => [args[1], args.at(-1)!.replace(/^'|'$/g, '')]);
    expect(opens).toEqual(opened ? [[BOUND_SERIAL, `exp://127.0.0.1:${port}/--/?`]] : []);
    // A run that opens nothing says nothing about an open, not even that one failed.
    const said = result.all
      .split(/\r?\n/)
      .filter((line) => /Opened the app|app was not opened/.test(line));
    expect(said).toEqual(opened ? ['Opened the app on the Android device.'] : []);
  });

  describe('--plan --device', () => {
    it(`offers the run of a plan that binds, with the caller's --device and --port`, async () => {
      const { projectRoot, env } = await setupAsync('dev-client-app');

      const result = await executeAgentCliAsync(
        projectRoot,
        [
          'dev',
          '--android',
          '--local',
          '--plan',
          '--device',
          EMULATOR_SERIAL,
          '--port',
          '8091',
          '--json',
        ],
        { env }
      );

      const plan = JSON.parse(result.stdout);
      expect(plan.explicitDevice).toMatchObject({ refuses: false });
      expect(plan.steps.find((step: { id: string }) => step.id === 'run').argv).toEqual([
        'expo',
        'run:android',
        '--port',
        '8091',
        '--device',
        EMULATOR_SERIAL,
      ]);
      expect(plan.followups.find((followup: { id: string }) => followup.id === 'dev').command).toBe(
        `npx @expo/agent-cli dev --android --local --device ${EMULATOR_SERIAL} --port 8091 --json --detach --wait-ready`
      );
    });

    // The plan stops on the running server, so it previews no device and asks no device tool.
    it("previews no device while this project's dev server runs", async () => {
      const { projectRoot, adb, env } = await setupAsync('dev-client-app');
      const server = spawnAgentCli(projectRoot, ['start', '--port', '8614'], {
        env: { ...env, STUB_EXPO_LISTEN: '1', STUB_EXPO_DELAY_MS: '30000' },
      });

      try {
        expect(await waitForDevLockAsync(projectRoot)).toMatchObject({ port: 8614 });
        // The server's own start reads its binding; the plan's calls are the ones after it.
        const before = adb.calls().length;
        const result = await executeAgentCliAsync(
          projectRoot,
          [
            'dev',
            '--android',
            '--local',
            '--plan',
            '--device',
            EMULATOR_SERIAL,
            '--port',
            '8091',
            '--json',
          ],
          { env }
        );

        const plan = JSON.parse(result.stdout);
        expect(plan.steps).toEqual([]);
        expect(plan.explicitDevice).toBeUndefined();
        expect(plan.reasons).not.toContainEqual(expect.stringContaining('reuse or start'));
        expect(plan.followups.map((followup: { id: string }) => followup.id)).toEqual([
          'dev-server-running',
        ]);
        expect(adb.calls().slice(before)).toEqual([]);
      } finally {
        await killAsync(server);
      }
    });
  });
});
