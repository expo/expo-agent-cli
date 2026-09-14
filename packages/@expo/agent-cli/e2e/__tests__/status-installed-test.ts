// @ref llp/0028-installed-app-check.rfc.md §Proof
//
// The `installed` section of `status --explain`, across the process boundary: a stub `adb` serves a
// fixture APK byte range by byte range, the way a device answers `exec-out dd`, and the stub
// `fingerprint` names the project's hash. The two agree, then they do not, then the app is not
// installed. `status` reports all three and still exits 0, because only `--assert` gates it.
import fs from 'node:fs';
import path from 'node:path';

import {
  executeAgentCliAsync,
  installStubBinAsync,
  installStubFingerprintAsync,
  setupFixtureAsync,
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

  it('reads no device without --explain', async () => {
    const result = await executeAgentCliAsync(projectRoot, ['status', '--json'], {
      env: { ...adb.env, STUB_FINGERPRINT_HASH: EMBEDDED_HASH },
    });

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    // The key is always present; the value says nothing was asked.
    expect(report).toHaveProperty('installed', null);
    expect(adb.calls().some((args) => args.includes('exec-out'))).toBe(false);
  });

  // @ref llp/0028-installed-app-check.rfc.md §The prebuild marker
  // The marker is this CLI's file, so the test plants it the way the writer writes it.
  it('puts prebuild first when the app config moved since the marker', async () => {
    fs.mkdirSync(path.join(projectRoot, 'android'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.expo', 'prebuild'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.expo', 'prebuild', 'fingerprint-android.json'),
      JSON.stringify({
        version: 1,
        platform: 'android',
        hash: 'marker-hash',
        fingerprintVersion: '0.20.0',
        createdAt: '2026-09-09T00:00:00Z',
        sources: [{ type: 'file', filePath: 'app.json', reasons: ['expoConfig'], hash: 'old' }],
      })
    );

    const result = await executeAgentCliAsync(
      projectRoot,
      ['status', '--explain', '--json'],
      {
        env: { ...adb.env, STUB_FINGERPRINT_HASH_FROM_PROJECT: '1' },
        reject: false,
      }
    );

    expect(result.exitCode).toBe(0);
    const android = JSON.parse(result.stdout).installed.platforms.find(
      (entry: { platform: string }) => entry.platform === 'android'
    );
    expect(android).toMatchObject({
      status: 'rebuild-required',
      reason: 'prebuild-stale',
      commands: ['npx @expo/agent-cli prebuild -p android', 'npx expo run:android'],
      recommendation: expect.stringContaining('app.json changed after the native directories'),
    });
  });

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
  // report reads no device at all — which is why the flag is refused without --explain.
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
