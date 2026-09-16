// @ref llp/0028-installed-app-check.rfc.md §Proof
//
// The `installed` section of `status --explain`, across the process boundary: a stub `adb` serves a
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
/** The `assets/app.fingerprint` entry of that archive. */
const EMBEDDED_HASH = 'test-fingerprint-hash';
const APP_ID = 'com.example.installedapp';

/**
 * A stub `adb` with one emulator that has the app installed, unless `STUB_ADB_INSTALLED=0`.
 *
 * `exec-out` receives the `dd` command as one argument, the way a device shell would, and the
 * stub slices the fixture APK on `skip=` and `count=`. Every argv is recorded.
 */
async function installStubAdbAsync(projectRoot: string): Promise<{
  env: Record<string, string>;
  calls: () => string[][];
}> {
  const recordPath = path.join(projectRoot, '.adb-calls.jsonl');
  const scriptPath = path.join(projectRoot, '.stub-bin', 'adb-installed-app-stub.js');
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
      `  process.stdout.write('package:/data/app/~~abc==/${APP_ID}-def==/base.apk\\n');`,
      `  process.exit(0);`,
      `}`,
      `if (args.includes('stat')) { process.stdout.write(apk.length + '\\n'); process.exit(0); }`,
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
  return {
    env: { ANDROID_HOME: sdk },
    calls: () =>
      fs.existsSync(recordPath)
        ? fs
            .readFileSync(recordPath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
  };
}

describe('npx @expo/agent-cli status --explain, installed section', () => {
  let projectRoot: string;
  let adb: Awaited<ReturnType<typeof installStubAdbAsync>>;

  beforeEach(async () => {
    projectRoot = await setupFixtureAsync('dev-client-fresh-app');
    expect(await installStubFingerprintAsync(projectRoot)).toBe(true);
    const appJsonPath = path.join(projectRoot, 'app.json');
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    appJson.expo.android = { package: APP_ID };
    fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2));
    adb = await installStubAdbAsync(projectRoot);
  });

  it('reports up to date when the embedded hash is the project hash, reading the APK in ranges', async () => {
    const result = await executeAgentCliAsync(
      projectRoot,
      ['status', '--explain', '--json'],
      {
        env: { ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH },
      }
    );

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    // On macOS both platforms are asked; this fixture names no iOS bundle id, so only Android
    // produces a verdict and it is the one the outcome comes from.
    expect(report.installed.outcome).toBe('up-to-date');
    expect(
      report.installed.platforms.find((entry: { platform: string }) => entry.platform === 'android')
    ).toMatchObject({
      platform: 'android',
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

  it('prints the rebuild command on the installed line when the hashes differ', async () => {
    const result = await executeAgentCliAsync(projectRoot, ['status', '--explain'], {
      env: { ...adb.env, STUB_FINGERPRINT_HASH: 'something-else' },
      reject: false,
    });

    // Still 0: the installed line reports, and only --assert turns status into a gate.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('installed');
    expect(result.stdout).toContain('rebuild required');
    expect(result.stdout).toContain('android: rebuild-required (Pixel_9)');
    expect(result.stdout).toContain('npx expo run:android');
  });

  it('checks the installed app without --explain', async () => {
    const result = await executeAgentCliAsync(projectRoot, ['status', '--json'], {
      env: { ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH },
    });

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.installed.outcome).toBe('up-to-date');
    expect(adb.calls().some((args) => args.includes('exec-out'))).toBe(true);
  });

  it.each([
    { explain: false, json: true },
    { explain: false, json: false },
    { explain: true, json: true },
  ])('stops a hanging adb read (explain=$explain, json=$json)', async ({ explain, json }) => {
    const pidPath = path.join(projectRoot, '.hanging-adb-pid');
    const server = await startStubDevServerAsync({ projectRoot });
    const child = spawnAgentCli(
      projectRoot,
      [
        'status',
        ...(explain ? ['--explain'] : []),
        ...(json ? ['--json'] : []),
        '--dev-server-url',
        server.url,
      ],
      { env: { ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH, STUB_ADB_HANG_READ: pidPath } }
    );
    const output = collectOutput(child);
    const exited = waitForExitAsync(child, output);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      // Allow cold Windows startup, but do not let a leaked subprocess hang the suite.
      const result = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(
            () => reject(new Error('status did not exit within its budget')),
            explain ? 45_000 : 10_000
          );
        }),
      ]);
      expect(result.exitCode).toBe(0);
      if (json) {
        const report = JSON.parse(result.stdout);
        expect(report.installed).toBeNull();
        expect(report.errors.installed).toBe(explain
          ? 'Installed-app check timed out after 15000ms.'
          : 'Not checked within 2000ms. Run "npx @expo/agent-cli status --explain" for a longer check.');
        expect(report.project).toMatchObject({ isExpoApp: true, usesDevClient: true });
        expect(report.devServer).toMatchObject({ running: true, ready: true, url: server.url });
        expect(report.skills).not.toBeNull();
      } else {
        expect(result.stdout).toContain('installed');
        expect(result.stdout).toContain('Not checked within 2000ms');
        expect(result.stdout).toContain('"npx @expo/agent-cli status --explain" for a longer check.');
      }
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
      expect(adb.calls().some((args) => args.includes('pull'))).toBe(false);
    } finally {
      clearTimeout(watchdog);
      // The adb reader owns a separate process group, so cleanup must stop it too
      // if the cancellation being tested regresses.
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
  }, 60_000);

  it('reports unknown when the app is not installed', async () => {
    const result = await executeAgentCliAsync(
      projectRoot,
      ['status', '--explain', '--json'],
      {
        env: { ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH, STUB_ADB_INSTALLED: '0' },
        reject: false,
      }
    );

    expect(result.exitCode).toBe(0);
    const installed = JSON.parse(result.stdout).installed;
    expect(installed.outcome).toBe('unknown');
    expect(
      installed.platforms.find((entry: { platform: string }) => entry.platform === 'android')
    ).toMatchObject({
      status: 'unknown',
      reason: 'app-not-installed',
      commands: ['npx expo run:android'],
    });
  });
});

describe('npx @expo/agent-cli status --device', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await setupFixtureAsync('dev-client-fresh-app');
  });

  // The probe launches the app on a phone, so naming one is the consent for that, and a default
  // report uses a short budget; selecting a device requires --explain and its longer budget.
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
