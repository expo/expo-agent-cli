// @ref llp/0005-runtime-loop-tools.rfc.md §The Expo Go on the device is not the Expo Go the SDK wants
//
// `smoke` and the Expo Go already on the device: what it installs, replaces or leaves alone. Helpers
// are in `smokeFixtures.ts`; the rest of the `smoke` e2e cases are in `smoke-test.ts`.
import fs from 'node:fs';
import path from 'node:path';

import { executeAgentCliAsync, setupFixtureAsync, stubExpoEnv, holdLockForAsync } from '../utils';
import { startStubDevServerAsync, type StubDevServer } from '../stubDevServer';
import { simulatorDeviceDir } from '../../src/device/installedApps';
import {
  bindingFixture,
  installStubXcrunAsync as installStatefulXcrunAsync,
} from './installedAppStubs';
import { installStubAdbForExpoGoAsync, installStubNpxAsync } from './smokeFixtures';

describe('@expo/agent-cli smoke', () => {
  // @ref llp/0005-runtime-loop-tools.rfc.md §The Expo Go on the device is not the Expo Go the SDK wants
  //
  // A development build is the app of a `native-build` project, so the Expo Go beside it is not part
  // of the install decision: a device that holds the build installs nothing.
  describe('a stale Expo Go beside an installed development build', () => {
    async function devBuildFixtureAsync(): Promise<string> {
      const projectRoot = await setupFixtureAsync('dev-client-fresh-app');
      const configPath = path.join(projectRoot, 'app.json');
      const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      config.expo.android = { package: 'com.example.devclientfreshapp' };
      config.expo.ios = { bundleIdentifier: 'com.example.devclientfreshapp' };
      await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
      return projectRoot;
    }

    it('builds nothing for Android', async () => {
      const projectRoot = await devBuildFixtureAsync();
      const adb = await installStubAdbForExpoGoAsync(projectRoot, '54.0.8');
      const readNpx = await installStubNpxAsync(projectRoot);
      const stub = await startStubDevServerAsync({ projectRoot, targets: [] });
      const release = await holdLockForAsync(projectRoot, stub);

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['smoke', '--android', '--json', '--no-screenshot', '--timeout', '4s'],
          { env: { ...stubExpoEnv(projectRoot), ...adb.env }, reject: false }
        );
        const report = JSON.parse(result.stdout);

        expect(readNpx().some((argv) => argv.includes('run:android'))).toBe(false);
        expect(report.phases.some((entry: any) => entry.id === 'install-app')).toBe(false);
      } finally {
        await release();
        await stub.close();
      }
    });

    it.skipIf(process.platform !== 'darwin')('builds nothing for iOS', async () => {
      const projectRoot = await devBuildFixtureAsync();
      await installStatefulXcrunAsync(projectRoot, {
        simulators: [{ udid: 'E2E-BOOTED', name: 'dogfood-explicit', state: 'Booted' }],
      });
      await bindingFixture(projectRoot, 'E2E-BOOTED', 'dogfood-explicit');
      const home = path.join(projectRoot, '.stub-home');
      const apps = path.join(
        simulatorDeviceDir('E2E-BOOTED', { homedir: home }),
        'data/Containers/Bundle/Application'
      );
      const installs = [
        { dir: 'dev', id: 'com.example.devclientfreshapp', version: '1.0.0' },
        { dir: 'go', id: 'host.exp.Exponent', version: '54.0.8' },
      ];
      for (const { dir, id, version } of installs) {
        const bundle = path.join(apps, dir, 'App.app');
        await fs.promises.mkdir(bundle, { recursive: true });
        await fs.promises.writeFile(
          path.join(bundle, 'Info.plist'),
          '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
            `<key>CFBundleIdentifier</key><string>${id}</string>` +
            `<key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`
        );
      }
      const readNpx = await installStubNpxAsync(projectRoot);
      const stub = await startStubDevServerAsync({ projectRoot, targets: [] });
      const release = await holdLockForAsync(projectRoot, stub);

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['smoke', '--ios', '--json', '--no-screenshot', '--timeout', '4s'],
          {
            env: { ...stubExpoEnv(projectRoot), AGENT_CLI_NO_DEVICE: '0', HOME: home },
            reject: false,
          }
        );
        const report = JSON.parse(result.stdout);

        expect(readNpx().some((argv) => argv.includes('run:ios'))).toBe(false);
        expect(report.phases.some((entry: any) => entry.id === 'install-app')).toBe(false);
      } finally {
        await release();
        await stub.close();
      }
    });
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §The Expo Go on the device is not the Expo Go the SDK wants
  // @ref llp/0005-runtime-loop-tools.rfc.md §Android
  //
  // The Android half of the version check, which did not exist. `checkExpoGoVersionAsync` only ever
  // read a *simulator's* `Info.plist` through `plutil`, so `smoke --android` against an emulator
  // holding an Expo Go from another SDK compared nothing and reported `unknown` — a verdict that
  // says nothing and blocks nothing [confirmed, Kudo, 2026-09-03].
  //
  // This tier owns the argv, which is the whole question here: which `adb` commands the run reached
  // for, and what it did with what they said.
  describe('the Expo Go on an Android device', () => {
    /** A bootstrapping run against a stub dev server nothing is attached to. */
    async function runAndroidAsync(
      projectRoot: string,
      env: Record<string, string>,
      stub: StubDevServer
    ): Promise<Record<string, any>> {
      const release = await holdLockForAsync(projectRoot, stub);
      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['smoke', '--android', '--json', '--no-screenshot', '--timeout', '4s'],
          { env: { ...stubExpoEnv(projectRoot), ...env }, reject: false }
        );
        return JSON.parse(result.stdout);
      } finally {
        await release();
      }
    }

    it('replaces an Expo Go built from another SDK, and says what it replaced', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      // The fixture is on SDK 57, so 54.0.8 on the device is another release line.
      const adb = await installStubAdbForExpoGoAsync(projectRoot, '54.0.8');
      const readNpx = await installStubNpxAsync(projectRoot);
      const stub = await startStubDevServerAsync({ projectRoot, targets: [] });

      try {
        const report = await runAndroidAsync(projectRoot, adb.env, stub);

        // It asked the device's package manager, rather than reading a CoreSimulator tree that on
        // this platform is not there to read (@ref src/device/androidApps).
        expect(adb.read().some((argv) => argv.includes('dumpsys'))).toBe(true);
        // Then it downloaded the release *this project's SDK* ships, and installed it with the two
        // flags that make a replacement work: `-r` to keep the data, `-d` to allow a downgrade.
        expect(
          readNpx().some((argv) => argv.includes('download') && argv.includes('android'))
        ).toBe(true);
        const install = adb.read().find((argv) => argv.includes('install'))!;
        expect(install).toContain('-r');
        expect(install).toContain('-d');

        const phase = report.phases.find((entry: any) => entry.id === 'install-app');
        expect(phase).toMatchObject({ status: 'ok' });
        // An addition and a replacement are different things to do to somebody's machine, so the
        // row says which (llp/0021 §The rules).
        expect(phase.reason).toContain('replacing 54.0.8');
      } finally {
        await stub.close();
      }
    });

    // The other half of the same check, and the one that keeps it from being a tax: an emulator
    // already holding the right release pays for one `adb` call and no download at all.
    it('installs nothing when the Expo Go on the device is the one this SDK ships', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      const adb = await installStubAdbForExpoGoAsync(projectRoot, '57.0.9');
      const readNpx = await installStubNpxAsync(projectRoot);
      const stub = await startStubDevServerAsync({ projectRoot, targets: [] });

      try {
        const report = await runAndroidAsync(projectRoot, adb.env, stub);

        expect(readNpx().some((argv) => argv.includes('download'))).toBe(false);
        expect(adb.read().some((argv) => argv.includes('install'))).toBe(false);
        // Not `skipped`: a machine that already had the app never had an install to do, and a
        // skipped row reads as work that was owed (@ref src/smoke/walk/walk §CONDITIONAL_PHASES).
        expect(report.phases.some((entry: any) => entry.id === 'install-app')).toBe(false);
      } finally {
        await stub.close();
      }
    });

    // @ref src/smoke/contract §SmokeDeps.explainSilentApp
    //
    // Found live and at full price: an emulator on Expo Go 54.0.8, a project on SDK 57, and 119
    // seconds spent to report `no app had attached when the budget ran out` — while the reason was
    // on the device the whole time [observed — emulator-5554, 2026-09-04]. A stale Expo Go takes
    // the link, fails to load a bundle it cannot run, and registers no debugger target, which is
    // exactly what the wait is waiting for.
    //
    // `--no-start` is the run that reaches it: a run allowed to install has already fixed it.
    it('names the stale Expo Go when nothing attaches, rather than only the wait', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      const adb = await installStubAdbForExpoGoAsync(projectRoot, '54.0.8');
      await installStubNpxAsync(projectRoot);
      const stub = await startStubDevServerAsync({ projectRoot, targets: [] });
      const release = await holdLockForAsync(projectRoot, stub);

      try {
        const result = await executeAgentCliAsync(
          projectRoot,
          ['smoke', '--android', '--json', '--no-start', '--no-screenshot', '--timeout', '4s'],
          { env: { ...stubExpoEnv(projectRoot), ...adb.env }, reject: false }
        );
        const report = JSON.parse(result.stdout);

        const app = report.phases.find((entry: any) => entry.id === 'app');
        // Both facts: the open succeeded and nothing came of it, and the device says why.
        expect(app.reason).toContain('no app had attached');
        expect(app.reason).toContain('54.0.8');
        // And as a value, so the follow-up below is picked rather than matched out of English.
        expect(report.appMismatchKind).toBe('expo-go-version');
        // The follow-up is the run that installs the right release — not `navigate`, which would
        // fail identically for ever, and not a native build, which this project does not need.
        const commands = report.followups.map((followup: any) => followup.command);
        expect(commands[0]).toBe('npx @expo/agent-cli smoke --android');
        expect(commands.join(' ')).not.toContain('dev --android');
      } finally {
        await release();
        await stub.close();
      }
    });
  });
});
