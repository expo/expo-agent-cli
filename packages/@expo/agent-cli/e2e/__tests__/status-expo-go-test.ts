// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
//
// `status`: whether the project runs in Expo Go, before and after prebuild.
// The tests run it through the CLI it is published as, against the fixture matrix in
// `e2e/fixtures/README.md`. Shared helpers live in `statusFixtures.ts`.

import fs from 'node:fs';
import path from 'node:path';

import { detachedPidLine } from '../../src/dev/childVerdict';
import { androidBindingFixture, BOOTED_SIMULATOR, bindingFixture } from './installedAppStubs';
import {
  documentedJsonKeys,
  executeAgentCliAsync,
  holdDevLockAsync,
  readStubExpoInvocations,
  setupFixtureAsync,
  type DevLockInfo,
  writeAgentSelectionAsync,
} from '../utils';
import {
  type StatusReport,
  setupAsync,
  stubUnboundDeviceAsync,
  startDevServerDoubleAsync,
  getUnusedDevServerUrlAsync,
  reportInAsync,
  reportAsync,
  addNativeModuleAsync,
  goAppOnDumpSdkAsync,
  writePrebuildOutputAsync,
  git,
  initGitRepoAsync,
  installEnvFingerprintStubAsync,
  installStubEasAsync,
  REPORT_KEYS,
  statusEvent,
} from './statusFixtures';

describe('@expo/agent-cli status', () => {
  describe('go-app — an Expo Go compatible CNG project', () => {
    it('prints one line per section', async () => {
      const projectRoot = await setupAsync('go-app');
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env: await stubUnboundDeviceAsync(projectRoot) }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('project');
      expect(result.stdout).toContain('go-app');
      expect(result.stdout).toContain('SDK 54.0.0');
      expect(result.stdout).toContain('CNG');
      expect(result.stdout).toContain('expo go');
      expect(result.stdout).toContain('compatible');
      expect(result.stdout).toContain('freshness');
      expect(result.stdout).toContain('dev server');
      expect(result.stdout).toContain('not running');
      expect(result.stdout).toContain('device');
      expect(result.stdout).toContain('next');
      expect(result.stdout).toContain(
        `No ${process.platform === 'darwin' ? 'ios' : 'android'} device is bound to this worktree.`
      );
    });

    // @ref llp/0021-honest-reports.rfc.md §How they show up
    // One run per fact `status` reads for the `next` line on a host that binds devices.
    describe('the next line on a host that binds devices', () => {
      const platform = process.platform === 'darwin' ? 'ios' : 'android';
      const other = platform === 'ios' ? 'android' : 'ios';
      const dev = `npx @expo/agent-cli dev --${platform}`;
      const unbound = `No ${platform} device is bound to this worktree.`;
      const lockOf = (projectRoot: string, url: string): DevLockInfo => ({
        url,
        port: Number(new URL(url).port),
        pid: process.pid,
        startedAt: new Date().toISOString(),
        projectRoot,
      });

      it.each<{
        name: string;
        /** Returns the lock's release, or the file that the row's `next` names. */
        setup: (
          projectRoot: string,
          url: string
        ) => Promise<{ release?: () => void; file?: string }>;
        next: (port: string, file?: string) => { command: unknown; why: unknown };
      }>([
        {
          name: 'stops an own dev server that must restart to bind a device',
          setup: async (projectRoot, url) => ({
            release: await holdDevLockAsync(projectRoot, lockOf(projectRoot, url)),
          }),
          next: (port) => ({
            command: `npx @expo/agent-cli dev:stop && ${dev} --port ${port} --detach --wait-ready`,
            why: `${unbound} The running dev server must restart to bind one.`,
          }),
        },
        {
          name: 'says the EAS session is starting while the detached child starts it',
          setup: async (projectRoot, url) => {
            const logDir = path.join(projectRoot, '.expo', 'dev', 'logs');
            await fs.promises.mkdir(logDir, { recursive: true });
            await fs.promises.writeFile(
              path.join(logDir, 'dev-detached.log'),
              `${detachedPidLine(process.pid)}\n`
            );
            return {
              release: await holdDevLockAsync(projectRoot, {
                ...lockOf(projectRoot, url),
                easPlatform: platform,
              }),
            };
          },
          next: () => ({
            command: `${dev} --eas --detach --wait-ready`,
            why: `The dev server's EAS Simulator session for ${platform} is starting. This command waits for it, or reopens the app on the running Metro. No restart is needed.`,
          }),
        },
        {
          name: 'asks for no local device when the config puts the device on EAS',
          setup: async (projectRoot) => {
            const file = path.join(projectRoot, 'package.json');
            const manifest = JSON.parse(await fs.promises.readFile(file, 'utf8'));
            manifest.expo = { ...manifest.expo, 'agent-cli': { deviceBackend: 'eas' } };
            await fs.promises.writeFile(file, JSON.stringify(manifest, null, 2));
            return {};
          },
          next: (port) => ({ command: `${dev} --port ${port} --detach --wait-ready`, why: null }),
        },
        {
          name: 'removes a binding file that does not parse',
          setup: async (projectRoot) => {
            const file =
              platform === 'ios'
                ? await bindingFixture(projectRoot, BOOTED_SIMULATOR.udid)
                : await androidBindingFixture(projectRoot, 'emulator-5554');
            await fs.promises.writeFile(file, '{');
            return { file };
          },
          next: (port, file) => ({
            command: `rm -f '${file}' && ${dev} --port ${port} --detach --wait-ready`,
            why: `The binding file ${file} does not parse; a newer CLI may have written it.`,
          }),
        },
        {
          name: 'takes the platform of a sole binding',
          setup: async (projectRoot) => {
            await (other === 'ios'
              ? bindingFixture(projectRoot, BOOTED_SIMULATOR.udid)
              : androidBindingFixture(projectRoot, 'emulator-5554'));
            return {};
          },
          next: (port) => ({
            command: `npx @expo/agent-cli dev --${other} --port ${port} --detach --wait-ready`,
            why: null,
          }),
        },
      ])('$name', async ({ setup, next }) => {
        const projectRoot = await setupAsync('go-app');
        const env = await stubUnboundDeviceAsync(projectRoot);
        const url = await getUnusedDevServerUrlAsync();
        const { release, file } = await setup(projectRoot, url);
        try {
          const result = await executeAgentCliAsync(
            projectRoot,
            ['status', '--json', '--dev-server-url', url],
            { env }
          );

          expect(result.exitCode).toBe(0);
          const report: StatusReport = JSON.parse(result.stdout);
          expect({ command: report.next?.command, why: report.next?.why }).toEqual(
            next(new URL(url).port, file)
          );
        } finally {
          release?.();
        }
      });
    });

    it('reports every section in the JSON report', async () => {
      const report = await reportAsync('go-app');

      expect(Object.keys(report)).toEqual(REPORT_KEYS);
      expect(report.errors).toEqual({});
      expect(report.orphanSessions).toEqual([]);
      expect(report.project).toMatchObject({
        name: 'go-app',
        sdkVersion: '54.0.0',
        native: 'cng',
        usesDevClient: false,
        hasWeb: true,
      });
      expect(report.expoGo).toEqual({ compatible: true, reasonCount: 0 });
      expect(report.next?.rule).toBe('expo-go');
      expect(report.next?.steps[0]!.argv).toEqual([
        'expo',
        'start',
        '--go',
        '--port',
        new URL(report.devServer!.url).port,
      ]);
    });

    it('reports an unknown freshness when the project has no fingerprint tool', async () => {
      const report = await reportAsync('go-app');

      // No `fingerprint` bin is installed for this fixture, so nothing can be compared.
      expect(report.freshness?.hash).toBeNull();
      // Four entries: backend × platform (llp/0021 §The rules). The two local axes
      // have no fingerprint to compare; the two EAS axes were never asked.
      expect(
        report.freshness?.platforms.map(
          (platform) => `${platform.platform} ${platform.backend} ${platform.state}`
        )
      ).toEqual([
        'ios local unknown',
        'ios eas unknown',
        'android local unknown',
        'android eas unknown',
      ]);
    });

    // @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol
    // Who the CLI family acts as, asked with a stub `eas` so the answer is the fixture's and not
    // the machine's.
    describe('the auth section', () => {
      it('reports the account the EAS CLI named', async () => {
        const projectRoot = await setupAsync('go-app');
        await installStubEasAsync(projectRoot, { user: 'e2e-user' });

        const report = await reportInAsync(projectRoot);

        expect(report.auth).toEqual({
          loggedIn: true,
          user: 'e2e-user',
          source: 'eas whoami',
        });
      });

      it('reports a signed-out machine, and still exits 0', async () => {
        const projectRoot = await setupAsync('go-app');
        await installStubEasAsync(projectRoot, { user: null });

        const result = await executeAgentCliAsync(projectRoot, [
          'status',
          '--dev-server-url',
          await getUnusedDevServerUrlAsync(),
        ]);

        // Status is information: not being signed in is a fact it reports, not a failure.
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('auth');
        expect(result.stdout).toContain('not signed in');
      });
    });

    // Section isolation: a discovery that cannot run costs the skills line, never the report's
    // shape or another section.
    it('notes a skills section it could not read, and reports the rest', async () => {
      const projectRoot = await setupAsync('go-app');
      await fs.promises.rm(
        path.join(
          projectRoot,
          'node_modules',
          'expo',
          'internal',
          'unstable-autolinking-exports.js'
        )
      );
      const eventsFile = path.join(projectRoot, 'events.jsonl');

      const report = await reportInAsync(projectRoot, [], { LOG_EVENTS: eventsFile });

      expect(Object.keys(report)).toEqual(REPORT_KEYS);
      expect(report.skills).toBeNull();
      expect(Object.keys(report.errors)).toEqual(['skills']);
      expect(report.project?.name).toBe('go-app');
      expect(statusEvent(eventsFile)).toMatchObject({ sectionErrors: ['skills'] });
    });

    // Without a selection there is nowhere to link to, so no discovered skill counts as linked.
    it('reports that no agent is selected', async () => {
      const report = await reportAsync('skills-app');

      expect(report.skills).toMatchObject({ agentIds: null, linked: 0 });
      expect(report.skills!.discovered).toBeGreaterThan(0);
    });

    it('reports the agents a previous skills run selected', async () => {
      const projectRoot = await setupAsync('go-app');
      await writeAgentSelectionAsync(projectRoot, ['claude-code']);

      const report = await reportInAsync(projectRoot);

      expect(report.skills?.agentIds).toEqual(['claude-code']);
    });

    it('starts nothing and exits 0', async () => {
      const projectRoot = await setupAsync('go-app');
      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      // Status is read-only. It runs `expo whoami` only when the EAS CLI could not answer who this
      // machine is: both CLIs read the same session file, and a report that said "nothing could
      // answer" while `@expo/agent-cli whoami` printed the name was the finding (F65). The other
      // `expo` it runs is `expo config`, for the OTA verdict. Nothing is started.
      const invocations = readStubExpoInvocations(projectRoot).map((invocation) => invocation.args);
      expect(invocations).toHaveLength(2);
      expect(invocations).toEqual(
        expect.arrayContaining([['whoami'], ['config', '--json', '--type', 'public']])
      );
    });

    it('emits the status event for a driving agent', async () => {
      const projectRoot = await setupAsync('go-app');
      const eventsFile = path.join(projectRoot, 'events.jsonl');
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env: { LOG_EVENTS: eventsFile } }
      );

      expect(result.exitCode).toBe(0);
      const status = statusEvent(eventsFile);
      expect(status).toMatchObject({
        rule: 'expo-go',
        sdkVersion: '54.0.0',
        expoGoCompatible: true,
        devServerRunning: false,
        appsConnected: 0,
        appsListed: 0,
        appsStale: 0,
        devServerHostType: null,
        tunnelUrl: null,
        openUrl: null,
        installed: null,
        freshness: { ios: 'unknown', android: 'unknown' },
        easBuilds: { ios: 'unknown', android: 'unknown' },
        impact: { ios: null, android: null },
        assertion: null,
        easBuildsAsked: false,
        skillsDiscovered: 0,
        skillsLinked: 0,
        sectionErrors: [],
      });

      // Beside a dev server, with a fingerprint tool, on a host that reads devices.
      await installEnvFingerprintStubAsync(projectRoot);
      const devServer = await startDevServerDoubleAsync([]);
      try {
        const env = await stubUnboundDeviceAsync(projectRoot);
        const served = path.join(projectRoot, 'events-served.jsonl');
        const report = await reportInAsync(projectRoot, ['--dev-server-url', devServer.url], {
          ...env,
          LOG_EVENTS: served,
        });

        expect(report.devServer!.openUrls[0]!.url).toMatch(/^exp:\/\//);
        expect(statusEvent(served)).toMatchObject({
          devServerRunning: true,
          openUrl: report.devServer!.openUrls[0]!.url,
          localDevice: 'absent',
          installed: 'unknown',
          fingerprintSource: 'computed',
          fingerprintRevalidatedAgainst: null,
        });
      } finally {
        await new Promise<void>((resolve) => devServer.server.close(() => resolve()));
      }
    });

    // @ref llp/0009-smart-followups.rfc.md §Examples per command — status keeps its own `next`
    // line, so the follow-ups only reach a driving agent through JSON and the event stream.
    it('keeps the follow-ups out of the text report', async () => {
      const projectRoot = await setupAsync('go-app');
      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('Suggested next:');
    });

    it('reports an empty follow-up list with --no-followups, keeping the key set', async () => {
      const projectRoot = await setupAsync('go-app');
      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--json',
        '--no-followups',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      expect(report.followups).toEqual([]);
      expect(Object.keys(report)).toContain('followups');
    });

    // @ref llp/0006-agent-native-cli-surface.rfc.md §Output contract — **F144.** The two lists were
    // both here and disagreed: the e2e above pinned `followups` in the payload, and the help block's
    // `keys` line did not name it, so a caller who read the documentation branched on a key set the
    // command does not have. Compared at the process boundary, because that is where the promise is
    // made — a caller reads `--help` and then reads the object.
    it('documents exactly the keys it emits', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      const devServerUrl = await getUnusedDevServerUrlAsync();

      const help = await executeAgentCliAsync(projectRoot, ['status', '--help']);
      const report = await executeAgentCliAsync(projectRoot, [
        'status',
        '--json',
        '--dev-server-url',
        devServerUrl,
      ]);

      expect(documentedJsonKeys(help.stdout).sort()).toEqual(
        Object.keys(JSON.parse(report.stdout)).sort()
      );
    });
  });

  describe('Expo Go compatibility of a new project', () => {
    it('should report a new go-app as compatible', async () => {
      const report = await reportInAsync(await goAppOnDumpSdkAsync());

      expect(report.expoGo).toEqual({ compatible: true, reasonCount: 0 });
      expect(report.probe?.expoGo.reasons).toEqual([]);
    });

    it('should stay compatible after adding expo-sqlite', async () => {
      const projectRoot = await goAppOnDumpSdkAsync();
      await addNativeModuleAsync(projectRoot, 'expo-sqlite');

      const report = await reportInAsync(projectRoot);

      expect(report.expoGo).toEqual({ compatible: true, reasonCount: 0 });
      expect(report.probe?.expoGo.reasons).toEqual([]);
    });

    it('should stay compatible after adding @shopify/react-native-skia', async () => {
      const projectRoot = await goAppOnDumpSdkAsync();
      await addNativeModuleAsync(projectRoot, 'expo-sqlite');
      await addNativeModuleAsync(projectRoot, '@shopify/react-native-skia');

      const report = await reportInAsync(projectRoot);

      expect(report.expoGo).toEqual({ compatible: true, reasonCount: 0 });
      expect(report.probe?.expoGo.reasons).toEqual([]);
    });

    it('should become incompatible after adding expo-observe', async () => {
      const projectRoot = await goAppOnDumpSdkAsync();
      await addNativeModuleAsync(projectRoot, 'expo-sqlite');
      await addNativeModuleAsync(projectRoot, '@shopify/react-native-skia');
      await addNativeModuleAsync(projectRoot, 'expo-observe');

      const report = await reportInAsync(projectRoot);

      expect(report.expoGo?.compatible).toBe(false);
      expect(report.expoGo!.reasonCount).toBeGreaterThan(0);
      expect(report.probe?.expoGo.reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'unbundled-native-module',
            packageName: 'expo-observe',
          }),
        ])
      );
      const packages = (report.probe?.expoGo.reasons ?? []).map((reason) => reason.packageName);
      expect(packages).not.toContain('expo-sqlite');
      expect(packages).not.toContain('@shopify/react-native-skia');
    });

    const OTHER_PLUGIN = [
      expect.objectContaining({ kind: 'config-plugin', packageName: 'react-native-other' }),
    ];
    const FIRST_CALL_ONLY = [
      'let calls = 0;',
      'const plugins = () => { calls += 1; return calls === 1 ? ["react-native-other"] : []; };',
    ];

    // No plugin module is installed: the check reads the declared list, it does not load it.
    // Status reads the config more than once, and every read sees the same single call.
    it.each([
      [
        'should see the plugins a dynamic config keeps from app.json and adds',
        {
          'app.config.js':
            'module.exports = ({ config }) => ({ ...config, plugins: [...config.plugins, "react-native-other"] });\n',
        },
        [
          expect.objectContaining({ kind: 'config-plugin', packageName: 'react-native-fancy' }),
          expect.objectContaining({ kind: 'config-plugin', packageName: 'react-native-other' }),
        ],
      ],
      [
        'should read the plugins of a config that answers differently on a later call',
        {
          'app.config.js': [
            ...FIRST_CALL_ONLY,
            'module.exports = ({ config }) => ({ ...config, plugins: plugins() });',
            '',
          ].join('\n'),
        },
        OTHER_PLUGIN,
      ],
      [
        'should read the plugins of an ES module config that answers differently on a later call',
        {
          'app.config.mjs': [
            ...FIRST_CALL_ONLY,
            'export default ({ config }) => ({ ...config, plugins: plugins() });',
            '',
          ].join('\n'),
        },
        OTHER_PLUGIN,
      ],
      [
        'should read the plugins of a config whose helper keeps its own list',
        {
          'plugins.js': [
            'const list = [];',
            'module.exports = () => { list.push("react-native-other"); return list; };',
            '',
          ].join('\n'),
          'app.config.js': [
            'const plugins = require("./plugins");',
            'module.exports = ({ config }) => ({ ...config, plugins: plugins() });',
            '',
          ].join('\n'),
        },
        OTHER_PLUGIN,
      ],
      [
        'should call the plugins unknown when the dynamic config throws',
        {
          'app.config.js':
            "module.exports = () => { throw new Error('Cannot resolve app config'); };\n",
        },
        [
          expect.objectContaining({
            kind: 'unknown-app-config',
            detail: expect.stringContaining('Cannot resolve app config'),
          }),
        ],
      ],
    ])('%s', async (_name, files, reasons) => {
      const projectRoot = await goAppOnDumpSdkAsync();
      const appJsonPath = path.join(projectRoot, 'app.json');
      const appJson = JSON.parse(await fs.promises.readFile(appJsonPath, 'utf8'));
      appJson.expo.plugins = ['react-native-fancy'];
      await fs.promises.writeFile(appJsonPath, JSON.stringify(appJson));
      for (const [name, contents] of Object.entries(files)) {
        await fs.promises.writeFile(path.join(projectRoot, name), contents);
      }

      const report = await reportInAsync(projectRoot);

      expect(report.probe?.expoGo.reasons).toEqual(reasons);
    });

    // `@expo/require-utils` runs a file that throws while it loads twice on its own.
    it('should load a config that throws while it loads once per command', async () => {
      const projectRoot = await goAppOnDumpSdkAsync();
      await fs.promises.writeFile(
        path.join(projectRoot, 'app.config.js'),
        [
          'require("fs").appendFileSync(__dirname + "/runs.log", "run\\n");',
          'throw new Error("Cannot resolve app config");',
          '',
        ].join('\n')
      );

      await reportInAsync(projectRoot);

      const runs = await fs.promises.readFile(path.join(projectRoot, 'runs.log'), 'utf8');
      expect(runs.trim().split('\n').length).toBeLessThanOrEqual(2);
    });
  });

  describe('Expo Go compatibility after prebuild', () => {
    it('should stay CNG and compatible when ios/ and android/ are gitignored', async () => {
      const projectRoot = await goAppOnDumpSdkAsync();
      await writePrebuildOutputAsync(projectRoot);

      const report = await reportInAsync(projectRoot);

      expect(report.project?.native).toBe('cng');
      expect(report.project?.nativeDirs).toEqual({ ios: false, android: false });
      expect(report.expoGo).toEqual({ compatible: true, reasonCount: 0 });
      expect(report.probe?.expoGo.reasons).toEqual([]);
    });

    it('should stay CNG when git check-ignore covers the prebuild output', async () => {
      const projectRoot = await goAppOnDumpSdkAsync();
      await writePrebuildOutputAsync(projectRoot);
      await initGitRepoAsync(projectRoot);

      const report = await reportInAsync(projectRoot);

      expect(report.project?.native).toBe('cng');
      expect(report.project?.nativeDirs).toEqual({ ios: false, android: false });
      expect(report.expoGo).toEqual({ compatible: true, reasonCount: 0 });
    });

    it('should report custom-native-code when prebuild output is tracked', async () => {
      const projectRoot = await goAppOnDumpSdkAsync();
      await writePrebuildOutputAsync(projectRoot);
      await initGitRepoAsync(projectRoot);
      git(projectRoot, ['add', '-f', '--', 'ios', 'android']);

      const report = await reportInAsync(projectRoot);

      expect(report.project?.native).toBe('bare');
      expect(report.project?.nativeDirs).toEqual({ ios: true, android: true });
      expect(report.expoGo?.compatible).toBe(false);
      expect(report.probe?.expoGo.reasons).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'custom-native-code' })])
      );
    });

    it('should report a local module under modules/ as unbundled', async () => {
      const projectRoot = await goAppOnDumpSdkAsync();
      const moduleRoot = path.join(projectRoot, 'modules', 'local-native');
      await fs.promises.mkdir(path.join(moduleRoot, 'ios'), { recursive: true });
      await fs.promises.writeFile(
        path.join(moduleRoot, 'package.json'),
        JSON.stringify({ name: 'local-native', version: '1.0.0' })
      );
      await fs.promises.writeFile(path.join(moduleRoot, 'expo-module.config.json'), '{}');
      await fs.promises.writeFile(path.join(moduleRoot, 'ios', 'Module.swift'), '');

      const report = await reportInAsync(projectRoot);

      expect(report.expoGo?.compatible).toBe(false);
      expect(report.probe?.expoGo.reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'unbundled-native-module',
            packageName: 'local-native',
          }),
        ])
      );
    });
  });
});
