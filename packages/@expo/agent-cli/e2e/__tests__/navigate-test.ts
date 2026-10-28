// @ref llp/0005-runtime-loop-tools.rfc.md
//
// `@expo/agent-cli navigate` is the one runtime-facing command that *writes*: it drives a real device. A
// dev server resolved wrongly here does not produce a wrong reading, it loads another project's app
// onto the user's simulator and reports success — which is what happened while this command
// assumed 8081 instead of reading the project's dev-server lock.
//
// The device tools are stubbed on `PATH`, so no simulator is involved.
import fs from 'node:fs';
import path from 'node:path';

import {
  executeAgentCliAsync,
  holdDevLockAsync,
  readStubExpoInvocations,
  setupFixtureAsync,
  startStubDevServerAsync,
  stubExpoEnv,
} from '../utils';
import {
  appStartedMarkerPath,
  BOOTED_SIMULATOR,
  installStubXcrunAsync,
  SIMULATOR_UDID,
} from './installedAppStubs';

/** The shape `navigate --json` prints, per `src/navigate/navigateAsync.ts`. */
type NavigateReport = {
  route: string;
  url: string;
  devServerUrl: string;
  devServerSource: 'flag' | 'lock' | 'log' | 'default' | 'scan';
  resolution: string;
  target: string;
  platform: string;
  deviceId: string;
  appId: string | null;
  command: string;
  exitCode: number | null;
  routeCheck: {
    checked: boolean;
    ok: boolean | null;
    matched: string | null;
    routeCount: number;
    reason: string | null;
  };
  followups: { id: string; command: string; why: string }[];
};

/** A debugger target that looks like Expo Go, so the `exp://` URL shape is chosen. */
const EXPO_GO_TARGET = {
  id: '1',
  appId: 'host.exp.Exponent',
  webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=1&page=1',
};

describe('@expo/agent-cli navigate', () => {
  it.each([true, false])(
    'launches a cold development build (automation: %s)',
    async (automation) => {
      const projectRoot = await setupFixtureAsync('dev-client-app');
      const launchedMarker = appStartedMarkerPath(projectRoot);
      const { calls: readXcrun } = await installStubXcrunAsync(projectRoot, {
        simulators: [BOOTED_SIMULATOR],
      });
      const stub = await startStubDevServerAsync({
        projectRoot,
        targets: [{ id: '1', appId: 'com.example.demo', deviceName: 'iPhone 17 Pro' }],
        targetsAppearWithFile: launchedMarker,
      });

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          [
            'navigate',
            '/profile/42',
            '--ios',
            '--json',
            '--scheme',
            'demoapp',
            '--app-id',
            'com.example.demo',
            '--dev-server-url',
            stub.url,
          ],
          { env: { ...stubExpoEnv(projectRoot), EXPO_NO_DEV_MENU: automation ? '1' : '0' } }
        );

        expect(result.exitCode).toBe(0);
        const report = JSON.parse(result.stdout);
        const launch = new URL(report.launch.url);
        expect(launch.hostname).toBe('');
        expect(Object.fromEntries(launch.searchParams)).toEqual({
          __expo_url: stub.url,
          ...(automation
            ? {
                __expo_disable_onboarding: '1',
                __expo_disable_fab: '1',
                __expo_disable_auto_launch: '1',
              }
            : {}),
        });
        expect(
          readXcrun()
            .filter((args) => args[1] === 'openurl')
            .map((args) => args[3])
        ).toEqual([report.launch.url, 'demoapp://profile/42']);
        expect(report.launch.attached).toBe(true);
      } finally {
        await stub.close();
      }
    }
  );

  it('documents that the dev server is discovered, not assumed to be 8081', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    const result = await executeAgentCliAsync(projectRoot, ['navigate', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.all).toContain('--dev-server-url');
    expect(result.all).toContain("the project's own, then 8081");
    // The old help promised 8081 as the default, which is the behaviour that was wrong.
    expect(result.all).not.toContain('(default: http://127.0.0.1:8081)');
  });

  // The regression: a lock naming a non-default port must decide the URL, exactly as it does for
  // `status`, `dev:wait` and the `runtime:*` actions.
  it('builds the URL from the dev-server lock rather than from 8081', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const { calls: readXcrun } = await installStubXcrunAsync(projectRoot, {
      simulators: [BOOTED_SIMULATOR],
    });
    const stub = await startStubDevServerAsync({ projectRoot, targets: [EXPO_GO_TARGET] });
    const releaseLock = await holdDevLockAsync(projectRoot, {
      url: stub.url,
      port: stub.port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      projectRoot,
    });

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['navigate', '/explore', '--ios', '--json'],
        { env: stubExpoEnv(projectRoot) }
      );

      expect(result.exitCode).toBe(0);
      const report: NavigateReport = JSON.parse(result.stdout);
      expect(report.devServerUrl).toBe(stub.url);
      expect(report.devServerSource).toBe('lock');
      expect(report.url).toBe(`exp://127.0.0.1:${stub.port}/--/explore`);

      // What the device was actually told, which is the fact the JSON only claims.
      expect(readXcrun()).toContainEqual([
        'simctl',
        'openurl',
        SIMULATOR_UDID,
        `exp://127.0.0.1:${stub.port}/--/explore`,
      ]);
    } finally {
      releaseLock();
      await stub.close();
    }
  });

  it('still uses --dev-server-url exactly as given', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR] });
    const stub = await startStubDevServerAsync({ projectRoot, targets: [EXPO_GO_TARGET] });

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['navigate', '/explore', '--ios', '--json', '--dev-server-url', stub.url],
        { env: stubExpoEnv(projectRoot) }
      );

      const report: NavigateReport = JSON.parse(result.stdout);
      expect(report.devServerSource).toBe('flag');
      expect(report.devServerUrl).toBe(stub.url);
    } finally {
      await stub.close();
    }
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §Verifying the route. The friction this pins
  // [observed — friction run 3, F32]: `navigate /totally-bogus` exited 0 with the simulator on
  // Expo Router's "Unmatched Route" screen, and `runtime:errors --fail-on-error` and `dev:wait
  // --require-app` both exited 0 after it. Nothing that reads the *app* can see an unmatched
  // route, because the router renders a screen for it on purpose.
  describe('route check', () => {
    /** Give the fixture an Expo Router `app/` directory with the named route files. */
    async function writeRoutesAsync(projectRoot: string, files: string[]) {
      for (const file of files) {
        const target = path.join(projectRoot, 'app', file);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, 'export default function Route() { return null; }\n');
      }
    }

    it('refuses a route the project has not got, and lists the ones it has', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      const { calls: readXcrun } = await installStubXcrunAsync(projectRoot, {
        simulators: [BOOTED_SIMULATOR],
      });
      await writeRoutesAsync(projectRoot, ['index.tsx', 'explore.tsx', 'notes.tsx']);
      const stub = await startStubDevServerAsync({ projectRoot, targets: [EXPO_GO_TARGET] });

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['navigate', '/totally-bogus-route-xyz', '--ios', '--json', '--dev-server-url', stub.url],
          { env: stubExpoEnv(projectRoot), reject: false }
        );

        expect(result.exitCode).toBe(1);
        const { error } = JSON.parse(result.stdout);
        expect(error.code).toBe('ROUTE_NOT_FOUND');
        expect(error.message).toContain('/explore');
        expect(error.message).toContain('/notes');
        expect(error.message).toContain('--no-route-check');
        // Nothing reached the device: the point of the check is that the simulator never opens
        // onto the "Unmatched Route" screen in the first place.
        expect(readXcrun()).toEqual([]);
      } finally {
        await stub.close();
      }
    });

    it('names the nearest route as the command to run', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR] });
      await writeRoutesAsync(projectRoot, ['index.tsx', 'notes.tsx']);
      const stub = await startStubDevServerAsync({ projectRoot, targets: [EXPO_GO_TARGET] });

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['navigate', '/note', '--ios', '--json', '--dev-server-url', stub.url],
          { env: stubExpoEnv(projectRoot), reject: false }
        );

        expect(JSON.parse(result.stdout).error.suggestedCommand).toBe(
          'npx @expo/agent-cli navigate /notes'
        );
      } finally {
        await stub.close();
      }
    });

    it('matches a value against a dynamic route', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      const { calls: readXcrun } = await installStubXcrunAsync(projectRoot, {
        simulators: [BOOTED_SIMULATOR],
      });
      await writeRoutesAsync(projectRoot, ['index.tsx', 'users/[id].tsx']);
      const stub = await startStubDevServerAsync({ projectRoot, targets: [EXPO_GO_TARGET] });

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['navigate', '/users/42', '--ios', '--json', '--dev-server-url', stub.url],
          { env: stubExpoEnv(projectRoot) }
        );

        expect(result.exitCode).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.routeCheck).toEqual({
          checked: true,
          ok: true,
          matched: '/users/[id]',
          routeCount: 3,
          reason: null,
        });
        expect(readXcrun().some((call) => call[1] === 'openurl')).toBe(true);
      } finally {
        await stub.close();
      }
    });

    it('opens anything with --no-route-check', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      const { calls: readXcrun } = await installStubXcrunAsync(projectRoot, {
        simulators: [BOOTED_SIMULATOR],
      });
      await writeRoutesAsync(projectRoot, ['index.tsx']);
      const stub = await startStubDevServerAsync({ projectRoot, targets: [EXPO_GO_TARGET] });

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          [
            'navigate',
            '/totally-bogus-route-xyz',
            '--ios',
            '--json',
            '--no-route-check',
            '--dev-server-url',
            stub.url,
          ],
          { env: stubExpoEnv(projectRoot) }
        );

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).routeCheck.checked).toBe(false);
        expect(readXcrun().some((call) => call[1] === 'openurl')).toBe(true);
      } finally {
        await stub.close();
      }
    });

    // Fail open: a project with no router directory has not been shown to lack the route.
    it('opens the link when the project has no app directory', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR] });
      const stub = await startStubDevServerAsync({ projectRoot, targets: [EXPO_GO_TARGET] });

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['navigate', '/anything', '--ios', '--json', '--dev-server-url', stub.url],
          { env: stubExpoEnv(projectRoot) }
        );

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).routeCheck).toMatchObject({ checked: false, ok: null });
      } finally {
        await stub.close();
      }
    });
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §The route table.
  it('addresses the root route with a URL Expo Go delivers', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const { calls: readXcrun } = await installStubXcrunAsync(projectRoot, {
      simulators: [BOOTED_SIMULATOR],
    });
    const stub = await startStubDevServerAsync({ projectRoot, targets: [EXPO_GO_TARGET] });

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['navigate', '/', '--ios', '--json', '--dev-server-url', stub.url],
        { env: stubExpoEnv(projectRoot) }
      );

      expect(result.exitCode).toBe(0);
      // Not `exp://127.0.0.1:<port>`, which expo-router's Expo Go link handler drops before the
      // router sees it, leaving a loaded app exactly where it was.
      expect(JSON.parse(result.stdout).url).toBe(`exp://127.0.0.1:${stub.port}/--/?`);
      expect(readXcrun()).toContainEqual([
        'simctl',
        'openurl',
        SIMULATOR_UDID,
        `exp://127.0.0.1:${stub.port}/--/?`,
      ]);
    } finally {
      await stub.close();
    }
  });

  // @ref llp/0021-honest-reports.rfc.md §How they show up — **F142.**
  // The step the acceptance walk stalled on: the dev server it had asked for had died, so
  // `navigate / --ios` could not build an Expo Go URL — and the one line it was handed to recover
  // with was `npx @expo/agent-cli dev --detach`, with the `--ios` dropped. Following it would have started a
  // dev server for whichever platform the plan engine picks, which is not what was asked for.
  it('keeps the platform the caller named on the line it recovers with', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    await installStubXcrunAsync(projectRoot, { simulators: [BOOTED_SIMULATOR] });

    const result = await executeAgentCliAsync(
      projectRoot,
      // No dev server anywhere: no lock, no log, and a named URL nothing answers on.
      ['navigate', '/', '--ios', '--dev-server-url', 'http://127.0.0.1:1', '--json'],
      { env: stubExpoEnv(projectRoot), reject: false }
    );

    expect(result.exitCode).not.toBe(0);
    const { error } = JSON.parse(result.stdout);
    expect(error.suggestedCommand).toContain('--ios');
    // The `Try:` line is what an agent acts on, so the flag has to be on the stream too.
    expect(result.stderr).toContain('--ios');
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §Pointing an app at this dev server — issue #84. A
// project whose only config is `app.config.ts` was sent to `exp+<package name>://` with "no scheme
// field was found", which was not what happened: the file was never read. The scheme now comes
// from the config `@expo/config` evaluates after the project's env files are loaded, the way
// `expo config` reads it, and a static config is never evaluated. The config files here are real
// and so is their evaluation; the `expo` bin stays a stub, and it is never asked for the config.
describe('@expo/agent-cli navigate with a dynamic app config', () => {
  const PRINT_URL = ['navigate', '/profile/42', '--ios', '--json', '--print-url'];
  /** Reads the variable the `.env` sets, and leaves a marker so a run that evaluated it shows. */
  const APP_CONFIG_JS = [
    "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'evaluated.marker'), '');",
    'module.exports = ({ config }) => ({',
    '  ...config,',
    "  scheme: process.env.APP_VARIANT ? `marmelade-${process.env.APP_VARIANT}` : 'marmelade',",
    '});',
    '',
  ].join('\n');
  /** The issue's own shape: TypeScript, which Node strips or `typescript` transpiles. */
  const APP_CONFIG_TS = [
    "const scheme: string = 'marmelade';",
    "export default { name: 'Marmelade', slug: 'marmelade', scheme, plugins: ['expo-font'] };",
    '',
  ].join('\n');

  /** `dev-client-app` with its `app.json` replaced by a dynamic config. */
  async function setupDynamicAsync(
    files: Record<string, string> = { 'app.config.js': APP_CONFIG_JS }
  ): Promise<string> {
    const projectRoot = await setupFixtureAsync('dev-client-app');
    await fs.promises.rm(path.join(projectRoot, 'app.json'));
    for (const [name, contents] of Object.entries(files)) {
      await fs.promises.writeFile(path.join(projectRoot, name), contents);
    }
    return projectRoot;
  }

  function wasEvaluated(projectRoot: string): boolean {
    return fs.existsSync(path.join(projectRoot, 'evaluated.marker'));
  }

  /** The stub `expo` bin's `config` invocations, which the evaluation never makes. */
  function expoConfigCalls(projectRoot: string) {
    return readStubExpoInvocations(projectRoot).filter((call) => call.args[0] === 'config');
  }

  it('reads the scheme the evaluated config names, with the project env files loaded', async () => {
    const projectRoot = await setupDynamicAsync({
      'app.config.js': APP_CONFIG_JS,
      '.env': 'APP_VARIANT=dev\n',
    });

    const result = await executeAgentCliAsync(
      projectRoot,
      [...PRINT_URL, '--app-id', 'dev.marmelade.app'],
      { env: stubExpoEnv(projectRoot) }
    );
    const report: NavigateReport = JSON.parse(result.stdout);

    expect(report.url).toBe('marmelade-dev://profile/42');
    expect(report.resolution).toBe('read the "scheme" field from app.config.js');
    expect(expoConfigCalls(projectRoot)).toEqual([]);
  });

  it('evaluates an app.config.ts', async () => {
    const projectRoot = await setupDynamicAsync({ 'app.config.ts': APP_CONFIG_TS });

    const result = await executeAgentCliAsync(
      projectRoot,
      [...PRINT_URL, '--app-id', 'dev.marmelade.app'],
      { env: stubExpoEnv(projectRoot) }
    );
    const report: NavigateReport = JSON.parse(result.stdout);

    expect(report.url).toBe('marmelade://profile/42');
    expect(report.resolution).toBe('read the "scheme" field from app.config.ts');
  });

  it('keeps the static read and says so when the config cannot be evaluated', async () => {
    const projectRoot = await setupDynamicAsync({
      'app.config.js':
        "module.exports = () => { throw new Error('Cannot resolve app config'); };\n",
    });

    const result = await executeAgentCliAsync(
      projectRoot,
      [...PRINT_URL, '--app-id', 'dev.marmelade.app'],
      { env: stubExpoEnv(projectRoot) }
    );
    const report: NavigateReport = JSON.parse(result.stdout);

    // The package name, because that is all the static read has for this project.
    expect(report.url).toBe('exp+dev-client-app://profile/42');
    expect(report.resolution).toBe(
      'app.config.js could not be evaluated (Cannot resolve app config) and no "scheme" field was found, so the development build default exp+<slug>:// was used with slug "dev-client-app"'
    );
  });

  // The usual dynamic config spreads `app.json` and sets its own scheme, so the static one may not
  // be the scheme the app registered.
  it('says the static scheme stands in for a config that cannot be evaluated', async () => {
    const projectRoot = await setupFixtureAsync('dev-client-app');
    const appJsonPath = path.join(projectRoot, 'app.json');
    const appJson = JSON.parse(await fs.promises.readFile(appJsonPath, 'utf8'));
    appJson.expo.scheme = 'marmelade-static';
    await fs.promises.writeFile(appJsonPath, JSON.stringify(appJson));
    await fs.promises.writeFile(
      path.join(projectRoot, 'app.config.js'),
      "module.exports = () => { throw new Error('Cannot resolve app config'); };\n"
    );

    const result = await executeAgentCliAsync(
      projectRoot,
      [...PRINT_URL, '--app-id', 'dev.marmelade.app'],
      { env: stubExpoEnv(projectRoot) }
    );
    const report: NavigateReport = JSON.parse(result.stdout);

    expect(report.url).toBe('marmelade-static://profile/42');
    expect(report.resolution).toBe(
      'app.config.js could not be evaluated (Cannot resolve app config), so read the "scheme" field from app.json'
    );
  });

  it('evaluates nothing when --scheme names the scheme', async () => {
    const projectRoot = await setupDynamicAsync();

    const result = await executeAgentCliAsync(
      projectRoot,
      [...PRINT_URL, '--scheme', 'demoapp', '--app-id', 'dev.marmelade.app'],
      { env: stubExpoEnv(projectRoot) }
    );
    const report: NavigateReport = JSON.parse(result.stdout);

    expect(report.url).toBe('demoapp://profile/42');
    expect(wasEvaluated(projectRoot)).toBe(false);
  });

  it('evaluates nothing for a static app config', async () => {
    const projectRoot = await setupFixtureAsync('dev-client-app');

    const result = await executeAgentCliAsync(
      projectRoot,
      [...PRINT_URL, '--app-id', 'com.example.demo'],
      { env: stubExpoEnv(projectRoot) }
    );
    const report: NavigateReport = JSON.parse(result.stdout);

    expect(report.url).toBe('exp+dev-client-app://profile/42');
    expect(expoConfigCalls(projectRoot)).toEqual([]);
  });
});
