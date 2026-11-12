// @ref llp/0004-smart-start-and-project-state.rfc.md §Reported by status
//
// With no simulator bound to this worktree, `status` still sees the booted simulators of this Mac.
// It must say they are not bound here, and it must not tell an agent to boot another one
// (llp/0035: one device per worktree).
import fs from 'node:fs';

import { makeTarget } from '../../src/runtime/__tests__/targetSelectionFixtures';
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
  SIMULATOR_NAME,
  SIMULATOR_UDID,
  bindingFixture,
  installStubXcrunAsync,
} from './installedAppStubs';

const WITH_DEVICES = { AGENT_CLI_NO_DEVICE: '0' };
const BIND_COMMAND = 'npx @expo/agent-cli dev --ios --detach --wait-ready';

type Report = {
  installed: { platforms: { platform: string; [key: string]: unknown }[] } | null;
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
      await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR] });

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

    describe('the dev server line', () => {
      const liveTarget = (id: string, deviceName: string) =>
        makeTarget({
          id,
          appId: 'com.example.installedapp',
          deviceName,
          webSocketDebuggerUrl: `ws://127.0.0.1:1/inspector/debug?device=${id}&page=1`,
        });

      async function statusLineAsync(targets: ReturnType<typeof makeTarget>[]) {
        const stub = await startStubDevServerAsync({ projectRoot, targets });
        try {
          const result = await executeAgentCliAsync(
            projectRoot,
            ['status', '--dev-server-url', stub.url],
            { env: { ...WITH_DEVICES, STUB_FINGERPRINT_HASH: 'any' } }
          );
          return result.stdout.split('\n').find((line) => line.startsWith('dev server')) ?? '';
        } finally {
          await stub.close();
        }
      }

      it("splits the count into this worktree's EAS session and a local simulator not bound here", async () => {
        await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR] });
        await writeCloudBindingAsync(expoHomeOf(projectRoot), fs.realpathSync(projectRoot), {
          id: 'sess-1',
        });

        const line = await statusLineAsync([
          liveTarget('local', SIMULATOR_NAME),
          liveTarget('session', 'iPhone 17'),
        ]);

        expect(line).toContain(
          `2 apps connected: 1 on this worktree's EAS session, 1 on a local simulator not bound here (${SIMULATOR_NAME})`
        );
      });

      it('adds no split when a simulator of the same name is the one this worktree bound', async () => {
        await installStubXcrunAsync(projectRoot, {
          simulators: [
            BOOTED_SIMULATOR,
            { udid: 'E2E-SIM-0002', name: SIMULATOR_NAME, state: 'Booted' },
          ],
        });
        await bindingFixture(projectRoot, SIMULATOR_UDID);

        const line = await statusLineAsync([liveTarget('own', SIMULATOR_NAME)]);

        expect(line).not.toContain('not bound here');
      });

      it('does not call an Android app an app on the EAS session', async () => {
        await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR] });
        await writeCloudBindingAsync(expoHomeOf(projectRoot), fs.realpathSync(projectRoot), {
          id: 'sess-1',
        });

        const line = await statusLineAsync([
          liveTarget('local', SIMULATOR_NAME),
          liveTarget('phone', 'sdk_gphone64_arm64 - 15 - API 35'),
        ]);

        expect(line).toContain('1 on a local simulator not bound here');
        expect(line).not.toContain('EAS session');
      });

      it('adds no split for the simulator this worktree bound', async () => {
        await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR] });
        await bindingFixture(projectRoot, SIMULATOR_UDID);

        const line = await statusLineAsync([liveTarget('own', SIMULATOR_NAME)]);

        expect(line).toContain('1 app connected');
        expect(line).not.toContain('not bound here');
      });
    });
  }
);
