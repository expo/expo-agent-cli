// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
//
// `@expo/agent-cli status` is the read-only overview: it prints where the project is and what would
// happen next, and always exits 0. This file covers the report shape, the next step, the follow-ups
// and `--assert`.
// The tests run it through the CLI it is published as, against the fixture matrix in
// `e2e/fixtures/README.md`. Shared helpers live in `statusFixtures.ts`.

import fs from 'node:fs';
import path from 'node:path';

import { installStubEasAsync as installSharedStubEasAsync } from '../stubEas';
import {
  breakXcodeSelectAsync,
  executeAgentCliAsync,
  lastBuildFilePath,
  readEvents,
  setupFixtureAsync,
  writeAgentSelectionAsync,
} from '../utils';
import {
  type StatusReport,
  FIXTURE_FINGERPRINT_HASH,
  CDP_TARGET,
  setupAsync,
  startDevServerDoubleAsync,
  getUnusedDevServerUrlAsync,
  reportInAsync,
  reportAsync,
  addNativeModuleAsync,
  goAppOnDumpSdkAsync,
  pinEasCliAsync,
  installEnvFingerprintStubAsync,
} from './statusFixtures';

describe('@expo/agent-cli status', () => {
  it('prints usage with `status --help`', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const result = await executeAgentCliAsync(projectRoot, ['status', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.all).toContain('--json');
    expect(result.all).toContain('--dev-server-url');
  });

  it('lists the command in the top level help', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const result = await executeAgentCliAsync(projectRoot, ['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.all).toContain('status');
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Not an Expo app
  it('points a directory that is not an Expo app at creating one', async () => {
    const projectRoot = await setupAsync('go-app');
    const manifestPath = path.join(projectRoot, 'package.json');
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    delete manifest.dependencies.expo;
    await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    const report = await reportInAsync(projectRoot);

    expect(report.next).toMatchObject({ command: 'npx @expo/agent-cli new my-app' });
    expect(report.next!.why).toContain('not an Expo app');
    // Every other rung assumes an Expo app, so this is the only follow-up.
    expect(report.followups.map((followup) => followup.id)).toEqual(['not-expo-app']);
  });

  // @ref llp/0009-smart-followups.rfc.md §Examples per command
  describe('the follow-ups', () => {
    it('names runtime:errors when an app is connected to the dev server', async () => {
      const projectRoot = await setupAsync('go-app');
      const devServer = await startDevServerDoubleAsync([CDP_TARGET]);
      const eventsFile = path.join(projectRoot, 'events.jsonl');
      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['status', '--json', '--dev-server-url', devServer.url],
          { env: { LOG_EVENTS: eventsFile } }
        );

        expect(result.exitCode).toBe(0);
        const report: StatusReport = JSON.parse(result.stdout);
        const runtimeErrors = expect.objectContaining({
          id: 'runtime-errors',
          command: 'npx @expo/agent-cli runtime:errors',
        });
        expect(report.followups).toContainEqual(runtimeErrors);
        // The `next` line already says what to do, so the follow-ups reach an agent only through
        // the JSON report and the event, never as a text section.
        expect(readEvents(eventsFile).filter((entry) => entry._e === 'cli:followups')).toEqual([
          expect.objectContaining({ command: 'status', followups: [runtimeErrors] }),
        ]);
        const text = await executeAgentCliAsync(projectRoot, [
          'status',
          '--dev-server-url',
          devServer.url,
        ]);
        expect(text.stdout).not.toContain('Suggested next:');
      } finally {
        await new Promise<void>((resolve) => devServer.server.close(() => resolve()));
      }
    });

    it('names expo-dev-client when Expo Go cannot run the project and it has no dev client', async () => {
      const projectRoot = await goAppOnDumpSdkAsync();
      await addNativeModuleAsync(projectRoot, 'expo-observe');

      const report = await reportInAsync(projectRoot);

      expect(report.expoGo?.compatible).toBe(false);
      expect(report.project?.usesDevClient).toBe(false);
      expect(report.followups).toContainEqual(
        expect.objectContaining({
          id: 'install-dev-client',
          command: 'npx @expo/agent-cli install expo-dev-client',
        })
      );
    });

    it('names skills:sync when the selected agent has unlinked skills', async () => {
      const projectRoot = await setupAsync('skills-app');
      await writeAgentSelectionAsync(projectRoot, ['claude-code']);

      const report = await reportInAsync(projectRoot);

      expect(report.skills).toMatchObject({ agentIds: ['claude-code'], linked: 0 });
      expect(report.skills!.discovered).toBeGreaterThan(0);
      expect(report.followups).toContainEqual(
        expect.objectContaining({ id: 'skills-sync', command: 'npx @expo/agent-cli skills:sync' })
      );

      await executeAgentCliAsync(projectRoot, ['skills:sync', '--json']);
      const synced = await reportInAsync(projectRoot);
      expect(synced.skills!.linked).toBe(synced.skills!.discovered);
      expect(synced.followups.map((followup) => followup.id)).not.toContain('skills-sync');
    });
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Status
  //
  // The one path out of this command that is not 0, and the reason it does not break the exit-0
  // contract: nothing changes unless the caller types the flag. These run the published bin, so
  // they assert the exit code a CI line would actually read.
  describe('status --assert', () => {
    const NATIVE_MODULE = {
      type: 'dir',
      filePath: 'node_modules/react-native-mmkv',
      reasons: ['rncoreAutolinkingIos'],
      hash: 'aabb',
    };
    const APP_CONFIG = { type: 'file', filePath: 'app.json', reasons: ['expoConfig'], hash: 'cc' };

    async function setupAssertAsync(recorded: unknown): Promise<string> {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      await installEnvFingerprintStubAsync(projectRoot);
      await fs.promises.writeFile(lastBuildFilePath(projectRoot), JSON.stringify(recorded));
      return projectRoot;
    }

    /** Both platforms recorded from the same fingerprint, so the gate has something to measure. */
    function recordedWith(sources: unknown[]) {
      return {
        ios: { hash: FIXTURE_FINGERPRINT_HASH, sources },
        android: { hash: FIXTURE_FINGERPRINT_HASH, sources },
      };
    }

    async function runAssertAsync(
      projectRoot: string,
      args: string[],
      env: Record<string, string> = {}
    ) {
      return executeAgentCliAsync(
        projectRoot,
        ['status', ...args, '--dev-server-url', await getUnusedDevServerUrlAsync()],
        { env, reject: false }
      );
    }

    it('exits 0 when the change costs at most the asserted class', async () => {
      const projectRoot = await setupAssertAsync(recordedWith([APP_CONFIG]));

      const result = await runAssertAsync(projectRoot, ['--assert', 'needs-native-build'], {
        STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
        STUB_FP_SOURCES: JSON.stringify([APP_CONFIG, NATIVE_MODULE]),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('assert');
      expect(result.stdout).toContain('the change costs at most that');
    });

    it('exits 20 when the change costs more than the asserted class', async () => {
      const projectRoot = await setupAssertAsync(recordedWith([APP_CONFIG]));

      const result = await runAssertAsync(projectRoot, ['--assert', 'js-only'], {
        STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
        STUB_FP_SOURCES: JSON.stringify([APP_CONFIG, NATIVE_MODULE]),
      });

      expect(result.exitCode).toBe(20);
      // The report is printed either way: a gate that failed is still a report, and the reasons
      // above it are what an agent reads next.
      expect(result.stdout).toContain('project');
      expect(result.stdout).toContain('the change costs needs-native-build');
    });

    // llp/0010's code for "nothing was shown to be wrong and nothing was proved right", which is
    // the third outcome and the one that keeps the gate honest.
    it('exits 22 when nothing could be measured', async () => {
      const projectRoot = await setupAssertAsync({});

      const result = await runAssertAsync(projectRoot, ['--assert', 'js-only']);

      expect(result.exitCode).toBe(22);
      expect(result.stdout).toContain('not verified');
    });

    it('carries the OTA verdict beside the gate', async () => {
      const projectRoot = await setupAssertAsync(recordedWith([APP_CONFIG]));
      const payload = path.join(projectRoot, 'stub-expo-config.json');
      await fs.promises.writeFile(
        payload,
        JSON.stringify({ name: 'fresh', slug: 'fresh', runtimeVersion: { policy: 'appVersion' } })
      );

      const result = await runAssertAsync(projectRoot, ['--assert', 'js-only'], {
        STUB_EXPO_CONFIG_JSON: payload,
        STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
        STUB_FP_SOURCES: JSON.stringify([APP_CONFIG, NATIVE_MODULE]),
      });

      expect(result.exitCode).toBe(20);
      // Both halves ran: the deep dive printed, and the gate judged what it found.
      expect(result.stdout).toContain('ota');
      expect(result.stdout).toContain('the change costs needs-native-build');
    });

    it('carries the verdict in --json, which exits with the same code', async () => {
      const projectRoot = await setupAssertAsync(recordedWith([APP_CONFIG]));

      const result = await runAssertAsync(projectRoot, ['--assert', 'js-only', '--json'], {
        STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
        STUB_FP_SOURCES: JSON.stringify([APP_CONFIG, NATIVE_MODULE]),
      });

      expect(result.exitCode).toBe(20);
      const report: StatusReport = JSON.parse(result.stdout);
      expect(report.assertion).toMatchObject({
        asserted: 'js-only',
        actual: 'needs-native-build',
        ok: false,
        exitCode: 20,
      });
    });

    it('reports no assertion, and exits 0, when the flag is absent', async () => {
      const projectRoot = await setupAssertAsync(recordedWith([APP_CONFIG]));

      const result = await runAssertAsync(projectRoot, ['--json'], {
        STUB_FINGERPRINT_HASH: 'ffff1111ffff1111ffff1111ffff1111ffff1111',
        STUB_FP_SOURCES: JSON.stringify([APP_CONFIG, NATIVE_MODULE]),
      });

      expect(result.exitCode).toBe(0);
      expect((JSON.parse(result.stdout) as StatusReport).assertion).toBeNull();
    });

    it('rejects a class it does not report, with exit 1', async () => {
      const projectRoot = await setupAssertAsync(recordedWith([APP_CONFIG]));

      const result = await runAssertAsync(projectRoot, ['--assert', 'native']);

      // A usage error is the tool not working, which is 1 — never the outcome band.
      expect(result.exitCode).toBe(1);
      expect(result.all).toContain('not one of the classes');
    });

    it('rejects --explain as an unknown option', async () => {
      const projectRoot = await setupAssertAsync(recordedWith([APP_CONFIG]));

      const result = await runAssertAsync(projectRoot, ['--explain']);

      expect(result.exitCode).toBe(1);
      expect(result.all).toContain('--explain');
    });

    it('takes --build, and echoes the build it was given', async () => {
      const projectRoot = await setupAssertAsync(recordedWith([APP_CONFIG]));
      await installSharedStubEasAsync(projectRoot);
      await pinEasCliAsync(projectRoot);

      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--json',
        '--build',
        'build-1',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      const report: StatusReport = JSON.parse(result.stdout);
      expect(report.freshness!.comparison).toMatchObject({ kind: 'eas-build', buildId: 'build-1' });
      expect(result.all).not.toContain('--explain');
    });
  });

  describe('bare-app — committed native directories', () => {
    it('reports the project as bare and plans a build', async () => {
      const report = await reportAsync('bare-app');

      expect(report.project?.native).toBe('bare');
      expect(report.project?.nativeDirs).toEqual({ ios: true, android: true });
      expect(report.next?.rule).toBe('bare-stale');
    });

    it('names the checked-in native directories in the human report', async () => {
      const projectRoot = await setupAsync('bare-app');
      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bare (ios, android)');
    });
  });

  // @ref llp/0015-backend-selection-and-config.rfc.md §What `status` reports
  describe('where the next build would run', () => {
    it('says nothing about a build for a project whose next plan has none', async () => {
      const projectRoot = await setupAsync('go-app');
      const report = await reportInAsync(projectRoot);
      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);

      expect(report.next?.buildLocation).toBeNull();
      expect(result.stdout).not.toMatch(/^build\s/m);
    });

    it('names the place and the cause for a project that needs one', async () => {
      const report = await reportAsync('dev-client-app');

      expect(report.next?.buildLocation).not.toBeNull();
      expect(['local', 'eas']).toContain(report.next!.buildLocation!.runsOn);
      // Something chose it, and said so in a sentence every other surface prints too.
      expect(report.next!.buildLocation!.selection!.because).toBeTruthy();
    });

    it('reports the backend the project config asked for, in both outputs', async () => {
      const projectRoot = await setupAsync('dev-client-app');
      const file = path.join(projectRoot, 'package.json');
      const packageJson = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      packageJson.expo = { ...packageJson.expo, 'agent-cli': { buildBackend: 'eas' } };
      await fs.promises.writeFile(file, JSON.stringify(packageJson, null, 2));

      const report = await reportInAsync(projectRoot);
      expect(report.next!.buildLocation).toMatchObject({
        runsOn: 'eas',
        selection: { source: 'config' },
      });

      const result = await executeAgentCliAsync(projectRoot, [
        'status',
        '--dev-server-url',
        await getUnusedDevServerUrlAsync(),
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('build ');
      expect(result.stdout).toContain('"expo.agent-cli" in package.json');
    });

    // `status` exits 0 by contract, and a preference file it cannot read must not change that:
    // every other line of the report is still a fact worth having.
    it('still reports everything else when the config cannot be read', async () => {
      const projectRoot = await setupAsync('dev-client-app');
      const file = path.join(projectRoot, 'package.json');
      const packageJson = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      packageJson.expo = { ...packageJson.expo, 'agent-cli': { buildBackend: 'cloud' } };
      await fs.promises.writeFile(file, JSON.stringify(packageJson, null, 2));

      const report = await reportInAsync(projectRoot);

      expect(report.project?.name).toBeTruthy();
      expect(report.next?.rule).toBe('dev-client-stale');
    });
  });

  describe('broken-app — a dependency missing from node_modules', () => {
    it('still reports the sections it can read', async () => {
      const report = await reportAsync('broken-app');

      expect(report.project?.name).toBe('broken-app');
      expect(report.next).not.toBeNull();
      expect(report.devServer?.running).toBe(false);
    });
  });
});

// @ref llp/0015-backend-selection-and-config.rfc.md §The selection — named, not taken. A `next`
// has to be a line that runs, and a bare `dev` stops on a route detection chose.
describe('status on a machine that cannot build', () => {
  // `status` takes no platform flag: it plans for the host's default, iOS on a Mac and Android
  // elsewhere. A broken `xcode-select` makes a Mac the machine that cannot build; on the other
  // runners the default is Android and the runner's own Android SDK decides, so this case says
  // nothing there [observed — tier0-linux and tier0-windows, 2026-09-09].
  it.skipIf(process.platform !== 'darwin')(
    'offers dev --eas as the next step, and says why in the plan',
    async () => {
      const projectRoot = await setupAsync('dev-client-app');
      await breakXcodeSelectAsync(projectRoot);

      const report = await reportInAsync(projectRoot);

      expect(report.next!.command).toBe(
        `npx @expo/agent-cli dev --ios --eas --port ${new URL(report.devServer!.url).port} --detach --wait-ready`
      );
      expect(report.next!.steps.map((step) => step.argv[0])).toContain('eas');
    }
  );
});
