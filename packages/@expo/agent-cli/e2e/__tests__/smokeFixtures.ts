// Stubs and debugger targets shared by `smoke-test.ts`, `smoke-simulator-binding-test.ts` and
// `smoke-expo-go-test.ts`.
import fs from 'node:fs';
import path from 'node:path';

import { installStubBinAsync, pathEnvVars, readJsonLines } from '../utils';
import {
  androidBindingFixture,
  installStubXcrunAsync as installStatefulXcrunAsync,
  PNG_HEADER_ESCAPE,
} from './installedAppStubs';

export const SIMULATOR_UDID = 'E2E-SIM-SMOKE';

/** A debugger target that looks like Expo Go, so the `exp://` URL shape is chosen. */
export const EXPO_GO_TARGET = {
  id: '1',
  appId: 'host.exp.Exponent',
  webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=1&page=1',
};

/**
 * The same, for a project whose app is a development build rather than Expo Go.
 *
 * The application id is the difference and the whole of it: a target listed under
 * `host.exp.Exponent` is Expo Go's, and a run that decided this project needs a development build
 * would be reading the wrong app's runtime.
 */
export const DEV_BUILD_TARGET = {
  id: '1',
  appId: 'com.example.devclientfreshapp',
  // The name the stub `xcrun` reports as booted, and the reason this target counts as an iOS one:
  // nothing about a development build's app id names a platform, so `platformOfTarget` falls
  // through to the device index the simulator list builds (`src/runtime/targetPlatform.ts`). Expo
  // Go needs none of this — its bundle id *is* the evidence — which is why the constant above has
  // no device name and this one must.
  deviceName: 'iPhone 17 Pro',
  webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=1&page=1',
};

/** The stateful stub `xcrun`, listing this file's one booted simulator, and its argv reader. */
export async function installStubXcrunAsync(projectRoot: string): Promise<() => string[][]> {
  const { calls } = await installStatefulXcrunAsync(projectRoot, {
    simulators: [{ udid: SIMULATOR_UDID, name: 'iPhone 17 Pro', state: 'Booted' }],
  });
  return calls;
}

/**
 * Install a stub `adb` that reports one attached device, bound to the fixture, and writes a PNG to
 * **stdout** for `exec-out screencap -p`, exactly as the real one does.
 *
 * This is the fixture the whole Android screenshot path rests on: the bytes go through a real pipe
 * into a real file descriptor, which is the one thing a mocked `spawn` cannot show.
 */
export async function installStubAdbAsync(projectRoot: string): Promise<Record<string, string>> {
  const scriptPath = path.join(projectRoot, '.stub-bin', 'adb-stub.js');
  await fs.promises.mkdir(path.dirname(scriptPath), { recursive: true });
  await androidBindingFixture(projectRoot, 'emulator-5554');
  await fs.promises.writeFile(
    scriptPath,
    [
      `const args = process.argv.slice(2);`,
      `if (args[0] === 'devices') {`,
      `  process.stdout.write('List of devices attached\\nemulator-5554\\tdevice\\n');`,
      `  process.exit(0);`,
      `}`,
      `if (args[2] === 'get-state') { process.stdout.write('device\\n'); process.exit(0); }`,
      `if (args.includes('screencap')) {`,
      // Bytes a pty would rewrite, so a path that went through `adb shell` would corrupt them.
      `  process.stdout.write(Buffer.from("${PNG_HEADER_ESCAPE}\\r\\n\\x00\\xff", 'binary'));`,
      `  process.exit(0);`,
      `}`,
      `process.exit(0);`,
    ].join('\n')
  );
  await installStubBinAsync(path.join(projectRoot, '.stub-bin'), 'adb', scriptPath);
  // ANDROID_HOME beats PATH, and a runner that already has an SDK would otherwise photograph
  // a real emulator (or none) instead of this stub.
  const sdk = path.join(projectRoot, '.stub-android-sdk');
  await installStubBinAsync(path.join(sdk, 'platform-tools'), 'adb', scriptPath);
  return { ANDROID_HOME: sdk };
}

/**
 * A stub `adb` for the Expo Go questions, and every call recorded.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §The Expo Go on the device is not the Expo Go the SDK wants
 *
 * Separate from {@link installStubAdbAsync}, which answers the screenshot path. What this one is
 * for is the three commands the version check and the install go through, and each of its answers
 * is copied from a run against a real emulator rather than invented
 * [emulator-5554, Android 36, 2026-09-03]:
 *
 * - `shell pm path <id>` — exit **1** for a package the device has not got, and a `package:` line
 *   with exit 0 for one it has.
 * - `shell dumpsys package <id>` — `versionName=…`, and **exit 0 even when the package is absent**,
 *   printing `Unable to find package`.
 * - `install -r -d <apk>` — `Success`.
 *
 * @param installedVersion the Expo Go on the fixture's device, or null for a device without one.
 */
export async function installStubAdbForExpoGoAsync(
  projectRoot: string,
  installedVersion: string | null
): Promise<{ env: Record<string, string>; read: () => string[][] }> {
  const recordPath = path.join(projectRoot, '.adb-calls.jsonl');
  const scriptPath = path.join(projectRoot, '.stub-bin', 'adb-expo-go-stub.js');
  await fs.promises.mkdir(path.dirname(scriptPath), { recursive: true });
  await androidBindingFixture(projectRoot, 'emulator-5554');
  await fs.promises.writeFile(
    scriptPath,
    [
      `const fs = require('fs');`,
      `const args = process.argv.slice(2);`,
      `fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(args) + '\\n');`,
      `const installed = ${JSON.stringify(installedVersion)};`,
      `if (args[0] === 'devices') {`,
      `  process.stdout.write('List of devices attached\\nemulator-5554\\tdevice\\n');`,
      `  process.exit(0);`,
      `}`,
      `if (args[2] === 'get-state') { process.stdout.write('device\\n'); process.exit(0); }`,
      `if (args.includes('pm') && args.includes('path')) {`,
      `  if (installed == null) { process.exit(1); }`,
      `  process.stdout.write('package:/data/app/~~abc==/host.exp.exponent-def==/base.apk\\n');`,
      `  process.exit(0);`,
      `}`,
      `if (args.includes('dumpsys')) {`,
      // Exit 0 either way, which is the quirk the reader has to survive.
      `  if (installed == null) { process.stdout.write('Unable to find package: host.exp.exponent\\n'); process.exit(0); }`,
      `  process.stdout.write('  Package [host.exp.exponent] (abc):\\n    versionCode=444 minSdk=24\\n    versionName=' + installed + '\\n');`,
      `  process.exit(0);`,
      `}`,
      `if (args.includes('install')) {`,
      `  process.stdout.write('Performing Streamed Install\\nSuccess\\n');`,
      `  process.exit(0);`,
      `}`,
      `process.exit(0);`,
    ].join('\n')
  );
  await installStubBinAsync(path.join(projectRoot, '.stub-bin'), 'adb', scriptPath);
  // ANDROID_HOME beats PATH, and a runner that already has an SDK would otherwise reach a real
  // emulator instead of this stub (@ref src/device/adb §resolveAdb).
  const sdk = path.join(projectRoot, '.stub-android-sdk');
  await installStubBinAsync(path.join(sdk, 'platform-tools'), 'adb', scriptPath);
  return {
    env: { ANDROID_HOME: sdk },
    read: () => readJsonLines(recordPath),
  };
}

/** Give the fixture an Expo Router `app/` directory with the named route files. */
export async function writeRoutesAsync(projectRoot: string, files: string[]): Promise<void> {
  for (const file of files) {
    const target = path.join(projectRoot, 'app', file);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, 'export default function Route() { return null; }\n');
  }
}

/**
 * A stub `npx`, so no test in this tier downloads Expo Go.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §Putting Expo Go on a simulator that has not got it
 * The install phase shells `npx --yes expo-go download`, which is a 423 MB transfer over the
 * network. Left unstubbed it doubled this suite's wall clock and made it depend on a CDN
 * [observed, 2026-09-03]. It answers the `{"path":…}` shape the real CLI does, and records what it
 * was asked so a test can assert the install happened without one byte moving.
 */
export async function installStubNpxAsync(projectRoot: string): Promise<() => string[][]> {
  const recordPath = path.join(projectRoot, '.npx-calls.jsonl');
  const scriptPath = path.join(projectRoot, '.stub-bin', 'npx-stub.js');
  await fs.promises.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.promises.writeFile(
    scriptPath,
    [
      `const fs = require('fs');`,
      `const path = require('path');`,
      `const args = process.argv.slice(2);`,
      `fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(args) + '\\n');`,
      // The one verb this tier exercises. A downloaded bundle is a directory, so the stub makes an
      // empty one at the path it answers — which is what `simctl install` would be handed.
      `if (args.includes('download')) {`,
      `  const target = path.join(process.cwd(), 'Expo-Go-57.0.9.tar.app');`,
      `  fs.mkdirSync(target, { recursive: true });`,
      `  process.stdout.write(JSON.stringify({ path: target }));`,
      `  process.exit(0);`,
      `}`,
      `if (args.includes('url')) {`,
      `  process.stdout.write(JSON.stringify({ url: 'https://example.com/Expo-Go-57.0.9/Expo-Go-57.0.9.tar.gz' }));`,
      `  process.exit(0);`,
      `}`,
      `process.exit(0);`,
    ].join('\n')
  );
  await installStubBinAsync(path.join(projectRoot, '.stub-bin'), 'npx', scriptPath);
  return () => readJsonLines(recordPath);
}

/**
 * The stub `expo` and **no device tools at all**, for the cases that are about the dev server.
 *
 * `stubExpoEnv` inherits this machine's `PATH`, so `xcrun` on it is the real one — and once a run
 * gets past the readiness check it will happily boot the developer's own simulator and wait two
 * minutes for an app that was never installed on it. The stub `expo` is resolved through the
 * project's `node_modules` rather than through `PATH`, so dropping the inherited entries costs
 * these cases nothing and keeps them tests of the code rather than of the machine.
 */
export function devServerOnlyEnv(projectRoot: string): Record<string, string> {
  return pathEnvVars(path.join(projectRoot, '.no-bin'));
}
