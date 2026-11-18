// @ref llp/0005-runtime-loop-tools.rfc.md §The bundle state
//
// A dev client lists its debugger target, and answers Runtime.evaluate, while it still downloads
// its bundle. These cases pin that a listed target whose bundle has not run is loading, not
// attached, for each reader that asks, and that the identity readers still find it.

import { hostPlatform } from '../../src/smoke/suggest';
import {
  executeAgentCliAsync,
  holdLockForAsync,
  NO_ANSWER,
  setupFixtureAsync,
  startStubDevServerAsync,
  stubExpoEnv,
  type StubDevServerOptions,
} from '../utils';
import { BOOTED_SIMULATOR, installStubXcrunAsync } from './installedAppStubs';

const EXPO_GO_TARGET = {
  id: '1',
  appId: 'host.exp.Exponent',
  title: 'React Native Experimental (Improved Chrome Reloads)',
  description: 'host.exp.Exponent',
  type: 'node',
  devtoolsFrontendUrl: '',
  webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=1&page=1',
  deviceName: BOOTED_SIMULATOR.name,
  reactNative: { capabilities: { nativePageReloads: true }, logicalDeviceId: 'device-1' },
};
const SECOND_TARGET = {
  ...EXPO_GO_TARGET,
  id: '2',
  webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=2&page=1',
  reactNative: { capabilities: { nativePageReloads: true }, logicalDeviceId: 'device-2' },
};
const SENTINEL = 'bundle-state-sentinel';

/** A second page of the same device: `capabilities` overrides what it can do. */
function sideTarget(id: string, capabilities: Record<string, boolean>) {
  return {
    ...EXPO_GO_TARGET,
    id,
    webSocketDebuggerUrl: `ws://127.0.0.1:8081/inspector/debug?device=${id}&page=1`,
    reactNative: { capabilities, logicalDeviceId: 'device-1' },
  };
}

/**
 * One loading app, and what makes it look attached when a reader does not ask the same question as
 * the debugger client: a page the client never reads beside it, or a probe answer that comes late.
 */
const LOADING_SHAPES: [string, Partial<StubDevServerOptions>][] = [
  [
    'a hidden page beside it',
    {
      targets: [EXPO_GO_TARGET, sideTarget('9', { nativePageReloads: true })],
      requireType: (device) => (device === '9' ? 'hidden' : 'undefined'),
    },
  ],
  [
    'a page that does not reload natively beside it',
    {
      targets: [EXPO_GO_TARGET, sideTarget('8', {})],
      requireType: (device) => (device === '8' ? 'function' : 'undefined'),
    },
  ],
  [
    'a probe answer that takes 400 ms',
    { targets: [EXPO_GO_TARGET], requireType: () => 'undefined', requireTypeDelayMs: 400 },
  ],
];

const loading: StubDevServerOptions['requireType'] = () => 'undefined';

let projectRoot: string;
beforeAll(async () => {
  projectRoot = await setupFixtureAsync('go-app');
});

async function withStubAsync(
  options: StubDevServerOptions,
  run: (url: string) => Promise<void>
): Promise<void> {
  const stub = await startStubDevServerAsync(options);
  try {
    await run(stub.url);
  } finally {
    await stub.close();
  }
}

async function runAsync(argv: string[], devServerUrl: string) {
  return await executeAgentCliAsync(
    projectRoot,
    [...argv, '--dev-server-url', devServerUrl, '--json'],
    { reject: false, env: stubExpoEnv(projectRoot) }
  );
}

describe('an app whose bundle has not run', () => {
  it('runtime:errors exits 22 with APP_BUNDLE_NOT_RUN, not "no errors"', async () => {
    await withStubAsync(
      { targets: [EXPO_GO_TARGET], requireType: loading, inspectorEvaluate: () => undefined },
      async (url) => {
        const result = await runAsync(['runtime:errors', '--duration', '100ms'], url);

        expect(result.exitCode, result.all).toBe(22);
        const { error } = JSON.parse(result.stdout);
        expect(error.code).toBe('APP_BUNDLE_NOT_RUN');
        expect(error.suggestedCommand).toBe(`npx @expo/agent-cli smoke --${hostPlatform()}`);
        expect(error.data).toEqual({
          devServerUrl: url,
          devServerReachable: true,
          debuggerTargets: 1,
          commandSocketClients: null,
          platform: null,
        });
      }
    );
  });

  it.each(LOADING_SHAPES)('runtime:errors exits 22 with %s', async (_, options) => {
    await withStubAsync({ inspectorEvaluate: () => undefined, ...options }, async (url) => {
      const result = await runAsync(['runtime:errors', '--duration', '100ms'], url);

      expect(result.exitCode, result.all).toBe(22);
      expect(JSON.parse(result.stdout).error.code).toBe('APP_BUNDLE_NOT_RUN');
    });
  });

  it('runtime:tree exits 22 with APP_BUNDLE_NOT_RUN, not RUNTIME_TREE_UNSUPPORTED', async () => {
    await withStubAsync(
      {
        targets: [EXPO_GO_TARGET],
        requireType: loading,
        inspectorEvaluate: (expression) =>
          expression.includes('var FULL =')
            ? { supported: false, reason: 'no-devtools-hook' }
            : undefined,
      },
      async (url) => {
        const result = await runAsync(['runtime:tree'], url);

        expect(result.exitCode, result.all).toBe(22);
        expect(JSON.parse(result.stdout).error.code).toBe('APP_BUNDLE_NOT_RUN');
      }
    );
  });

  it('runtime:eval reads the loaded app, not the loading one beside it', async () => {
    const evaluated: string[] = [];
    await withStubAsync(
      {
        targets: [EXPO_GO_TARGET, SECOND_TARGET],
        requireType: (device) => (device === '1' ? 'undefined' : 'function'),
        inspectorEvaluate: (expression, device) => {
          if (!expression.includes(SENTINEL)) return undefined;
          evaluated.push(device);
          return device;
        },
      },
      async (url) => {
        const result = await runAsync(['runtime:eval', JSON.stringify(SENTINEL)], url);

        expect(result.exitCode, result.all).toBe(0);
        expect(evaluated).toEqual(['2']);
      }
    );
  });

  it('navigate reports App loading at exit 22', async () => {
    await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR] });
    await withStubAsync(
      { projectRoot, targets: [EXPO_GO_TARGET], requireType: loading },
      async (url) => {
        const result = await executeAgentCliAsync(
          projectRoot,
          [
            'navigate',
            '/',
            '--ios',
            '--no-followups',
            '--attach-timeout',
            '2s',
            '--dev-server-url',
            url,
          ],
          { reject: false, env: stubExpoEnv(projectRoot) }
        );

        expect(result.exitCode, result.all).toBe(22);
        expect(result.stdout).toMatch(
          /App loading · 1 ios debugger target, bundle not run after \d+ms/
        );
      }
    );
  });

  it.each(LOADING_SHAPES)('navigate reports App loading with %s', async (_, options) => {
    await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR] });
    await withStubAsync({ projectRoot, ...options }, async (url) => {
      const result = await executeAgentCliAsync(
        projectRoot,
        [
          'navigate',
          '/',
          '--ios',
          '--no-followups',
          '--attach-timeout',
          '2s',
          '--dev-server-url',
          url,
        ],
        { reject: false, env: stubExpoEnv(projectRoot) }
      );

      expect(result.exitCode, result.all).toBe(22);
      expect(result.stdout).toContain('App loading');
    });
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §The bundle state — a runtime that opens its socket and
  // never answers cannot say, and is read like one that has no evaluate.
  it('runtime:errors reads an app that accepts the socket and never answers the probe', async () => {
    await withStubAsync(
      { targets: [EXPO_GO_TARGET], requireType: () => NO_ANSWER },
      async (url) => {
        const result = await runAsync(['runtime:errors', '--duration', '100ms'], url);

        expect(result.exitCode, result.all).toBe(0);
      }
    );
  });

  it('navigate reports App attached once the bundle runs', async () => {
    await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR] });
    let probes = 0;
    await withStubAsync(
      {
        projectRoot,
        targets: [EXPO_GO_TARGET],
        requireType: () => (++probes <= 2 ? 'undefined' : 'function'),
      },
      async (url) => {
        const result = await executeAgentCliAsync(
          projectRoot,
          [
            'navigate',
            '/',
            '--ios',
            '--no-followups',
            '--attach-timeout',
            '10s',
            '--dev-server-url',
            url,
          ],
          { reject: false, env: stubExpoEnv(projectRoot) }
        );

        expect(result.exitCode, result.all).toBe(0);
        expect(result.stdout).toContain('App attached');
        expect(probes).toBeGreaterThan(2);
      }
    );
  });

  it('runtime:stop still names the loading app', async () => {
    await installStubXcrunAsync(projectRoot, {
      simulators: [BOOTED_SIMULATOR],
      runningAppIds: ['host.exp.Exponent'],
    });
    await withStubAsync({ targets: [EXPO_GO_TARGET], requireType: loading }, async (url) => {
      const result = await runAsync(['runtime:stop', '--ios'], url);

      expect(result.exitCode, result.all).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        bundleId: 'host.exp.Exponent',
        connectedAppIds: ['host.exp.Exponent'],
      });
    });
  });

  it('runtime:reload still finds the loading app', async () => {
    const root = await setupFixtureAsync('go-app');
    const stub = await startStubDevServerAsync({
      projectRoot: root,
      targets: [EXPO_GO_TARGET],
      messageSocket: 'v2',
      requireType: loading,
    });
    const releaseLock = await holdLockForAsync(root, stub);
    await installStubXcrunAsync(root, { simulators: [BOOTED_SIMULATOR] });
    try {
      const result = await executeAgentCliAsync(root, ['runtime:reload', '--json'], {
        reject: false,
        env: stubExpoEnv(root),
      });

      expect(result.exitCode, result.all).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ reloaded: true, appsConnected: 1 });
    } finally {
      releaseLock();
      await stub.close();
    }
  });
});
