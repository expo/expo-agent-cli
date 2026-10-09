// @ref llp/0005-runtime-loop-tools.rfc.md §Installed-app fingerprint check
//
// Stub device tools for the installed-app check, shared by the reader e2e and the `status` e2e.
// Each stub is a Node script behind a shim (@ref ../utils §installStubBinAsync), so the protocol
// crosses a real process boundary: the argv the reader spells, the bytes the tool writes back, and
// the shims a Windows runner needs. Every invocation is recorded as one JSON line.
import fs from 'node:fs';
import path from 'node:path';

import { digestOf } from '../../src/devLock/address';
import { canonicalizeExistingPath } from '../../src/utils/dir';
import { installStubBinAsync } from '../utils';

export const APK_FIXTURE = path.resolve(__dirname, '../../src/__fixtures__/zip/fixture-stored.zip');
/** An archive whose `app.fingerprint` is not the JSON `expo-constants` writes: a pre-JSON build. */
export const LEGACY_APK_FIXTURE = path.resolve(
  __dirname,
  '../../src/__fixtures__/zip/fixture-deflated.zip'
);
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
/** One booted simulator, for `installStubXcrunAsync`'s `simulators`. */
export const BOOTED_SIMULATOR = {
  udid: SIMULATOR_UDID,
  name: SIMULATOR_NAME,
  state: 'Booted',
} as const;
/** The reachable phone in the `devicectl` fixture, with Developer Mode on. */
export const PHONE_NAME = "Ada's iPhone";
export const PHONE_UDID = '00001110-001111110110101A';

export type StubCalls = () => string[][];

/**
 * Bind `udid` to the fixture worktree in the registry the harness's Expo home holds
 * (`<projectRoot>.expo-home`, @ref ../utils §spawnAgentCli), as `dev` would have: `created`, the
 * lease 60 min ahead, the canonical root. Every verb of the fixture then drives this simulator
 * (llp/0030 §Readers), so a case that hands a verb a booted simulator seeds this first.
 */
export async function bindingFixture(projectRoot: string, udid: string, name = SIMULATOR_NAME) {
  const root = canonicalizeExistingPath(projectRoot);
  const now = Date.now();
  const file = path.join(
    `${projectRoot}.expo-home`,
    'agent-cli',
    'bindings',
    `${digestOf(root)}-ios-local-ios.json`
  );
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(
    file,
    JSON.stringify({
      version: 1,
      device: { backend: 'local-ios', platform: 'ios', udid, name, origin: 'created' },
      projectRoot: root,
      boundAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
    })
  );
  return file;
}

/**
 * Bind `serial` to the fixture worktree as an `explicit` Android binding, the lease 60 min ahead,
 * so every verb of the fixture drives this emulator (llp/0030 §Readers). What `dev --device`
 * (llp/0033) writes; until then the one way a case hands a verb an attached emulator.
 */
export async function androidBindingFixture(projectRoot: string, serial: string) {
  const root = canonicalizeExistingPath(projectRoot);
  const now = Date.now();
  const file = path.join(
    `${projectRoot}.expo-home`,
    'agent-cli',
    'bindings',
    `${digestOf(root)}-android-local-android.json`
  );
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(
    file,
    JSON.stringify({
      version: 1,
      device: {
        backend: 'local-android',
        platform: 'android',
        serial,
        origin: { kind: 'explicit' },
      },
      projectRoot: root,
      boundAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
    })
  );
  return file;
}

/** The serials the stub `emulator` instances of a fixture are up under, one per line. */
export function stubEmulatorStatePath(root: string): string {
  return path.join(root, '.stub-emulators');
}

/**
 * A stub `emulator`, installed beside the stub `adb`'s SDK so `resolveEmulator` finds it. It records
 * its argv, answers `-list-avds` with `avds`, and otherwise behaves as a spawned instance: appends
 * its serial (from `-ports`) to {@link stubEmulatorStatePath}, removes it on `SIGTERM`, and stays
 * alive until killed. A case that spawns one kills it afterwards ({@link killBoundEmulatorsAsync}).
 */
export async function installStubEmulatorAsync(
  root: string,
  { avds = [EMULATOR_NAME] }: { avds?: string[] } = {}
): Promise<{ calls: StubCalls }> {
  const recordPath = path.join(root, '.emulator-calls.jsonl');
  const sdk = path.join(root, '.stub-android-sdk');
  const scriptPath = path.join(sdk, 'emulator', 'emulator-stub.js');
  await fs.promises.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.promises.writeFile(
    scriptPath,
    [
      `const fs = require('fs');`,
      `const args = process.argv.slice(2);`,
      `fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(args) + '\\n');`,
      `if (args[0] === '-list-avds') { process.stdout.write(${JSON.stringify(avds.join('\n') + '\n')}); process.exit(0); }`,
      `const serial = 'emulator-' + args[args.indexOf('-ports') + 1].split(',')[0];`,
      `const state = ${JSON.stringify(stubEmulatorStatePath(root))};`,
      `fs.appendFileSync(state, serial + '\\n');`,
      `process.on('SIGTERM', () => {`,
      `  const up = fs.existsSync(state) ? fs.readFileSync(state, 'utf8').split(/\\r?\\n/).filter(Boolean) : [];`,
      `  fs.writeFileSync(state, up.filter((line) => line !== serial).map((line) => line + '\\n').join(''));`,
      `  process.exit(0);`,
      `});`,
      `setInterval(() => {}, 1000);`,
    ].join('\n')
  );
  await installStubBinAsync(path.join(sdk, 'emulator'), 'emulator', scriptPath);
  return { calls: () => readCalls(recordPath) };
}

/** Kill every instance the Android bindings of `home` name, as a case's `afterEach`. */
export async function killBoundEmulatorsAsync(home: string): Promise<void> {
  const dir = path.join(home, 'agent-cli', 'bindings');
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const name of fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith('-android-local-android.json'))) {
    const binding = JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8'));
    const pid = binding?.device?.origin?.emulatorPid;
    if (typeof pid === 'number') {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  }
}

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
 * A stub `adb` that lists the attached emulator `EMULATOR_SERIAL` (bound to the fixture through
 * {@link androidBindingFixture}, unless `attached` is false) and every instance the stub `emulator`
 * is up as ({@link stubEmulatorStatePath}). `get-state` answers `device` for a listed serial and the
 * real tool's "not found" for any other; `sys.boot_completed` is `1`. The emulator has `appId`
 * installed, unless `STUB_ADB_INSTALLED=0`.
 *
 * `exec-out` receives the `dd` command as one argument, the way a device shell would, and the stub
 * slices the fixture APK on `skip=` and `count=`. `STUB_ADB_APK_FIXTURE=<path>` serves another
 * archive, e.g. one whose `app.fingerprint` is not the JSON `expo-constants` writes. `STUB_ADB_NO_DD=1` fails `stat`, the way a device
 * without the tools does, and `pull` then copies the fixture to the path asked for.
 * `STUB_ADB_HANG_READ=<file>` makes `exec-out` write its pid there and never exit.
 *
 * Installed under a fake SDK: `ANDROID_HOME` beats `PATH`, so a runner with a real SDK still
 * reaches this stub (@ref src/device/adb §resolveAdb). The returned `env` names it, and the
 * fixture's Expo home, which holds the binding.
 */
export async function installStubAdbAsync(
  root: string,
  appId: string,
  { attached = true }: { attached?: boolean } = {}
): Promise<{ env: Record<string, string>; calls: StubCalls }> {
  const recordPath = path.join(root, '.adb-calls.jsonl');
  const scriptPath = path.join(root, '.stub-bin', 'adb-stub.js');
  await fs.promises.mkdir(path.dirname(scriptPath), { recursive: true });
  if (attached) {
    await androidBindingFixture(root, EMULATOR_SERIAL);
  }
  await fs.promises.writeFile(
    scriptPath,
    [
      `const fs = require('fs');`,
      `const args = process.argv.slice(2);`,
      `fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(args) + '\\n');`,
      `const apk = fs.readFileSync(process.env.STUB_ADB_APK_FIXTURE || ${JSON.stringify(APK_FIXTURE)});`,
      `const installed = process.env.STUB_ADB_INSTALLED !== '0';`,
      `const state = ${JSON.stringify(stubEmulatorStatePath(root))};`,
      `const serials = [${attached ? JSON.stringify(EMULATOR_SERIAL) : ''}].concat(`,
      `  fs.existsSync(state) ? fs.readFileSync(state, 'utf8').split(/\\r?\\n/).filter(Boolean) : []`,
      `);`,
      `if (args[0] === 'devices') {`,
      `  process.stdout.write(['List of devices attached'].concat(serials.map((serial) => serial + '\\tdevice model:sdk_gphone64_arm64')).join('\\n') + '\\n');`,
      `  process.exit(0);`,
      `}`,
      `if (args[2] === 'get-state') {`,
      `  if (!serials.includes(args[1])) { process.stderr.write("error: device '" + args[1] + "' not found\\n"); process.exit(1); }`,
      `  process.stdout.write('device\\n');`,
      `  process.exit(0);`,
      `}`,
      `if (args.includes('getprop')) { process.stdout.write('1\\n'); process.exit(0); }`,
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
  return {
    env: { ANDROID_HOME: sdk, __UNSAFE_EXPO_HOME_DIRECTORY: `${root}.expo-home` },
    calls: () => readCalls(recordPath),
  };
}

/** Where the stub `xcrun` marks the app as running: `openurl` writes it, `terminate` removes it. */
export function appStartedMarkerPath(root: string): string {
  return path.join(root, '.stub-app-started');
}

const STUB_RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-0';

/**
 * A stub `xcrun`, installed into `<root>/.stub-bin`, which has to be first on the `PATH` of the
 * process that spawns it.
 *
 * `simctl list devices` answers with one booted simulator when `booted` is given, whose app
 * container holds `booted.fingerprint` at the static-linking path; otherwise with `simulators`
 * (each `Shutdown` unless it says otherwise); otherwise none. A booted simulator is also bound to
 * the fixture through {@link bindingFixture}. The listing is state the stub keeps:
 * `create` adds a `Shutdown` simulator whose udid is `E2E-CREATED-<n>`, `delete` removes one,
 * `boot`, `bootstatus -b` and `shutdown` change its state, as a real `simctl` does. `list runtimes -j` names one
 * iOS runtime.
 *
 * `openurl` and `terminate` mark the app started and stopped at {@link appStartedMarkerPath}.
 * `terminate` refuses an app outside `runningAppIds` the way `simctl` does, when the list is given.
 *
 * `devicectl list` answers with the fixture phones when `phone` is given; a `launch` then answers
 * the way the dev-launcher responder does, posting `phone.fingerprint` to the callback URL carried
 * by the payload URL — after `phone.postDelayMs`, for a launch that is slow to answer.
 */
export async function installStubXcrunAsync(
  root: string,
  {
    booted,
    simulators,
    runningAppIds,
    phone,
  }: {
    booted?: { fingerprint: string };
    simulators?: { udid: string; name: string; state?: 'Booted' | 'Shutdown' }[];
    runningAppIds?: string[];
    /** `postDelayMs` holds the POST back, the way a slow cold launch does. */
    phone?: { fingerprint: string | null; postDelayMs?: number };
  } = {}
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
  const statePath = path.join(root, '.xcrun-simulators.json');
  const counterPath = path.join(root, '.xcrun-created-count');
  await fs.promises.writeFile(
    statePath,
    JSON.stringify(
      booted
        ? [{ udid: SIMULATOR_UDID, name: SIMULATOR_NAME, state: 'Booted' }]
        : (simulators ?? []).map(({ udid, name, state }) => ({
            udid,
            name,
            state: state ?? 'Shutdown',
          }))
    )
  );
  await fs.promises.rm(counterPath, { force: true });
  // A booted simulator the stub lists is one `dev` bound to this fixture, or no verb would drive it.
  const bound = booted
    ? { udid: SIMULATOR_UDID, name: SIMULATOR_NAME }
    : simulators?.find((simulator) => simulator.state === 'Booted');
  if (bound) {
    await bindingFixture(root, bound.udid, bound.name);
  }
  const binDir = path.join(root, '.stub-bin');
  const scriptPath = path.join(binDir, 'xcrun-stub.js');
  await fs.promises.mkdir(binDir, { recursive: true });
  await fs.promises.writeFile(
    scriptPath,
    [
      `const fs = require('fs');`,
      `const args = process.argv.slice(2);`,
      `fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(args) + '\\n');`,
      `const statePath = ${JSON.stringify(statePath)};`,
      `const sims = JSON.parse(fs.readFileSync(statePath, 'utf8'));`,
      `const save = () => fs.writeFileSync(statePath, JSON.stringify(sims));`,
      `const find = (udid) => sims.find((sim) => sim.udid === udid);`,
      `const marker = ${JSON.stringify(appStartedMarkerPath(root))};`,
      `if (args[0] === 'simctl' && args[1] === 'list' && args[2] === 'runtimes') {`,
      `  process.stdout.write(JSON.stringify({ runtimes: [{ identifier: ${JSON.stringify(STUB_RUNTIME)}, name: 'iOS 26.0', version: '26.0', platform: 'iOS', isAvailable: true, supportedDeviceTypes: [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', name: ${JSON.stringify(SIMULATOR_NAME)}, productFamily: 'iPhone' }] }] }));`,
      `  process.exit(0);`,
      `}`,
      `if (args[0] === 'simctl' && args[1] === 'list') {`,
      `  const listed = args.includes('booted') ? sims.filter((sim) => sim.state === 'Booted') : sims;`,
      `  process.stdout.write(JSON.stringify({ devices: listed.length ? { ${JSON.stringify(STUB_RUNTIME)}: listed } : {} }));`,
      `  process.exit(0);`,
      `}`,
      `if (args[0] === 'simctl' && args[1] === 'create') {`,
      `  const n = (Number(fs.existsSync(${JSON.stringify(counterPath)}) ? fs.readFileSync(${JSON.stringify(counterPath)}, 'utf8') : 0)) + 1;`,
      `  fs.writeFileSync(${JSON.stringify(counterPath)}, String(n));`,
      `  sims.push({ udid: 'E2E-CREATED-' + n, name: args[2], state: 'Shutdown' });`,
      `  save();`,
      `  process.stdout.write('E2E-CREATED-' + n + '\\n');`,
      `  process.exit(0);`,
      `}`,
      `if (args[0] === 'simctl' && ['delete', 'boot', 'shutdown'].includes(args[1])) {`,
      `  const sim = find(args[2]);`,
      `  if (!sim) {`,
      `    process.stderr.write('Invalid device: ' + args[2] + '\\n');`,
      `    process.exit(148);`,
      `  }`,
      `  if (args[1] === 'delete') sims.splice(sims.indexOf(sim), 1);`,
      `  else sim.state = args[1] === 'boot' ? 'Booted' : 'Shutdown';`,
      `  save();`,
      `  process.exit(0);`,
      `}`,
      `if (args[0] === 'simctl' && args[1] === 'bootstatus') {`,
      `  const sim = args.includes('-b') ? find(args[2]) : null;`,
      `  if (sim) { sim.state = 'Booted'; save(); }`,
      `  process.exit(0);`,
      `}`,
      `if (args[0] === 'simctl' && args[1] === 'openurl') {`,
      `  fs.writeFileSync(marker, '');`,
      `  process.exit(0);`,
      `}`,
      `if (args[0] === 'simctl' && args[1] === 'terminate') {`,
      `  const running = ${JSON.stringify(runningAppIds ?? null)};`,
      `  if (running && !running.includes(args[3])) {`,
      `    process.stderr.write('An error was encountered processing the command: found nothing to terminate');`,
      `    process.exit(4);`,
      `  }`,
      `  fs.rmSync(marker, { force: true });`,
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
      // The real `launch` returns once the app is up; the app answers on its own time. So the POST
      // is made by a detached child, and this process exits at once.
      `  const url = new URL(args[args.indexOf('--payload-url') + 1]);`,
      `  const callback = url.searchParams.get('__expo_fingerprint_callback');`,
      `  const body = JSON.stringify({ nonce: url.searchParams.get('__expo_fingerprint_nonce'), fingerprint: ${JSON.stringify(phone?.fingerprint ?? null)}, fingerprintVersion: '0.20.0' });`,
      `  const post = "setTimeout(() => { const r = require('http').request(process.argv[1], { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => process.exit(0)); }); r.on('error', () => process.exit(1)); r.end(process.argv[2]); }, Number(process.argv[3]));";`,
      `  require('child_process').spawn(process.execPath, ['-e', post, callback, body, String(${phone?.postDelayMs ?? 0})], { detached: true, stdio: 'ignore' }).unref();`,
      `  process.exit(0);`,
      `}`,
      `process.stderr.write('stub xcrun: unexpected ' + args.join(' ') + '\\n');`,
      `process.exit(2);`,
    ].join('\n')
  );
  await installStubBinAsync(binDir, 'xcrun', scriptPath);
  return { binDir, calls: () => readCalls(recordPath) };
}
