// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
//
// `status`: the device section, EAS sessions of a deleted worktree, and the dev server section.
// The tests run it through the CLI it is published as, against the fixture matrix in
// `e2e/fixtures/README.md`. Shared helpers live in `statusFixtures.ts`.

import fs from 'node:fs';
import { type Server } from 'node:http';
import path from 'node:path';

import { installStubAdbAsync, installStubXcrunAsync } from './installedAppStubs';
import { writeCloudBindingAsync, writeCloudSessionFileAsync } from '../stubEas';
import {
  executeAgentCliAsync,
  expoHomeOf,
  holdDevLockAsync,
  pathEnvVars,
  startStubDevServerAsync,
} from '../utils';
import {
  type StatusReport,
  CDP_TARGET,
  setupAsync,
  bindDefaultDeviceAsync,
  startDevServerDoubleAsync,
  getUnusedDevServerUrlAsync,
  DEVICES_ON,
  reportInAsync,
  reportAsync,
} from './statusFixtures';

describe('@expo/agent-cli status', () => {
  // @ref llp/0005-runtime-loop-tools.rfc.md §navigate
  // @ref llp/0004-smart-start-and-project-state.rfc.md §Status
  describe('the device section, with stubbed platform tools', () => {
    const IOS_UDID = '8B2C5D9E-1234-4F5A-9B7C-0D1E2F3A4B5C';

    type ToolState = 'answers' | 'none' | 'not-runnable';

    /** Stub `xcrun` and `adb`, and return the env the run needs to find them. */
    async function stubDeviceToolsAsync(
      projectRoot: string,
      { ios, android }: { ios: ToolState; android: ToolState }
    ): Promise<Record<string, string>> {
      const { binDir } = await installStubXcrunAsync(projectRoot, {
        simulators:
          ios === 'none' ? [] : [{ udid: IOS_UDID, name: 'iPhone 17 Pro', state: 'Booted' }],
      });
      if (ios === 'not-runnable') {
        await fs.promises.chmod(path.join(binDir, 'xcrun'), 0o000);
      }

      const adb = await installStubAdbAsync(projectRoot, 'host.exp.Exponent', {
        attached: android !== 'none',
      });
      if (android === 'not-runnable') {
        await fs.promises.chmod(path.join(adb.env.ANDROID_HOME!, 'platform-tools', 'adb'), 0o000);
      }
      // Without this, the PATH search skips the stub and finds the machine's own `xcrun`.
      const pathOverride = ios === 'not-runnable' ? pathEnvVars(binDir) : {};
      return { ...adb.env, ...pathOverride };
    }

    it('reports an attached Android device', async () => {
      const projectRoot = await setupAsync('go-app');
      const env = await stubDeviceToolsAsync(projectRoot, { ios: 'none', android: 'answers' });

      const report = await reportInAsync(projectRoot, [], env);

      expect(report.device).toMatchObject({
        state: 'present',
        platform: 'android',
        deviceId: 'emulator-5554',
        devices: [{ platform: 'android', deviceId: 'emulator-5554' }],
        reason: null,
      });

      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env }
      );
      expect(result.stdout).toMatch(/device\s+android emulator-5554/);
    });

    it.skipIf(process.platform !== 'darwin')(
      'reports a booted iOS simulator by name, and every bound device',
      async () => {
        const projectRoot = await setupAsync('go-app');
        const env = await stubDeviceToolsAsync(projectRoot, { ios: 'answers', android: 'answers' });

        const report = await reportInAsync(projectRoot, [], env);

        expect(report.device).toMatchObject({
          state: 'present',
          platform: 'ios',
          deviceId: IOS_UDID,
          name: 'iPhone 17 Pro',
        });
        expect(report.device!.devices).toEqual([
          { platform: 'ios', deviceId: IOS_UDID, name: 'iPhone 17 Pro' },
          { platform: 'android', deviceId: 'emulator-5554', name: null },
        ]);

        const result = await executeAgentCliAsync(
          projectRoot,
          ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
          { env }
        );
        expect(result.stdout).toContain(`ios iPhone 17 Pro (${IOS_UDID})`);
        expect(result.stdout).toContain('android emulator-5554');
      }
    );

    it('reports absent, and why, when no device is bound', async () => {
      const projectRoot = await setupAsync('go-app');
      const env = await stubDeviceToolsAsync(projectRoot, { ios: 'none', android: 'none' });

      const report = await reportInAsync(projectRoot, [], env);

      expect(report.device).toMatchObject({ state: 'absent', deviceId: null, devices: [] });
      expect(report.device!.reason).toContain(
        'Android: no emulator instance is bound to this worktree'
      );

      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env }
      );
      expect(result.stdout).toMatch(/device\s+none/);
    });

    // Windows runs a `.cmd` shim, which no execute bit can withhold.
    it.skipIf(process.platform === 'win32')(
      'reports unknown, not none, when no tool could be run',
      async () => {
        const projectRoot = await setupAsync('go-app');
        const env = await stubDeviceToolsAsync(projectRoot, {
          ios: 'not-runnable',
          android: 'not-runnable',
        });

        const report = await reportInAsync(projectRoot, [], env);

        expect(report.device).toMatchObject({ state: 'unknown', deviceId: null, devices: [] });
        expect(report.device!.reason).toContain('Android: "adb" could not be run');
        // Android alone makes the state unknown, so the iOS half needs its own check.
        if (process.platform === 'darwin') {
          expect(report.device!.reason).toContain('iOS: Could not run "xcrun simctl"');
        }

        const result = await executeAgentCliAsync(
          projectRoot,
          ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
          { env }
        );
        expect(result.stdout).toMatch(/device\s+unknown/);
      }
    );

    // @ref llp/0021-honest-reports.rfc.md §The rules
    it('sends a connected app to smoke --eas when an EAS Simulator session is on record', async () => {
      const projectRoot = await setupAsync('go-app');
      const env = await stubDeviceToolsAsync(projectRoot, { ios: 'none', android: 'none' });
      await writeCloudSessionFileAsync(projectRoot, 'sess-e2e');
      await writeCloudBindingAsync(expoHomeOf(projectRoot), fs.realpathSync(projectRoot), {
        id: 'sess-e2e',
        origin: 'dotenv',
      });
      const devServer = await startDevServerDoubleAsync([CDP_TARGET]);
      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['status', '--json', '--dev-server-url', devServer.url],
          { env }
        );

        expect(result.exitCode).toBe(0);
        const report: StatusReport = JSON.parse(result.stdout);
        expect(report.next!.command).toBe('npx @expo/agent-cli smoke --ios --eas');
        expect(report.next!.why).toContain('EAS Simulator session');
      } finally {
        await new Promise<void>((resolve) => devServer.server.close(() => resolve()));
      }
    });
  });

  // @ref llp/0035-one-device-per-worktree.rfc.md §Session cleanup
  it('names `eas simulator:stop` for a deleted worktree session when devices are off', async () => {
    const projectRoot = await setupAsync('go-app');
    const gone = `${fs.realpathSync(projectRoot)}-deleted`;
    await writeCloudBindingAsync(expoHomeOf(projectRoot), gone, { id: 'sess-orphan' });

    // The e2e tier sets AGENT_CLI_NO_DEVICE=1, and under it `dev:stop` reaps nothing.
    const report = await reportInAsync(projectRoot);

    expect(report.orphanSessions).toEqual([
      {
        platform: 'ios',
        id: 'sess-orphan',
        projectRoot: gone,
        command: expect.stringMatching(/ simulator:stop --id sess-orphan$/),
      },
    ]);
    const text = await executeAgentCliAsync(projectRoot, [
      'status',
      '--dev-server-url',
      await getUnusedDevServerUrlAsync(),
    ]);
    expect(text.stdout).toContain(report.orphanSessions[0]!.command);
    expect(text.stdout).toContain(
      'until the next dev or dev:stop without AGENT_CLI_NO_DEVICE, or a dev --eas run'
    );
  });

  // @ref llp/0035-one-device-per-worktree.rfc.md §Session cleanup
  it('names the EAS session of a deleted worktree, and the command that stops it, with devices on', async () => {
    const projectRoot = await setupAsync('go-app');
    const gone = `${fs.realpathSync(projectRoot)}-deleted`;
    await writeCloudBindingAsync(expoHomeOf(projectRoot), gone, { id: 'sess-orphan' });

    const report = await reportInAsync(projectRoot, [], DEVICES_ON);

    const command = 'npx @expo/agent-cli dev:stop';
    expect(report.orphanSessions).toEqual([
      { platform: 'ios', id: 'sess-orphan', projectRoot: gone, command },
    ]);
    expect(report.next?.command).toMatch(
      new RegExp(
        `^npx @expo/agent-cli dev --${process.platform === 'darwin' ? 'ios' : 'android'} --port \\d+ --detach --wait-ready$`
      )
    );
    expect(report.followups[0]).toMatchObject({ command });

    // Plain `dev:stop` would also stop this worktree's own dev server.
    const devServer = await startDevServerDoubleAsync([]);
    const releaseLock = await holdDevLockAsync(projectRoot, {
      url: devServer.url,
      port: Number(new URL(devServer.url).port),
      pid: process.pid,
      startedAt: new Date().toISOString(),
      projectRoot,
    });
    try {
      const withServer = await reportInAsync(projectRoot, [], DEVICES_ON);
      expect(withServer.orphanSessions[0]!.command).toMatch(/ simulator:stop --id sess-orphan$/);
    } finally {
      releaseLock();
      await new Promise<void>((resolve) => devServer.server.close(() => resolve()));
    }

    // A run with no dev server still holds the lock, and plain `dev:stop` would reach it too.
    for (const phase of ['building', 'finishing'] as const) {
      const releaseRunLock = await holdDevLockAsync(projectRoot, {
        url: 'http://127.0.0.1:1',
        port: 1,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        projectRoot,
        phase,
      });
      try {
        const withRun = await reportInAsync(projectRoot, [], DEVICES_ON);
        expect(withRun.orphanSessions[0]!.command).toMatch(/ simulator:stop --id sess-orphan$/);
      } finally {
        releaseRunLock();
      }
    }
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Dependencies not installed — a new
  // worktree is this state, and the one a deleted sibling left a billing session in.
  it('keeps the orphan session stop first, then the bare install, when nothing is installed', async () => {
    const projectRoot = await setupAsync('go-app');
    await fs.promises.rm(path.join(projectRoot, 'node_modules', 'expo'), { recursive: true });
    const gone = `${fs.realpathSync(projectRoot)}-deleted`;
    await writeCloudBindingAsync(expoHomeOf(projectRoot), gone, { id: 'sess-orphan' });

    const report = await reportInAsync(projectRoot);

    expect(report.followups.map(({ id }) => id)).toEqual([
      'stop-orphan-session',
      'dependencies-not-installed',
    ]);
  });

  // @ref llp/0021-honest-reports.rfc.md §The rules
  describe('a tunnelled dev server', () => {
    it('names the tunnel and the URLs that open the app on it', async () => {
      const projectRoot = await setupAsync('go-app');
      const devServer = await startDevServerDoubleAsync([]);
      const startedAt = new Date(Date.now() - 5_000).toISOString();
      const releaseLock = await holdDevLockAsync(projectRoot, {
        url: devServer.url,
        port: Number(new URL(devServer.url).port),
        pid: process.pid,
        startedAt,
        projectRoot,
      });
      const logDir = path.join(projectRoot, '.expo', 'dev', 'logs');
      await fs.promises.mkdir(logDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(logDir, 'dev-detached.log'),
        'Starting Metro Bundler\nWaiting on https://e2e-tunnel.boltexpo.dev\nLogs for your project will appear below.\n'
      );
      try {
        const result = await executeAgentCliAsync(projectRoot, ['status', '--json']);

        expect(result.exitCode).toBe(0);
        const report: StatusReport = JSON.parse(result.stdout);
        expect(report.devServer).toMatchObject({
          running: true,
          source: 'lock',
          hostType: 'tunnel',
          tunnelUrl: 'https://e2e-tunnel.boltexpo.dev',
        });
        expect(report.devServer!.openUrls).toContainEqual(
          expect.objectContaining({ url: 'exp://e2e-tunnel.boltexpo.dev' })
        );

        const text = await executeAgentCliAsync(projectRoot, ['status']);
        expect(text.stdout).toContain('tunnel https://e2e-tunnel.boltexpo.dev');
        expect(text.stdout).toMatch(/open in .*: exp:\/\/e2e-tunnel\.boltexpo\.dev/);
      } finally {
        releaseLock();
        await new Promise<void>((resolve) => devServer.server.close(() => resolve()));
      }
    });

    // Issue #84: the package name is not the slug, so a static read offered a scheme the app lacks.
    it('builds the development build URL from the scheme a dynamic config evaluates to', async () => {
      const projectRoot = await setupAsync('dev-client-app');
      await fs.promises.rm(path.join(projectRoot, 'app.json'));
      await fs.promises.writeFile(
        path.join(projectRoot, 'app.config.js'),
        "module.exports = { name: 'BabyPath', slug: 'babypath', scheme: 'babypath' };\n"
      );
      const devServer = await startDevServerDoubleAsync([]);
      const releaseLock = await holdDevLockAsync(projectRoot, {
        url: devServer.url,
        port: Number(new URL(devServer.url).port),
        pid: process.pid,
        startedAt: new Date(Date.now() - 5_000).toISOString(),
        projectRoot,
      });
      try {
        const report: StatusReport = JSON.parse(
          (await executeAgentCliAsync(projectRoot, ['status', '--json'])).stdout
        );

        const devBuild = report.devServer!.openUrls.find((url) => url.target === 'dev-build');
        expect(devBuild?.url).toMatch(/^babypath:\/\//);
      } finally {
        releaseLock();
        await new Promise<void>((resolve) => devServer.server.close(() => resolve()));
      }
    });

    it('drops a logged tunnel once its dev server is gone', async () => {
      const projectRoot = await setupAsync('go-app');
      const logDir = path.join(projectRoot, '.expo', 'dev', 'logs');
      await fs.promises.mkdir(logDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(logDir, 'dev-detached.log'),
        'Waiting on https://stale-tunnel.boltexpo.dev\n'
      );

      const report = await reportInAsync(projectRoot);

      expect(report.devServer).toMatchObject({ running: false, tunnelUrl: null, openUrls: [] });
    });
  });

  describe('the dev server the project log names', () => {
    it('finds it from the metro:instantiate event in start.log', async () => {
      const projectRoot = await setupAsync('go-app');
      const devServer = await startDevServerDoubleAsync([]);
      try {
        const port = new URL(devServer.url).port;
        const logDir = path.join(projectRoot, '.expo', 'dev', 'logs');
        await fs.promises.mkdir(logDir, { recursive: true });
        await fs.promises.writeFile(
          path.join(logDir, 'start.log'),
          JSON.stringify({ _e: 'metro:instantiate', _t: Date.now(), port: Number(port) }) + '\n'
        );

        const result = await executeAgentCliAsync(projectRoot, ['status', '--json']);

        expect(result.exitCode).toBe(0);
        const report: StatusReport = JSON.parse(result.stdout);
        expect(report.devServer).toMatchObject({
          running: true,
          source: 'log',
          url: devServer.url,
        });
      } finally {
        await new Promise<void>((resolve) => devServer.server.close(() => resolve()));
      }
    });
  });

  describe('the dev server section', () => {
    let server: Server | undefined;

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
      }
    });

    it('reports a running dev server and the app connected to it', async () => {
      const projectRoot = await setupAsync('go-app');
      const devServer = await startDevServerDoubleAsync([CDP_TARGET]);
      server = devServer.server;

      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--json',
        '--dev-server-url',
        devServer.url,
      ]);

      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      // `toMatchObject` and then the one key that cannot be pinned: `openUrls` carries this
      // machine's LAN address, and a test that asserted one would pass or fail by which network the
      // suite is on. What it *can* pin is the form — Expo Go's, for a project with no dev client.
      expect(report.devServer).toMatchObject({
        url: devServer.url,
        running: true,
        appsConnected: 1,
        appsListed: 1,
        appsStale: 0,
        // The double answers the target list and 404s everything else, so it is reachable and its
        // bundler is not ready — which is exactly what a port that is not Metro looks like.
        source: 'flag',
        ready: false,
        projectRootMatched: null,
        hostType: null,
        tunnelUrl: null,
      });
      expect(Object.keys(report.devServer!).sort()).toEqual([
        'appsConnected',
        'appsListed',
        'appsStale',
        'hostType',
        'openUrls',
        'projectRootMatched',
        'ready',
        'running',
        'source',
        'tunnelUrl',
        'url',
      ]);
      expect(report.devServer!.openUrls.every((connect) => connect.url.startsWith('exp://'))).toBe(
        true
      );
    });

    // The readiness probe of status is short and never waits for a bundle, so this asserts the
    // answer a dev server that has already finished gives.
    it('reports a ready bundler and the project it serves', async () => {
      const projectRoot = await setupAsync('go-app');
      const stub = await startStubDevServerAsync({ projectRoot, targets: [CDP_TARGET] });

      try {
        const result = await executeAgentCliAsync(projectRoot, [
          'status',
          '--json',
          '--dev-server-url',
          stub.url,
        ]);

        expect(JSON.parse(result.stdout).devServer).toMatchObject({
          url: stub.url,
          running: true,
          appsConnected: 1,
          appsListed: 1,
          appsStale: 0,
          source: 'flag',
          ready: true,
          projectRootMatched: true,
          hostType: null,
          tunnelUrl: null,
        });
      } finally {
        await stub.close();
      }
    });

    // The report used to say "running on http://127.0.0.1:8099" and, three lines below it,
    // "next  @expo/agent-cli dev → expo-go: expo start --go" — advice to start a second dev server, which
    // is both a contradiction and a command that would fail on the busy port.
    it('sends a healthy dev server to verification instead of to a second dev server', async () => {
      const projectRoot = await setupAsync('go-app');
      const env = await bindDefaultDeviceAsync(projectRoot);
      const stub = await startStubDevServerAsync({ projectRoot, targets: [CDP_TARGET] });

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['status', '--json', '--dev-server-url', stub.url],
          { env }
        );

        const report: StatusReport = JSON.parse(result.stdout);
        expect(report.next?.command).toMatch(/^npx @expo\/agent-cli smoke --(ios|android)$/);
        expect(report.next?.why).toContain('instead of starting a second server');
        // The project's own shape is still reported: a running server does not change it.
        expect(report.next?.rule).toBe('expo-go');
        expect(report.next?.steps).toEqual([]);
      } finally {
        await stub.close();
      }
    });

    it('prints the reason on the human next line', async () => {
      const projectRoot = await setupAsync('go-app');
      const env = await bindDefaultDeviceAsync(projectRoot);
      const stub = await startStubDevServerAsync({ projectRoot, targets: [CDP_TARGET] });

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['status', '--dev-server-url', stub.url],
          { env }
        );

        expect(result.stdout).toContain('@expo/agent-cli smoke');
        expect(result.stdout).not.toContain('@expo/agent-cli dev → expo-go');
      } finally {
        await stub.close();
      }
    });

    // A dev server that serves someone else is not this project's, so the plan still stands.
    it('keeps the plan when the dev server belongs to another project', async () => {
      const projectRoot = await setupAsync('go-app');
      const env = await bindDefaultDeviceAsync(projectRoot);
      const stub = await startStubDevServerAsync({ projectRoot: '/somewhere/else', targets: [] });

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['status', '--json', '--dev-server-url', stub.url],
          { env }
        );

        const report: StatusReport = JSON.parse(result.stdout);
        expect(report.next?.command).toBe(
          `npx @expo/agent-cli dev --${process.platform === 'darwin' ? 'ios' : 'android'}`
        );
        expect(report.next?.why).toBeNull();
      } finally {
        await stub.close();
      }
    });

    it('names another project as the owner of the dev server that answered', async () => {
      const projectRoot = await setupAsync('go-app');
      const stub = await startStubDevServerAsync({ projectRoot: '/somewhere/else', targets: [] });

      try {
        const result = await executeAgentCliAsync(projectRoot, [
          'status',
          '--dev-server-url',
          stub.url,
        ]);

        expect(result.stdout).toContain('serves another project');
      } finally {
        await stub.close();
      }
    });

    it('prints the running dev server and its connected app for a human', async () => {
      const projectRoot = await setupAsync('go-app');
      const devServer = await startDevServerDoubleAsync([CDP_TARGET]);
      server = devServer.server;

      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        devServer.url,
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`running on ${devServer.url}`);
      expect(result.stdout).toContain('1 app connected');
    });

    it('reports a dev server without a connected app', async () => {
      const projectRoot = await setupAsync('go-app');
      const devServer = await startDevServerDoubleAsync([]);
      server = devServer.server;

      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--json',
        '--dev-server-url',
        devServer.url,
      ]);

      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      expect(report.devServer).toMatchObject({ running: true, appsConnected: 0 });
    });

    it('reports a dev server that does not answer, still exiting 0', async () => {
      const report = await reportAsync('go-app');

      expect(report.devServer?.running).toBe(false);
      expect(report.devServer?.appsConnected).toBe(0);
      expect(report.devServer?.reason).toBeTruthy();
      // Nothing answered, so nothing was asked about readiness either.
      expect(report.devServer).toMatchObject({ ready: null, projectRootMatched: null });
    });

    // @ref llp/0010 — `status` never waits for a bundle, so "still working" is its own answer and
    // not a claim that the bundler failed.
    it('reports an unknown readiness while the bundler is still working', async () => {
      const projectRoot = await setupAsync('go-app');
      const stub = await startStubDevServerAsync({ projectRoot, statusDelayMs: 30_000 });

      try {
        const result = await executeAgentCliAsync(projectRoot, [
          'status',
          '--json',
          '--dev-server-url',
          stub.url,
        ]);

        expect(JSON.parse(result.stdout).devServer).toMatchObject({ running: true, ready: null });
      } finally {
        await stub.close();
      }
    });

    // @ref llp/0005-runtime-loop-tools.rfc.md §Android — F56. A page a force-stopped app left in
    // `/json/list` is listed, not connected.
    it('counts the targets that still answer, and names the ones that do not', async () => {
      const projectRoot = await setupAsync('go-app');
      const devServer = await startDevServerDoubleAsync([CDP_TARGET], 'stale');
      server = devServer.server;

      const json = await executeAgentCliAsync(projectRoot, [
        'status',
        '--json',
        '--dev-server-url',
        devServer.url,
      ]);
      const text = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        devServer.url,
      ]);

      expect(JSON.parse(json.stdout).devServer).toMatchObject({
        appsConnected: 0,
        appsListed: 1,
        appsStale: 1,
      });
      expect(text.stdout).toContain('1 stale target still listed');
    });

    // The lock names the port this worktree's dev server holds now; a saved request names the one
    // it asked for last time.
    it('follows a running own lock over the port of the saved request', async () => {
      const projectRoot = await setupAsync('go-app');
      const ownUrl = await getUnusedDevServerUrlAsync();
      const ownPort = Number(new URL(ownUrl).port);
      await fs.promises.mkdir(path.join(projectRoot, '.expo'), { recursive: true });
      await fs.promises.writeFile(
        path.join(projectRoot, '.expo', 'agent-cli-last-dev.json'),
        JSON.stringify({
          version: 1,
          platform: 'android',
          port: ownPort + 1,
          buildBackend: 'local',
          runTarget: 'expo-go',
        })
      );
      const releaseLock = await holdDevLockAsync(projectRoot, {
        url: ownUrl,
        port: ownPort,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        projectRoot,
      });

      try {
        const result = await executeAgentCliAsync(projectRoot, ['status', '--json']);

        expect(result.exitCode).toBe(0);
        const report: StatusReport = JSON.parse(result.stdout);
        expect(report.devServer).toMatchObject({ url: ownUrl, running: false, source: 'lock' });
        expect(report.next?.command).toBe(
          `npx @expo/agent-cli dev --android --local --go --port ${ownPort} --detach --wait-ready`
        );
      } finally {
        releaseLock();
      }
    });

    // @ref llp/0004-smart-start-and-project-state.rfc.md §Discovery ladder
    // With no `--dev-server-url`, discovery asks the project's dev-server lock before it scans
    // ports. The lock is held by this test, standing in for a running `@expo/agent-cli start`.
    it('finds the dev server the project lock names, with no URL given', async () => {
      const projectRoot = await setupAsync('go-app');
      const devServer = await startDevServerDoubleAsync([CDP_TARGET]);
      server = devServer.server;
      const releaseLock = await holdDevLockAsync(projectRoot, {
        url: devServer.url,
        port: Number(new URL(devServer.url).port),
        pid: process.pid,
        startedAt: new Date().toISOString(),
        projectRoot,
      });

      try {
        const result = await executeAgentCliAsync(projectRoot, ['status', '--json']);

        expect(result.exitCode).toBe(0);
        const report: StatusReport = JSON.parse(result.stdout);
        // An ephemeral port, so no scan of 8081-8085 could have found it — and `source` now says
        // which step did.
        expect(report.devServer).toMatchObject({
          url: devServer.url,
          running: true,
          appsConnected: 1,
          appsListed: 1,
          appsStale: 0,
          source: 'lock',
          ready: false,
          projectRootMatched: null,
          hostType: null,
          tunnelUrl: null,
        });
      } finally {
        releaseLock();
      }
    });

    it('ignores a lock whose dev server is gone', async () => {
      const projectRoot = await setupAsync('go-app');
      const goneUrl = await getUnusedDevServerUrlAsync();
      const releaseLock = await holdDevLockAsync(projectRoot, {
        url: goneUrl,
        port: Number(new URL(goneUrl).port),
        pid: process.pid,
        startedAt: new Date().toISOString(),
        projectRoot,
      });

      try {
        const result = await executeAgentCliAsync(projectRoot, ['status', '--json']);

        expect(result.exitCode).toBe(0);
        const report: StatusReport = JSON.parse(result.stdout);
        // The lock is probed, never trusted, so a URL that does not answer is not the answer.
        // What discovery falls through to depends on the machine, so only this is asserted.
        expect(report.devServer?.url).not.toBe(goneUrl);
      } finally {
        releaseLock();
      }
    });

    // @ref llp/0004-smart-start-and-project-state.rfc.md §Discovery ladder
    // The regression this pins was invisible to every other test: the report was correct, complete
    // and printed at 263 ms, and the process then sat for another 1321 ms on timers no probe was
    // waiting for any more [observed — `friction/run7/tapapp`, 2026-08-27]. An agent loop pays that
    // on every `status`, and nothing in the output says so — only the exit does.
    //
    // Measured against the *named* path in the same run rather than against a fixed number, so the
    // test states the property it means — discovery costs about what naming a dead port costs — and
    // does not have to be retuned per machine. The margin is wide on purpose: it is well under the
    // 1321 ms it exists to catch and well over the spread of two process spawns.
    it('exits as promptly when it discovers the dev server as when it is named', async () => {
      const projectRoot = await setupAsync('go-app');
      const deadUrl = await getUnusedDevServerUrlAsync();

      const timeAsync = async (args: string[]): Promise<number> => {
        // Best of four: what is under test is the floor, and a scheduler hiccup only ever raises a
        // sample above it — so **more samples only ever make this estimate truer**, and cannot
        // inflate it the way they would for a mean. Two was not enough. The suite runs sharded and
        // in parallel, so both samples of one side landing on a busy moment is ordinary, and that
        // is the whole of the flake this row had [observed — 2026-09-06]. Four spawns per side cost
        // about two seconds against a 60s budget.
        const runs: number[] = [];
        for (let attempt = 0; attempt < 4; attempt++) {
          const startedAt = Date.now();
          const result = await executeAgentCliAsync(projectRoot, args);
          expect(result.exitCode).toBe(0);
          runs.push(Date.now() - startedAt);
        }
        return Math.min(...runs);
      };

      const named = await timeAsync(['status', '--json', '--dev-server-url', deadUrl]);
      const discovered = await timeAsync(['status', '--json']);

      expect(discovered - named).toBeLessThan(750);
    }, 60_000);

    it('rejects a `--dev-server-url` that is not a URL', async () => {
      const projectRoot = await setupAsync('go-app');
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', 'not a url'],
        { reject: false }
      );

      // A flag the user got wrong is an argument error, not a status the command can report.
      expect(result.exitCode).toBe(1);
      expect(result.all).toContain('--dev-server-url');
    });
  });
});
