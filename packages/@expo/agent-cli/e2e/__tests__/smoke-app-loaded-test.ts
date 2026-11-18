// @ref llp/0005-runtime-loop-tools.rfc.md §A loaded app
// The dev server lists the app's debugger target and the runtime answers, before the app runs its
// JavaScript bundle. `smoke` is never `passed` for that app. The `runtime` evaluate does not read
// the platform, so the two long rows run on iOS only.
import { appRuntime, expoGoRuntimeTarget } from '../runtimeTargetFixtures';
import {
  executeAgentCliAsync,
  setupFixtureAsync,
  startStubDevServerAsync,
  stubExpoEnv,
  type StubDevServerOptions,
} from '../utils';
import { appStartedMarkerPath, BOOTED_SIMULATOR, installStubXcrunAsync } from './installedAppStubs';

type Row = {
  name: string;
  platform: 'ios' | 'android';
  flags: string[];
  /** The stub `xcrun` starts the app when the run opens the link. */
  runOpensTheApp?: boolean;
};

describe('an app that ran no bundle', () => {
  it.each<Row>([
    { name: '--no-reload, ios', platform: 'ios', flags: ['--no-reload', '--timeout', '20s'] },
    {
      name: '--no-reload, android',
      platform: 'android',
      flags: ['--no-reload', '--timeout', '20s'],
    },
    {
      name: 'the run opens the app, ios',
      platform: 'ios',
      flags: ['--timeout', '6s'],
      runOpensTheApp: true,
    },
    { name: 'the run reloads the app, ios', platform: 'ios', flags: ['--timeout', '20s'] },
  ])('smoke is inconclusive ($name)', async ({ platform, flags, runOpensTheApp = false }) => {
    const projectRoot = await setupFixtureAsync('go-app');
    const stubOptions: StubDevServerOptions = {
      projectRoot,
      targets: [expoGoRuntimeTarget(platform)],
      inspectorEvaluate: appRuntime({}).evaluate,
    };
    if (runOpensTheApp) {
      await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR] });
      stubOptions.targetsAppearWithFile = appStartedMarkerPath(projectRoot);
    }
    const stub = await startStubDevServerAsync(stubOptions);

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        [
          'smoke',
          `--${platform}`,
          '--dev-server-url',
          stub.url,
          '--no-start',
          '--no-screenshot',
          '--window',
          '100ms',
          '--json',
          ...flags,
        ],
        { env: stubExpoEnv(projectRoot), reject: false }
      );

      expect(result.exitCode).toBe(22);
      const report = JSON.parse(result.stdout);
      expect(report.outcome).toBe('inconclusive');
      const phase = (id: string) => report.phases.find((each: { id: string }) => each.id === id);
      expect(phase('runtime')).toMatchObject({
        status: 'inconclusive',
        reason: expect.stringContaining('no JavaScript bundle'),
      });
      if (runOpensTheApp) {
        expect(phase('reload').reason).toContain('no older bundle to replace');
      }
    } finally {
      await stub.close();
    }
  });
});
