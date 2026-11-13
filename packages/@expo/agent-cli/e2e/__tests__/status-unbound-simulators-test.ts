// @ref llp/0004-smart-start-and-project-state.rfc.md §Reported by status
//
// With no simulator bound to this worktree, `status` still sees the booted simulators of this Mac.
// It must say they are not bound here, and it must not tell an agent to boot another one
// (llp/0035: one device per worktree).
import fs from 'node:fs';

import { makeTarget } from '../../src/runtime/__tests__/targetSelectionFixtures';
import { bindOtherWorktreeAsync } from '../runtimeTargetFixtures';
import { writeCloudBindingAsync } from '../stubEas';
import {
  executeAgentCliAsync,
  expoHomeOf,
  installStubFingerprintAsync,
  setupFixtureAsync,
  startStubDevServerAsync,
} from '../utils';
import {
  BOOTED_SIMULATOR,
  SECOND_SIMULATOR,
  SIMULATOR_NAME,
  SIMULATOR_UDID,
  bindingFixture,
  installStubAdbAsync,
  installStubXcrunAsync,
} from './installedAppStubs';

const WITH_DEVICES = { AGENT_CLI_NO_DEVICE: '0' };
const BIND_COMMAND = 'npx @expo/agent-cli dev --ios --detach --wait-ready';

type Report = {
  installed: { platforms: { platform: string; [key: string]: unknown }[] } | null;
  devServer?: { owners?: Record<string, unknown> };
};

// Simulators exist only on macOS.
describe.skipIf(process.platform !== 'darwin')(
  '@expo/agent-cli status with a booted simulator this worktree did not bind',
  () => {
    let projectRoot: string;

    beforeEach(async () => {
      projectRoot = await setupFixtureAsync('dev-client-fresh-app');
      await installStubFingerprintAsync(projectRoot);
      const appJsonPath = `${projectRoot}/app.json`;
      const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
      appJson.expo.ios = { bundleIdentifier: 'com.example.installedapp' };
      fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2));
    });

    async function iosRowAsync(args: string[] = []) {
      const result = await executeAgentCliAsync(projectRoot, ['status', '--json', ...args], {
        env: { ...WITH_DEVICES, STUB_FINGERPRINT_HASH: 'any' },
      });
      const report: Report = JSON.parse(result.stdout);
      return report.installed?.platforms.find((entry) => entry.platform === 'ios');
    }

    it('names the booted simulators and the command that binds one', async () => {
      await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR], bind: false });

      const row = await iosRowAsync();

      expect(row).toMatchObject({
        reason: 'no-device',
        unboundSimulators: [SIMULATOR_NAME],
        recommendation: expect.stringContaining(
          `1 iOS simulator is booted (${SIMULATOR_NAME}), and none is bound to this worktree`
        ),
      });
      expect(row?.recommendation).toContain(BIND_COMMAND);
      expect(row?.recommendation).not.toContain('Boot one');
    });

    it('does not name a booted simulator that another worktree bound', async () => {
      await installStubXcrunAsync(projectRoot, {
        simulators: [BOOTED_SIMULATOR, SECOND_SIMULATOR],
        bind: false,
      });
      await bindOtherWorktreeAsync(projectRoot, SIMULATOR_UDID, SIMULATOR_NAME);

      const row = await iosRowAsync();

      expect(row).toMatchObject({
        reason: 'no-device',
        unboundSimulators: [SECOND_SIMULATOR.name],
      });
    });

    it('says only that none is bound when the simulator list fails', async () => {
      await installStubXcrunAsync(projectRoot, {
        simulators: [BOOTED_SIMULATOR],
        bind: false,
        listFails: true,
      });

      const row = await iosRowAsync();

      expect(row).toMatchObject({
        reason: 'no-device',
        recommendation: expect.stringContaining('No iOS simulator is bound to this worktree'),
      });
      expect(row?.recommendation).toContain(BIND_COMMAND);
      expect(row?.recommendation).not.toContain('Boot one');
      expect(row?.recommendation).not.toContain(SIMULATOR_NAME);
      expect(row).not.toHaveProperty('unboundSimulators');
    });

    it('says none is bound, not that none is booted, when no simulator is booted', async () => {
      await installStubXcrunAsync(projectRoot);

      const row = await iosRowAsync();

      expect(row).toMatchObject({
        reason: 'no-device',
        recommendation: expect.stringContaining('No iOS simulator is bound to this worktree'),
      });
      expect(row?.recommendation).toContain(BIND_COMMAND);
      expect(row?.recommendation).not.toContain('Boot one');
    });

    it('adds the booted simulators to the row of an EAS session', async () => {
      await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR], bind: false });
      await writeCloudBindingAsync(expoHomeOf(projectRoot), fs.realpathSync(projectRoot), {
        id: 'sess-1',
        platform: 'ios',
      });

      const row = await iosRowAsync();

      expect(row).toMatchObject({
        reason: 'cloud-session',
        unboundSimulators: [SIMULATOR_NAME],
        commands: [],
        recommendation: `not checked; this check reads local devices, and the app runs on EAS Simulator session sess-1; 1 iOS simulator is booted (${SIMULATOR_NAME}), and none is bound to this worktree.`,
      });
    });

    describe('the dev server line', () => {
      const liveTarget = (id: string, deviceName: string) =>
        makeTarget({
          id,
          appId: 'com.example.installedapp',
          deviceName,
          webSocketDebuggerUrl: `ws://127.0.0.1:1/inspector/debug?device=${id}&page=1`,
        });

      let adbEnv: Record<string, string>;

      // The default stub emulator reports a model that claims an Android session's app.
      beforeEach(async () => {
        const adb = await installStubAdbAsync(projectRoot, 'com.example.installedapp', {
          attached: false,
          bound: false,
        });
        adbEnv = adb.env;
      });

      async function statusLineAsync(
        targets: ReturnType<typeof makeTarget>[],
        env: Record<string, string> = WITH_DEVICES,
        { json = false }: { json?: boolean } = {}
      ) {
        const stub = await startStubDevServerAsync({ projectRoot, targets });
        const runAsync = (args: string[]) =>
          executeAgentCliAsync(projectRoot, ['status', ...args, '--dev-server-url', stub.url], {
            env: { ...adbEnv, ...env, STUB_FINGERPRINT_HASH: 'any' },
          });
        try {
          const text = await runAsync([]);
          const line =
            text.stdout.split('\n').find((entry) => entry.startsWith('dev server')) ?? '';
          const owners = json
            ? (JSON.parse((await runAsync(['--json'])).stdout) as Report).devServer?.owners
            : undefined;
          return { line, owners };
        } finally {
          await stub.close();
        }
      }

      it.each([
        { name: 'an iOS session', platform: 'ios' as const, app: 'iPhone 17' },
        {
          name: "an Android session's own app",
          platform: 'android' as const,
          app: 'sdk_gphone64_arm64 - 15 - API 35',
        },
      ])(
        "splits the count into this worktree's EAS session and a local simulator not bound here: $name",
        async ({ platform, app }) => {
          await installStubXcrunAsync(projectRoot, {
            simulators: [BOOTED_SIMULATOR],
            bind: false,
          });
          await writeCloudBindingAsync(expoHomeOf(projectRoot), fs.realpathSync(projectRoot), {
            id: 'sess-1',
            platform,
          });

          const { line, owners } = await statusLineAsync(
            [liveTarget('local', SIMULATOR_NAME), liveTarget('session', app)],
            WITH_DEVICES,
            { json: true }
          );

          expect(line).toContain(
            `2 apps connected: 1 on this worktree's EAS session, 1 on a local simulator not bound here (${SIMULATOR_NAME})`
          );
          expect(owners).toEqual({
            simulatorApps: [],
            localApps: [SIMULATOR_NAME],
            otherWorktreeApps: [],
            sessionApps: 1,
            otherApps: 0,
          });
        }
      );

      it('adds no split when a simulator of the same name is the one this worktree bound', async () => {
        await installStubXcrunAsync(projectRoot, {
          simulators: [BOOTED_SIMULATOR, { ...SECOND_SIMULATOR, name: SIMULATOR_NAME }],
          bind: false,
        });
        await bindingFixture(projectRoot, SIMULATOR_UDID);

        const { line, owners } = await statusLineAsync(
          [liveTarget('own', SIMULATOR_NAME)],
          WITH_DEVICES,
          { json: true }
        );

        expect(line).toContain('1 app connected');
        expect(line).not.toContain('not bound here');
        expect(owners).toBeUndefined();
      });

      it('does not call an Android app an app on the EAS session', async () => {
        await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR], bind: false });
        await writeCloudBindingAsync(expoHomeOf(projectRoot), fs.realpathSync(projectRoot), {
          id: 'sess-1',
        });

        const { line } = await statusLineAsync([
          liveTarget('local', SIMULATOR_NAME),
          liveTarget('phone', 'sdk_gphone64_arm64 - 15 - API 35'),
        ]);

        expect(line).toContain('1 on a local simulator not bound here');
        expect(line).not.toContain('EAS session');
      });

      it("names the app on this worktree's own simulator, not as another app", async () => {
        await installStubXcrunAsync(projectRoot, {
          simulators: [BOOTED_SIMULATOR, SECOND_SIMULATOR],
          bind: false,
        });
        await bindingFixture(projectRoot, SIMULATOR_UDID);

        const { line, owners } = await statusLineAsync(
          [liveTarget('own', SIMULATOR_NAME), liveTarget('free', SECOND_SIMULATOR.name)],
          WITH_DEVICES,
          { json: true }
        );

        expect(line).toContain(
          `2 apps connected: 1 on this worktree's simulator, 1 on a local simulator not bound here (${SECOND_SIMULATOR.name})`
        );
        expect(owners).toEqual({
          simulatorApps: [SIMULATOR_NAME],
          localApps: [SECOND_SIMULATOR.name],
          otherWorktreeApps: [],
          sessionApps: 0,
          otherApps: 0,
        });
      });

      it("names an app on another worktree's simulator", async () => {
        await installStubXcrunAsync(projectRoot, {
          simulators: [BOOTED_SIMULATOR, SECOND_SIMULATOR],
          bind: false,
        });
        await bindOtherWorktreeAsync(projectRoot, SECOND_SIMULATOR.udid, SECOND_SIMULATOR.name);

        const { line, owners } = await statusLineAsync(
          [liveTarget('foreign', SECOND_SIMULATOR.name)],
          WITH_DEVICES,
          { json: true }
        );

        expect(line).toContain(
          `1 app connected: 1 on another worktree's simulator (${SECOND_SIMULATOR.name})`
        );
        expect(owners).toMatchObject({ otherWorktreeApps: [SECOND_SIMULATOR.name] });
      });

      it('names a free twin as not bound here when another worktree bound the other one', async () => {
        await installStubXcrunAsync(projectRoot, {
          simulators: [BOOTED_SIMULATOR, { ...SECOND_SIMULATOR, name: SIMULATOR_NAME }],
          bind: false,
        });
        await bindOtherWorktreeAsync(projectRoot, SIMULATOR_UDID, SIMULATOR_NAME);

        const { line } = await statusLineAsync([liveTarget('twin', SIMULATOR_NAME)]);

        expect(line).toContain(
          `1 app connected: 1 on a local simulator not bound here (${SIMULATOR_NAME})`
        );
        expect(line).not.toContain("another worktree's simulator");
      });

      it('does not guess which of two unplaced apps is the EAS session', async () => {
        await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR], bind: false });
        await writeCloudBindingAsync(expoHomeOf(projectRoot), fs.realpathSync(projectRoot), {
          id: 'sess-1',
        });

        const { line, owners } = await statusLineAsync(
          [
            liveTarget('local', SIMULATOR_NAME),
            liveTarget('one', 'iPhone 17'),
            liveTarget('two', 'iPhone 16e'),
          ],
          WITH_DEVICES,
          { json: true }
        );

        expect(line).toContain('3 apps connected: 1 on a local simulator not bound here');
        expect(line).toContain('2 other');
        expect(line).not.toContain('EAS session');
        expect(owners).toMatchObject({ localApps: [SIMULATOR_NAME], sessionApps: 0, otherApps: 2 });
      });

      it('asks no simulator list when devices are disabled', async () => {
        const xcrun = await installStubXcrunAsync(projectRoot, {
          simulators: [BOOTED_SIMULATOR],
          bind: false,
        });

        await statusLineAsync([liveTarget('local', SIMULATOR_NAME)], { AGENT_CLI_NO_DEVICE: '1' });

        expect(xcrun.calls().filter((args) => args[1] === 'list')).toEqual([]);
      });
    });
  }
);
