// @ref llp/0004-smart-start-and-project-state.rfc.md §Reported by status
//
// The `installed` section of `status`, across the process boundary. A stub `adb` serves a
// fixture APK byte range by byte range, the way a device answers `exec-out dd`, and the stub
// `fingerprint` names the project's hash. The two agree, then they do not, then the app is not
// installed. `status` reports all three and still exits 0, because only `--assert` gates it.
import fs from 'node:fs';
import path from 'node:path';

import { killProcessTree } from '../../src/utils/processGroup';
import {
  collectOutput,
  executeAgentCliAsync,
  installStubFingerprintAsync,
  setupFixtureAsync,
  spawnAgentCli,
  startStubDevServerAsync,
  waitForAsync,
  waitForExitAsync,
} from '../utils';
import {
  EMBEDDED_HASH,
  EMULATOR_NAME,
  LEGACY_APK_FIXTURE,
  PHONE_NAME,
  PHONE_UDID,
  SIMULATOR_NAME,
  SIMULATOR_UDID,
  installStubAdbAsync,
  installStubXcrunAsync,
} from './installedAppStubs';

const ANDROID_APP_ID = 'com.example.installedapp';
const IOS_APP_ID = 'com.example.installedapp';

/**
 * The tier-0 harness turns devices off (`AGENT_CLI_NO_DEVICE`, @ref ../utils §spawnAgentCli). This
 * suite is about a device — a stub one — so it turns them back on.
 */
const WITH_DEVICES = { AGENT_CLI_NO_DEVICE: '0' };

/** The `adb` calls only the installed section makes; the `device` section lists devices on its own. */
function installedReads(calls: string[][]): string[][] {
  return calls.filter(
    (args) => args.includes('pm') || args[2] === 'exec-out' || args[2] === 'pull'
  );
}

async function setAppIdsAsync(projectRoot: string): Promise<void> {
  const appJsonPath = path.join(projectRoot, 'app.json');
  const appJson = JSON.parse(await fs.promises.readFile(appJsonPath, 'utf8'));
  appJson.expo.android = { package: ANDROID_APP_ID };
  appJson.expo.ios = { bundleIdentifier: IOS_APP_ID };
  appJson.expo.scheme = 'installedapp';
  await fs.promises.writeFile(appJsonPath, JSON.stringify(appJson, null, 2));
}

type Report = {
  installed: {
    outcome: string;
    platforms: { platform: string; [key: string]: unknown }[];
  } | null;
  errors: Record<string, string>;
};

function platformRow(report: Report, platform: string) {
  return report.installed?.platforms.find((entry) => entry.platform === platform);
}

describe('@expo/agent-cli status, the installed section', () => {
  let projectRoot: string;
  let adb: Awaited<ReturnType<typeof installStubAdbAsync>>;

  beforeEach(async () => {
    projectRoot = await setupFixtureAsync('dev-client-fresh-app');
    expect(await installStubFingerprintAsync(projectRoot)).toBe(true);
    await setAppIdsAsync(projectRoot);
    adb = await installStubAdbAsync(projectRoot, ANDROID_APP_ID);
    await installStubXcrunAsync(projectRoot);
  });

  it('reports up to date when the embedded hash is the project hash, reading the APK in ranges', async () => {
    const result = await executeAgentCliAsync(projectRoot, ['status', '--json'], {
      env: { ...WITH_DEVICES, ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH },
    });

    expect(result.exitCode).toBe(0);
    const report: Report = JSON.parse(result.stdout);
    // On macOS iOS is asked too and finds no booted simulator, which does not count while Android
    // answered.
    expect(report.installed?.outcome).toBe('up-to-date');
    expect(platformRow(report, 'android')).toMatchObject({
      status: 'up-to-date',
      reason: 'hash-match',
      installedHash: EMBEDDED_HASH,
      currentHash: EMBEDDED_HASH,
      deviceName: EMULATOR_NAME,
      commands: [],
    });

    const calls = adb.calls();
    expect(calls.some((args) => args.includes('pull'))).toBe(false);
    const ranged = calls.filter((args) => args[2] === 'exec-out');
    expect(ranged.length).toBeGreaterThan(0);
    expect(ranged[0]![3]).toMatch(
      /^dd if='\/data\/app\/.*base\.apk' bs=65536 skip=\d+ count=\d+ 2>\/dev\/null$/
    );
  });

  it('prints the rebuild command under the installed line when the hashes differ', async () => {
    const result = await executeAgentCliAsync(projectRoot, ['status'], {
      env: { ...WITH_DEVICES, ...adb.env, STUB_FINGERPRINT_HASH: 'something-else' },
    });

    // Still 0: the installed line reports, and only --assert turns status into a gate.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^installed\s+rebuild required/m);
    expect(result.stdout).toContain(`android: rebuild-required (${EMULATOR_NAME})`);
    expect(result.stdout).toContain('npx expo run:android');
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §What the answer is
  it('carries both hashes and the rebuild command in JSON when they differ', async () => {
    const result = await executeAgentCliAsync(projectRoot, ['status', '--json'], {
      env: { ...WITH_DEVICES, ...adb.env, STUB_FINGERPRINT_HASH: 'something-else' },
    });

    const report: Report = JSON.parse(result.stdout);
    expect(report.installed?.outcome).toBe('rebuild-required');
    expect(platformRow(report, 'android')).toMatchObject({
      status: 'rebuild-required',
      reason: 'hash-mismatch',
      installedHash: EMBEDDED_HASH,
      currentHash: 'something-else',
      commands: ['npx expo run:android'],
      recommendation: expect.stringContaining('Rebuild the app'),
    });
  });

  // A build whose file is not the JSON `expo-constants` writes: a release build, a build from
  // before the embed, or a rebundled one. The reader answers "no fingerprint", never an error.
  it('reports unknown with a rebuild when the installed app embeds no readable fingerprint', async () => {
    const result = await executeAgentCliAsync(projectRoot, ['status', '--json'], {
      env: {
        ...WITH_DEVICES,
        ...adb.env,
        STUB_FINGERPRINT_HASH: EMBEDDED_HASH,
        STUB_ADB_APK_FIXTURE: LEGACY_APK_FIXTURE,
      },
    });

    const report: Report = JSON.parse(result.stdout);
    expect(report.installed?.outcome).toBe('unknown');
    expect(platformRow(report, 'android')).toMatchObject({
      status: 'unknown',
      reason: 'no-embedded-fingerprint',
      commands: ['npx expo run:android'],
      recommendation: expect.stringContaining('release build'),
    });
  });

  // The embedded file names `@expo/fingerprint` 0.20.0; the project's copy is bumped, so the two
  // hashes differ for a reason that is not the project. No command: an agent must not rebuild for it.
  it('refuses to compare hashes from two fingerprint versions, and suggests no command', async () => {
    const manifestPath = path.join(
      projectRoot,
      'node_modules',
      '@expo',
      'fingerprint',
      'package.json'
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '0.21.0' }));

    const result = await executeAgentCliAsync(projectRoot, ['status', '--json'], {
      env: { ...WITH_DEVICES, ...adb.env, STUB_FINGERPRINT_HASH: 'something-else' },
    });

    const report: Report = JSON.parse(result.stdout);
    expect(report.installed?.outcome).toBe('unknown');
    expect(platformRow(report, 'android')).toMatchObject({
      status: 'unknown',
      reason: 'fingerprint-version-mismatch',
      commands: [],
      recommendation: expect.stringContaining('0.21.0'),
    });
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §What this cannot see
  // A CNG project's fingerprint hashes the inputs, not the generated directory, so a match over an
  // `android/` this CLI never built says to prebuild before trusting it. With the recorded build it
  // says nothing of the kind.
  describe('a generated native directory', () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(projectRoot, 'android'), { recursive: true });
      fs.appendFileSync(path.join(projectRoot, '.gitignore'), '\nandroid/\n');
    });

    it('warns to prebuild on a match when this CLI never built it', async () => {
      fs.rmSync(path.join(projectRoot, '.expo', 'agent-cli-last-build.json'));
      const result = await executeAgentCliAsync(projectRoot, ['status', '--json'], {
        env: { ...WITH_DEVICES, ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH },
      });

      const report: Report = JSON.parse(result.stdout);
      expect(platformRow(report, 'android')).toMatchObject({
        status: 'up-to-date',
        reason: 'hash-match',
        commands: [],
        recommendation: expect.stringContaining('npx @expo/agent-cli prebuild -p android'),
      });
    });

    it('keeps the plain match when the last build was recorded here', async () => {
      const result = await executeAgentCliAsync(projectRoot, ['status', '--json'], {
        env: { ...WITH_DEVICES, ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH },
      });

      const report: Report = JSON.parse(result.stdout);
      expect(platformRow(report, 'android')?.recommendation).toBe(
        'The installed app matches the project. A JS reload is enough.'
      );
    });
  });

  it('reports unknown when the app is not installed', async () => {
    const result = await executeAgentCliAsync(projectRoot, ['status', '--json'], {
      env: {
        ...WITH_DEVICES,
        ...adb.env,
        STUB_FINGERPRINT_HASH: EMBEDDED_HASH,
        STUB_ADB_INSTALLED: '0',
      },
    });

    expect(result.exitCode).toBe(0);
    const report: Report = JSON.parse(result.stdout);
    expect(report.installed?.outcome).toBe('unknown');
    expect(platformRow(report, 'android')).toMatchObject({
      status: 'unknown',
      reason: 'app-not-installed',
      commands: ['npx expo run:android'],
    });
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §How the file is read
  it('pulls the APK when the device cannot serve ranges, and reads the same answer', async () => {
    const result = await executeAgentCliAsync(projectRoot, ['status', '--json'], {
      env: {
        ...WITH_DEVICES,
        ...adb.env,
        STUB_FINGERPRINT_HASH: EMBEDDED_HASH,
        STUB_ADB_NO_DD: '1',
      },
    });

    const report: Report = JSON.parse(result.stdout);
    expect(platformRow(report, 'android')).toMatchObject({ reason: 'hash-match' });
    const calls = adb.calls();
    expect(calls.some((args) => args[2] === 'pull')).toBe(true);
    expect(calls.some((args) => args[2] === 'exec-out')).toBe(false);
  });

  // SDK 57 and earlier: that expo-constants has no build phase for the file, so no build carries it.
  it('says the app cannot be checked on an SDK that embeds no fingerprint, and reads no device', async () => {
    const manifestPath = path.join(projectRoot, 'node_modules', 'expo-constants', 'package.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ name: 'expo-constants', version: '57.0.19' }));
    const result = await executeAgentCliAsync(projectRoot, ['status', '--json'], {
      env: { ...WITH_DEVICES, ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH },
    });

    const report: Report = JSON.parse(result.stdout);
    expect(report.installed?.outcome).toBe('unknown');
    expect(platformRow(report, 'android')).toMatchObject({
      status: 'unknown',
      reason: 'embed-unsupported',
      commands: [],
      recommendation: expect.stringContaining('expo-constants 57.0.19 does not embed'),
    });
    expect(installedReads(adb.calls())).toEqual([]);
  });

  it('reads only the device --device names, by name', async () => {
    const result = await executeAgentCliAsync(
      projectRoot,
      ['status', '--json', '--device', EMULATOR_NAME],
      { env: { ...WITH_DEVICES, ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH } }
    );

    const report: Report = JSON.parse(result.stdout);
    expect(platformRow(report, 'android')).toMatchObject({
      reason: 'hash-match',
      deviceName: EMULATOR_NAME,
    });
  });

  it('answers no-device when --device names nothing this machine has, and reads no app', async () => {
    const result = await executeAgentCliAsync(
      projectRoot,
      ['status', '--json', '--device', 'Nobody'],
      { env: { ...WITH_DEVICES, ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH } }
    );

    const report: Report = JSON.parse(result.stdout);
    expect(report.installed?.outcome).toBe('unknown');
    expect(platformRow(report, 'android')).toMatchObject({
      reason: 'no-device',
      recommendation: expect.stringContaining('matched --device "Nobody"'),
    });
    expect(installedReads(adb.calls())).toEqual([]);
  });

  // The harness default, which every other status e2e runs under: a plain `status` on a developer's
  // Mac must not read that Mac's devices (llp/0002 §Tier 0).
  it('reads no device when the harness turned devices off', async () => {
    const result = await executeAgentCliAsync(projectRoot, ['status', '--json'], {
      env: { ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH },
    });

    const report: Report = JSON.parse(result.stdout);
    expect(report.installed).toBeNull();
    expect(installedReads(adb.calls())).toEqual([]);
  });

  it('stops a hanging adb read at the section deadline and keeps the rest of the report', async () => {
    const pidPath = path.join(projectRoot, '.hanging-adb-pid');
    const server = await startStubDevServerAsync({ projectRoot });
    const child = spawnAgentCli(projectRoot, ['status', '--json', '--dev-server-url', server.url], {
      env: {
        ...WITH_DEVICES,
        ...adb.env,
        STUB_FINGERPRINT_HASH: EMBEDDED_HASH,
        STUB_ADB_HANG_READ: pidPath,
      },
    });
    const output = collectOutput(child);
    const exited = waitForExitAsync(child, output);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      // The section's own deadline is 15s; the watchdog is only there so a leak cannot hang the
      // suite.
      const result = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(
            () => reject(new Error('status did not exit within its budget')),
            60_000
          );
        }),
      ]);
      expect(result.exitCode).toBe(0);
      const report: Report = JSON.parse(result.stdout);
      expect(report.installed).toBeNull();
      expect(report.errors.installed).toBe('The installed-app check did not finish within 15s.');
      expect(report).toMatchObject({
        project: { isExpoApp: true, usesDevClient: true },
        devServer: { running: true, ready: true, url: server.url },
      });

      // The hung `adb` is gone, and no fallback `pull` was started after the deadline.
      expect(fs.existsSync(pidPath)).toBe(true);
      const pid = Number(fs.readFileSync(pidPath, 'utf8'));
      expect(
        await waitForAsync(() => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH';
          }
        }, 5000)
      ).toBe(true);
      expect(adb.calls().filter((args) => args[2] === 'exec-out')).toHaveLength(1);
      expect(adb.calls().some((args) => args[2] === 'pull')).toBe(false);
    } finally {
      clearTimeout(watchdog);
      if (fs.existsSync(pidPath)) {
        try {
          process.kill(Number(fs.readFileSync(pidPath, 'utf8')), 'SIGKILL');
        } catch {
          // Already stopped by the deadline.
        }
      }
      if (child.exitCode === null && child.signalCode === null) {
        killProcessTree(child, 'SIGKILL');
      }
      await exited;
      await server.close();
    }
  }, 90_000);

  // iOS simulators are only looked for on macOS, so the simulator reader is exercised there.
  describe.skipIf(process.platform !== 'darwin')('with a booted simulator', () => {
    it('reads the fingerprint off the app container, and ranks both platforms', async () => {
      const xcrun = await installStubXcrunAsync(projectRoot, {
        booted: { fingerprint: EMBEDDED_HASH },
      });
      const result = await executeAgentCliAsync(projectRoot, ['status', '--json'], {
        env: { ...WITH_DEVICES, ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH },
      });

      const report: Report = JSON.parse(result.stdout);
      expect(report.installed?.outcome).toBe('up-to-date');
      expect(platformRow(report, 'ios')).toMatchObject({
        status: 'up-to-date',
        reason: 'hash-match',
        deviceName: SIMULATOR_NAME,
      });
      expect(xcrun.calls()).toContainEqual([
        'simctl',
        'get_app_container',
        SIMULATOR_UDID,
        IOS_APP_ID,
      ]);
    });

    it('reads --device as the one simulator to ask, by name', async () => {
      const xcrun = await installStubXcrunAsync(projectRoot, {
        booted: { fingerprint: 'stale-hash' },
      });
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--json', '--device', SIMULATOR_NAME],
        { env: { ...WITH_DEVICES, ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH } }
      );

      const report: Report = JSON.parse(result.stdout);
      // The emulator does not match the name, so Android has no device; the stale simulator decides.
      expect(report.installed?.outcome).toBe('rebuild-required');
      expect(platformRow(report, 'ios')).toMatchObject({ reason: 'hash-mismatch' });
      expect(platformRow(report, 'android')).toMatchObject({ reason: 'no-device' });
      expect(xcrun.calls().some((args) => args[1] === 'get_app_container')).toBe(true);
      expect(adb.calls().some((args) => args.includes('pm'))).toBe(false);
    });
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §How the file is read — iOS device
  describe.skipIf(process.platform !== 'darwin')('with a connected iPhone', () => {
    it('names the phone and leaves it alone when --device did not name it', async () => {
      const xcrun = await installStubXcrunAsync(projectRoot, {
        phone: { fingerprint: EMBEDDED_HASH },
      });
      const result = await executeAgentCliAsync(projectRoot, ['status', '--json'], {
        env: { ...WITH_DEVICES, ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH },
      });

      const report: Report = JSON.parse(result.stdout);
      expect(platformRow(report, 'ios')).toMatchObject({
        reason: 'no-device',
        recommendation: expect.stringContaining(
          `A physical iOS device is connected (${PHONE_NAME})`
        ),
      });
      expect(xcrun.calls().some((args) => args[3] === 'launch')).toBe(false);
    });

    it('launches the app on the named phone and reads what it posts back', async () => {
      const xcrun = await installStubXcrunAsync(projectRoot, {
        phone: { fingerprint: EMBEDDED_HASH },
      });
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--json', '--device', PHONE_NAME, '--device-timeout', '30'],
        { env: { ...WITH_DEVICES, ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH } }
      );

      const report: Report = JSON.parse(result.stdout);
      expect(report.installed?.outcome).toBe('up-to-date');
      expect(platformRow(report, 'ios')).toMatchObject({
        reason: 'hash-match',
        deviceName: PHONE_NAME,
        installedHash: EMBEDDED_HASH,
      });
      // The launch is said on stderr, so a `--json` run keeps stdout for the one object.
      expect(result.stderr).toContain(
        `Checking ${PHONE_NAME}. This launches the app on the device.`
      );
      const launch = xcrun.calls().find((args) => args[3] === 'launch');
      expect(launch).toEqual([
        'devicectl',
        'device',
        'process',
        'launch',
        '--payload-url',
        expect.stringMatching(/^installedapp:\/\/\?__expo_fingerprint_check=1&/),
        '--device',
        PHONE_UDID,
        IOS_APP_ID,
      ]);
    });

    it('reads a phone whose build embeds no fingerprint as unknown', async () => {
      await installStubXcrunAsync(projectRoot, { phone: { fingerprint: null } });
      const result = await executeAgentCliAsync(
        projectRoot,
        ['status', '--json', '--device', PHONE_NAME],
        { env: { ...WITH_DEVICES, ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH } }
      );

      const report: Report = JSON.parse(result.stdout);
      expect(platformRow(report, 'ios')).toMatchObject({
        status: 'unknown',
        reason: 'no-embedded-fingerprint',
        deviceName: PHONE_NAME,
      });
    });
  });
});

describe('@expo/agent-cli status --device', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await setupFixtureAsync('dev-client-fresh-app');
  });

  it.each([
    ['an empty --device', ['--device', '  '], /needs a simulator name/],
    ['a --device-timeout out of range', ['--device-timeout', '0'], /whole number of seconds/],
  ])('exits 1 on %s, with the JSON envelope', async (_case, args, message) => {
    const result = await executeAgentCliAsync(projectRoot, ['status', '--json', ...args], {
      reject: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(JSON.parse(result.stdout).error.code).toBe('BAD_ARGS');
  });
});
