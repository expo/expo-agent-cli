#!/usr/bin/env node
// Recapture Expo Go's autolinked native modules from a local expo/expo checkout.
// Does not clobber `alsoCompatible`. Prints a diff of `modules` before writing.
//
//   node packages/@expo/agent-cli/scripts/capture-expo-go-modules.mjs --expo /path/to/expo/expo
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dumpPath = path.join(here, '../src/project/expoGoNativeModules.json');

/** Matches `apps/expo-go/ios/Podfile` `use_expo_modules!({ exclude })`. */
const IOS_EXPO_EXCLUDE = [
  'expo-app-metrics',
  'expo-module-template',
  'expo-dev-launcher',
  'expo-dev-client',
  'expo-dev-menu',
  'expo-dev-menu-interface',
  'expo-maps',
  'expo-network-addons',
  'expo-insights',
  'expo-splash-screen',
  '@expo/app-integrity',
  'expo-brownfield',
  'expo-widgets',
  'expo-observe',
  '@expo/home',
];

/** Matches `apps/expo-go/android/settings.gradle` `expoAutolinking.exclude`, minus RN-community packages. */
const ANDROID_EXPO_EXCLUDE = [
  'expo-module-template',
  'expo-dev-launcher',
  'expo-dev-client',
  'expo-maps',
  'expo-network-addons',
  'expo-splash-screen',
  'expo-mesh-gradient',
  '@expo/app-integrity',
  '@expo/home',
  'expo-widgets',
  'expo-app-metrics',
  'expo-dev-menu',
  'expo-dev-menu-interface',
  'expo-insights',
  'expo-brownfield',
  'expo-observe',
];

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runJson(bin, args, cwd) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return { ok: false, error: result.stderr || result.stdout || `exit ${result.status}` };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `unreadable JSON: ${error.message}` };
  }
}

function expoModuleNames(payload) {
  return (payload.modules ?? []).map((module) => module.packageName).filter(Boolean);
}

function rnModuleNames(payload) {
  return Object.keys(payload.dependencies ?? {});
}

function readGeneratedRn(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return rnModuleNames(JSON.parse(fs.readFileSync(file, 'utf8')));
}

const expoRoot = arg('--expo');
if (!expoRoot) {
  fail('Usage: node capture-expo-go-modules.mjs --expo /path/to/expo/expo');
}

const goRoot = path.join(expoRoot, 'apps/expo-go');
const autolinkingBin = path.join(expoRoot, 'packages/expo-modules-autolinking/bin/expo-modules-autolinking.js');
if (!fs.existsSync(autolinkingBin)) {
  fail(`No expo-modules-autolinking bin at ${autolinkingBin}`);
}

const sdkFile = path.join(goRoot, 'sdkVersions.json');
const sdkVersion = fs.existsSync(sdkFile)
  ? JSON.parse(fs.readFileSync(sdkFile, 'utf8')).sdkVersion
  : null;
const sdk = typeof sdkVersion === 'string' ? sdkVersion.split('.')[0] : null;
if (!sdk) {
  fail(`Could not read SDK major from ${sdkFile}`);
}

const iosExpo = runJson(
  autolinkingBin,
  ['resolve', '--json', '--platform', 'apple', '--project-root', goRoot, '--exclude', ...IOS_EXPO_EXCLUDE],
  goRoot
);
if (!iosExpo.ok) {
  fail(`expo-modules resolve (apple) failed: ${iosExpo.error}`);
}
const androidExpo = runJson(
  autolinkingBin,
  [
    'resolve',
    '--json',
    '--platform',
    'android',
    '--project-root',
    goRoot,
    '--exclude',
    ...ANDROID_EXPO_EXCLUDE,
  ],
  goRoot
);
if (!androidExpo.ok) {
  fail(`expo-modules resolve (android) failed: ${androidExpo.error}`);
}

function rnNames(platform, generatedFile) {
  const fromCli = runJson(
    autolinkingBin,
    ['react-native-config', '--json', '--platform', platform, '--project-root', goRoot],
    goRoot
  );
  if (fromCli.ok) {
    return rnModuleNames(fromCli.value);
  }
  const fromDisk = readGeneratedRn(generatedFile);
  if (fromDisk.length) {
    console.warn(`react-native-config --platform ${platform} failed; using ${generatedFile}`);
    return fromDisk;
  }
  fail(`react-native-config --platform ${platform} failed: ${fromCli.error}`);
}

const iosRn = rnNames('ios', path.join(goRoot, 'ios/build/generated/autolinking/autolinking.json'));
const androidRn = rnNames(
  'android',
  path.join(goRoot, 'android/build/generated/autolinking/autolinking.json')
);

const modules = [
  ...new Set([
    ...expoModuleNames(iosExpo.value),
    ...expoModuleNames(androidExpo.value),
    ...iosRn,
    ...androidRn,
  ]),
].sort();

const existing = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
const previous = existing.bySdk?.[sdk]?.modules ?? [];
const added = modules.filter((name) => !previous.includes(name));
const removed = previous.filter((name) => !modules.includes(name));

console.log(`SDK ${sdk}: ${modules.length} modules (was ${previous.length})`);
if (added.length) {
  console.log(`  added: ${added.join(', ')}`);
}
if (removed.length) {
  console.log(`  removed: ${removed.join(', ')}`);
}
if (!added.length && !removed.length) {
  console.log('  no change');
}

existing.defaultSdk = sdk;
existing.bySdk = existing.bySdk ?? {};
existing.bySdk[sdk] = {
  captured: new Date().toISOString().slice(0, 10),
  source:
    'apps/expo-go prebuild autolinking (expo-modules resolve + rncore autolinking, ios ∪ android)',
  modules,
};
existing.alsoCompatible = existing.alsoCompatible ?? ['expo-splash-screen', 'expo-status-bar'];

fs.writeFileSync(dumpPath, `${JSON.stringify(existing, null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), dumpPath)}`);
