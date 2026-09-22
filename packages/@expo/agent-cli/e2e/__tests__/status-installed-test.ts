// @ref llp/0004-smart-start-and-project-state.rfc.md §Reported by status
//
// The `installed` section of `status --explain`, across the process boundary. A stub `adb` serves a
// fixture APK byte range by byte range, the way a device answers `exec-out dd`, and the stub
// `fingerprint` names the project's hash. The two agree, then they do not, then the app is not
// installed. `status` reports all three and still exits 0, because only `--assert` gates it.
import fs from 'node:fs';
import path from 'node:path';

import { killProcessTree } from '../../src/utils/processGroup';
import {
  collectOutput,
  executeAgentCliAsync,
  installStubBinAsync,
  installStubFingerprintAsync,
  setupFixtureAsync,
  spawnAgentCli,
  startStubDevServerAsync,
  waitForAsync,
  waitForExitAsync,
} from '../utils';

const APK_FIXTURE = path.resolve(__dirname, '../../src/__fixtures__/zip/fixture-stored.zip');
/** The hash inside that archive's `assets/app.fingerprint`. */
const EMBEDDED_HASH = 'test-fingerprint-hash';
const ANDROID_APP_ID = 'com.example.installedapp';
const IOS_APP_ID = 'com.example.installedapp';
const SIMULATOR_UDID = 'E2E-SIM-0001';

/** The `adb` calls only the installed section makes; the `device` section lists devices on its own. */
function installedReads(calls: string[][]): string[][] {
  return calls.filter(
    (args) => args.includes('pm') || args[2] === 'exec-out' || args[2] === 'pull'
  );
}

/**
 * The tier-0 harness turns devices off (`AGENT_CLI_NO_DEVICE`, @ref ../utils §spawnAgentCli). This
 * suite is about a device — a stub one — so it turns them back on.
 */
const WITH_DEVICES = { AGENT_CLI_NO_DEVICE: '0' };

type StubCalls = () => string[][];

function readCalls(recordPath: string): string[][] {
  return fs.existsSync(recordPath)
    ? fs
        .readFileSync(recordPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

/**
 * A stub `adb` with one emulator that has the app installed, unless `STUB_ADB_INSTALLED=0`.
 *
 * `exec-out` receives the `dd` command as one argument, the way a device shell would, and the stub
 * slices the fixture APK on `skip=` and `count=`. `STUB_ADB_NO_DD=1` fails `stat`, the way a device
 * without the tools does, and `pull` then copies the fixture to the path asked for. Every argv is
 * recorded.
 */
async function installStubAdbAsync(
  projectRoot: string
): Promise<{ env: Record<string, string>; calls: StubCalls }> {
  const recordPath = path.join(projectRoot, '.adb-calls.jsonl');
  const scriptPath = path.join(projectRoot, '.stub-bin', 'adb-stub.js');
  await fs.promises.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.promises.writeFile(
    scriptPath,
    [
      `const fs = require('fs');`,
      `const args = process.argv.slice(2);`,
      `fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(args) + '\\n');`,
      `const apk = fs.readFileSync(${JSON.stringify(APK_FIXTURE)});`,
      `const installed = process.env.STUB_ADB_INSTALLED !== '0';`,
      `if (args[0] === 'devices') {`,
      `  process.stdout.write('List of devices attached\\nemulator-5554\\tdevice model:sdk_gphone64_arm64\\n');`,
      `  process.exit(0);`,
      `}`,
      `if (args.includes('emu')) { process.stdout.write('Pixel_9\\nOK\\n'); process.exit(0); }`,
      `if (args.includes('pm')) {`,
      `  if (!installed) { process.exit(1); }`,
      `  process.stdout.write('package:/data/app/~~abc==/${ANDROID_APP_ID}-def==/base.apk\\n');`,
      `  process.exit(0);`,
      `}`,
      `if (args.includes('stat')) {`,
      `  if (process.env.STUB_ADB_NO_DD) { process.stderr.write('stat: not found\\n'); process.exit(127); }`,
      `  process.stdout.write(apk.length + '\\n');`,
      `  process.exit(0);`,
      `}`,
      `if (args[2] === 'pull') { fs.writeFileSync(args[4], apk); process.exit(0); }`,
      `if (args[2] === 'exec-out' && process.env.STUB_ADB_HANG_READ) {`,
      `  fs.writeFileSync(process.env.STUB_ADB_HANG_READ, String(process.pid));`,
      `  setInterval(() => {}, 1000);`,
      `  return;`,
      `}`,
      `if (args[2] === 'exec-out') {`,
      `  const command = args[3];`,
      `  const skip = Number(/skip=(\\d+)/.exec(command)[1]);`,
      `  const count = Number(/count=(\\d+)/.exec(command)[1]);`,
      `  const bs = Number(/bs=(\\d+)/.exec(command)[1]);`,
      `  process.stdout.write(apk.subarray(skip * bs, (skip + count) * bs));`,
      `  process.exit(0);`,
      `}`,
      `process.stderr.write('stub adb: unexpected ' + args.join(' ') + '\\n');`,
      `process.exit(2);`,
    ].join('\n')
  );
  // ANDROID_HOME beats PATH, so a runner with a real SDK still reaches this stub
  // (@ref src/device/adb §resolveAdb).
  const sdk = path.join(projectRoot, '.stub-android-sdk');
  await installStubBinAsync(path.join(sdk, 'platform-tools'), 'adb', scriptPath);
  return { env: { ANDROID_HOME: sdk }, calls: () => readCalls(recordPath) };
}

/**
 * A stub `xcrun`. On macOS the iOS reader asks `simctl` for booted simulators, and a test must not
 * meet the ones this Mac happens to have. Without `booted`, none are; with it, one whose app
 * container holds the given fingerprint at the static-linking path. `.stub-bin` is first on the
 * `PATH` of every run (@ref ../utils §stubExpoEnv), which is where `xcrun` is looked up.
 */
async function installStubXcrunAsync(
  projectRoot: string,
  { booted }: { booted?: { fingerprint: string } } = {}
): Promise<{ calls: StubCalls }> {
  const recordPath = path.join(projectRoot, '.xcrun-calls.jsonl');
  const container = path.join(projectRoot, '.stub-simulator', 'installedapp.app');
  if (booted) {
    await fs.promises.mkdir(path.join(container, 'EXConstants.bundle'), { recursive: true });
    await fs.promises.writeFile(
      path.join(container, 'EXConstants.bundle', 'app.fingerprint'),
      JSON.stringify({ hash: booted.fingerprint, fingerprintVersion: '0.20.0', sources: [] })
    );
  }
  const devices = booted
    ? {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
          { udid: SIMULATOR_UDID, name: 'iPhone 17 Pro', state: 'Booted' },
        ],
      }
    : {};
  const scriptPath = path.join(projectRoot, '.stub-bin', 'xcrun-stub.js');
  await fs.promises.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.promises.writeFile(
    scriptPath,
    [
      `const fs = require('fs');`,
      `const args = process.argv.slice(2);`,
      `fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(args) + '\\n');`,
      `if (args[1] === 'list') {`,
      `  process.stdout.write(JSON.stringify({ devices: ${JSON.stringify(devices)} }));`,
      `  process.exit(0);`,
      `}`,
      `if (args[1] === 'get_app_container') {`,
      `  process.stdout.write(${JSON.stringify(container)} + '\\n');`,
      `  process.exit(0);`,
      `}`,
      `process.stderr.write('stub xcrun: unexpected ' + args.join(' ') + '\\n');`,
      `process.exit(2);`,
    ].join('\n')
  );
  await installStubBinAsync(path.join(projectRoot, '.stub-bin'), 'xcrun', scriptPath);
  return { calls: () => readCalls(recordPath) };
}

async function setAppIdsAsync(projectRoot: string): Promise<void> {
  const appJsonPath = path.join(projectRoot, 'app.json');
  const appJson = JSON.parse(await fs.promises.readFile(appJsonPath, 'utf8'));
  appJson.expo.android = { package: ANDROID_APP_ID };
  appJson.expo.ios = { bundleIdentifier: IOS_APP_ID };
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

describe('@expo/agent-cli status --explain, the installed section', () => {
  let projectRoot: string;
  let adb: Awaited<ReturnType<typeof installStubAdbAsync>>;

  beforeEach(async () => {
    projectRoot = await setupFixtureAsync('dev-client-fresh-app');
    expect(await installStubFingerprintAsync(projectRoot)).toBe(true);
    await setAppIdsAsync(projectRoot);
    adb = await installStubAdbAsync(projectRoot);
    await installStubXcrunAsync(projectRoot);
  });

  it('reports up to date when the embedded hash is the project hash, reading the APK in ranges', async () => {
    const result = await executeAgentCliAsync(projectRoot, ['status', '--explain', '--json'], {
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
      deviceName: 'Pixel_9',
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
    const result = await executeAgentCliAsync(projectRoot, ['status', '--explain'], {
      env: { ...WITH_DEVICES, ...adb.env, STUB_FINGERPRINT_HASH: 'something-else' },
    });

    // Still 0: the installed line reports, and only --assert turns status into a gate.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^installed\s+rebuild required/m);
    expect(result.stdout).toContain('android: rebuild-required (Pixel_9)');
    expect(result.stdout).toContain('npx expo run:android');
  });

  it('reports unknown when the app is not installed', async () => {
    const result = await executeAgentCliAsync(projectRoot, ['status', '--explain', '--json'], {
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
    const result = await executeAgentCliAsync(projectRoot, ['status', '--explain', '--json'], {
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

  it('reads no device without --explain', async () => {
    const result = await executeAgentCliAsync(projectRoot, ['status', '--json'], {
      env: { ...WITH_DEVICES, ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH },
    });

    const report: Report = JSON.parse(result.stdout);
    expect(report.installed).toBeNull();
    expect(report.errors.installed).toBeUndefined();
    expect(installedReads(adb.calls())).toEqual([]);
  });

  // The harness default, which every other status e2e runs under: a `--explain` on a developer's
  // Mac must not read that Mac's devices (llp/0002 §Tier 0).
  it('reads no device when the harness turned devices off', async () => {
    const result = await executeAgentCliAsync(projectRoot, ['status', '--explain', '--json'], {
      env: { ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH },
    });

    const report: Report = JSON.parse(result.stdout);
    expect(report.installed).toBeNull();
    expect(installedReads(adb.calls())).toEqual([]);
  });

  it('stops a hanging adb read at the section deadline and keeps the rest of the report', async () => {
    const pidPath = path.join(projectRoot, '.hanging-adb-pid');
    const server = await startStubDevServerAsync({ projectRoot });
    const child = spawnAgentCli(
      projectRoot,
      ['status', '--explain', '--json', '--dev-server-url', server.url],
      {
        env: {
          ...WITH_DEVICES,
          ...adb.env,
          STUB_FINGERPRINT_HASH: EMBEDDED_HASH,
          STUB_ADB_HANG_READ: pidPath,
        },
      }
    );
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
      const result = await executeAgentCliAsync(projectRoot, ['status', '--explain', '--json'], {
        env: { ...WITH_DEVICES, ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH },
      });

      const report: Report = JSON.parse(result.stdout);
      expect(report.installed?.outcome).toBe('up-to-date');
      expect(platformRow(report, 'ios')).toMatchObject({
        status: 'up-to-date',
        reason: 'hash-match',
        deviceName: 'iPhone 17 Pro',
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
        ['status', '--explain', '--json', '--device', 'iPhone 17 Pro'],
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
});

describe('@expo/agent-cli status --device', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await setupFixtureAsync('dev-client-fresh-app');
  });

  it.each([
    ['--device without --explain', ['--device', 'iPhone 17'], /--device needs --explain/],
    ['an empty --device', ['--explain', '--device', '  '], /needs a simulator name/],
  ])('exits 1 on %s, with the JSON envelope', async (_case, args, message) => {
    const result = await executeAgentCliAsync(projectRoot, ['status', '--json', ...args], {
      reject: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(JSON.parse(result.stdout).error.code).toBe('BAD_ARGS');
  });
});
