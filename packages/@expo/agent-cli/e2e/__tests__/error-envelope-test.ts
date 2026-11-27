// @ref llp/0010-agent-conventions.rfc.md §Exit codes — a device tool that refused is a tool error,
// so `--json` prints the error envelope with the device's answer in `data`, never a report.
import { executeAgentCliAsync, setupFixtureAsync, stubExpoEnv } from '../utils';
import { startStubDevServerAsync } from '../stubDevServer';
import { BOOTED_SIMULATOR, installStubXcrunAsync, SIMULATOR_UDID } from './installedAppStubs';

const EXPO_GO_TARGET = {
  id: '1',
  appId: 'host.exp.Exponent',
  deviceName: BOOTED_SIMULATOR.name,
  webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=1&page=1',
};

describe('a device tool that refused', () => {
  it.each([
    {
      refuses: 'terminate' as const,
      args: ['runtime:stop', '--ios', '--json'],
      code: 'DEVICE_STOP_REFUSED',
      data: {
        bundleId: 'host.exp.Exponent',
        command: expect.stringContaining(`simctl terminate ${SIMULATOR_UDID}`),
        reason: 'stub xcrun: terminate refused',
      },
    },
    {
      refuses: 'openurl' as const,
      args: ['navigate', '/', '--ios', '--json', '--no-route-check'],
      code: 'DEEP_LINK_REFUSED',
      data: {
        url: expect.stringMatching(/^exp:\/\//),
        command: expect.stringContaining('simctl openurl'),
        exitCode: 1,
      },
    },
  ])('$args.0 prints $code', async ({ refuses, args, code, data }) => {
    const projectRoot = await setupFixtureAsync('go-app');
    await installStubXcrunAsync(projectRoot, {
      simulators: [BOOTED_SIMULATOR],
      refuses: [refuses],
    });
    const stub = await startStubDevServerAsync({ projectRoot, targets: [EXPO_GO_TARGET] });

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        [...args, '--dev-server-url', stub.url],
        { env: stubExpoEnv(projectRoot), reject: false }
      );

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        error: {
          code,
          message: expect.any(String),
          suggestedCommand: null,
          needsHuman: null,
          data,
        },
      });
    } finally {
      await stub.close();
    }
  });
});
