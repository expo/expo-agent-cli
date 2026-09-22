// @ref llp/0005-runtime-loop-tools.rfc.md §Installed-app fingerprint check
//
// Stub device tools for the installed-app check, shared by the reader e2e and the `status` e2e.
// Each stub is a Node script behind a shim (@ref ../utils §installStubBinAsync), so the protocol
// crosses a real process boundary: the argv the reader spells, the bytes the tool writes back, and
// the shims a Windows runner needs. Every invocation is recorded as one JSON line.
import fs from 'node:fs';
import path from 'node:path';

import { installStubBinAsync } from '../utils';

export const APK_FIXTURE = path.resolve(__dirname, '../../src/__fixtures__/zip/fixture-stored.zip');
export const DEVICECTL_FIXTURE = path.resolve(
  __dirname,
  '../../src/__fixtures__/devicectl/list.json'
);
/** The hash inside the fixture archive's `assets/app.fingerprint`. */
export const EMBEDDED_HASH = 'test-fingerprint-hash';

export const EMULATOR_SERIAL = 'emulator-5554';
export const EMULATOR_NAME = 'Pixel_9';
export const SIMULATOR_UDID = 'E2E-SIM-0001';
export const SIMULATOR_NAME = 'iPhone 17 Pro';
/** The reachable phone in the `devicectl` fixture, with Developer Mode on. */
export const PHONE_NAME = "Ada's iPhone";
export const PHONE_UDID = '00001110-001111110110101A';

export type StubCalls = () => string[][];

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
 * A stub `adb` with one emulator that has `appId` installed, unless `STUB_ADB_INSTALLED=0`.
 *
 * `exec-out` receives the `dd` command as one argument, the way a device shell would, and the stub
 * slices the fixture APK on `skip=` and `count=`. `STUB_ADB_NO_DD=1` fails `stat`, the way a device
 * without the tools does, and `pull` then copies the fixture to the path asked for.
 * `STUB_ADB_HANG_READ=<file>` makes `exec-out` write its pid there and never exit.
 *
 * Installed under a fake SDK: `ANDROID_HOME` beats `PATH`, so a runner with a real SDK still
 * reaches this stub (@ref src/device/adb §resolveAdb). The returned `env` names it.
 */
export async function installStubAdbAsync(
  root: string,
  appId: string
): Promise<{ env: Record<string, string>; calls: StubCalls }> {
  const recordPath = path.join(root, '.adb-calls.jsonl');
  const scriptPath = path.join(root, '.stub-bin', 'adb-stub.js');
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
      `  process.stdout.write('List of devices attached\\n${EMULATOR_SERIAL}\\tdevice model:sdk_gphone64_arm64\\n');`,
      `  process.exit(0);`,
      `}`,
      `if (args.includes('emu')) { process.stdout.write('${EMULATOR_NAME}\\nOK\\n'); process.exit(0); }`,
      `if (args.includes('pm')) {`,
      `  if (!installed) { process.exit(1); }`,
      `  process.stdout.write('package:/data/app/~~abc==/${appId}-def==/base.apk\\n');`,
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
  const sdk = path.join(root, '.stub-android-sdk');
  await installStubBinAsync(path.join(sdk, 'platform-tools'), 'adb', scriptPath);
  return { env: { ANDROID_HOME: sdk }, calls: () => readCalls(recordPath) };
}

/**
 * A stub `xcrun`, installed into `<root>/.stub-bin`, which has to be first on the `PATH` of the
 * process that spawns it.
 *
 * `simctl list devices booted` answers with one booted simulator when `booted` is given, whose app
 * container holds `booted.fingerprint` at the static-linking path; otherwise none. `devicectl list`
 * answers with the fixture phones when `phone` is given; a `launch` then answers the way the
 * dev-launcher responder does, posting `phone.fingerprint` to the callback URL carried by the
 * payload URL.
 */
export async function installStubXcrunAsync(
  root: string,
  {
    booted,
    phone,
  }: { booted?: { fingerprint: string }; phone?: { fingerprint: string | null } } = {}
): Promise<{ binDir: string; calls: StubCalls }> {
  const recordPath = path.join(root, '.xcrun-calls.jsonl');
  const container = path.join(root, '.stub-simulator', 'installedapp.app');
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
          { udid: SIMULATOR_UDID, name: SIMULATOR_NAME, state: 'Booted' },
        ],
      }
    : {};
  const binDir = path.join(root, '.stub-bin');
  const scriptPath = path.join(binDir, 'xcrun-stub.js');
  await fs.promises.mkdir(binDir, { recursive: true });
  await fs.promises.writeFile(
    scriptPath,
    [
      `const fs = require('fs');`,
      `const args = process.argv.slice(2);`,
      `fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(args) + '\\n');`,
      `if (args[0] === 'simctl' && args[1] === 'list') {`,
      `  process.stdout.write(JSON.stringify({ devices: ${JSON.stringify(devices)} }));`,
      `  process.exit(0);`,
      `}`,
      `if (args[1] === 'get_app_container') {`,
      `  process.stdout.write(${JSON.stringify(container)} + '\\n');`,
      `  process.exit(0);`,
      `}`,
      `if (args[0] === 'devicectl' && args[1] === 'list') {`,
      `  const phones = ${phone ? `fs.readFileSync(${JSON.stringify(DEVICECTL_FIXTURE)}, 'utf8')` : `'{"result":{"devices":[]}}'`};`,
      `  fs.writeFileSync(args[args.indexOf('--json-output') + 1], phones);`,
      `  process.exit(0);`,
      `}`,
      `if (args[0] === 'devicectl' && args[2] === 'process' && args[3] === 'launch') {`,
      `  const url = new URL(args[args.indexOf('--payload-url') + 1]);`,
      `  const callback = url.searchParams.get('__expo_fingerprint_callback');`,
      `  const body = JSON.stringify({ nonce: url.searchParams.get('__expo_fingerprint_nonce'), fingerprint: ${JSON.stringify(phone?.fingerprint ?? null)}, fingerprintVersion: '0.20.0' });`,
      `  const request = require('http').request(callback, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (response) => { response.resume(); response.on('end', () => process.exit(0)); });`,
      `  request.on('error', (error) => { process.stderr.write(String(error)); process.exit(1); });`,
      `  request.end(body);`,
      `  return;`,
      `}`,
      `process.stderr.write('stub xcrun: unexpected ' + args.join(' ') + '\\n');`,
      `process.exit(2);`,
    ].join('\n')
  );
  await installStubBinAsync(binDir, 'xcrun', scriptPath);
  return { binDir, calls: () => readCalls(recordPath) };
}
