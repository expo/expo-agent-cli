// @ref llp/0037-patch-command.rfc.md §Expo modules: build from source
// A patch to the native code of a precompiled module does nothing: the app links the binary that
// was built before the patch existed. `expo.autolinking.<platform>.buildFromSource` is the switch
// that makes autolinking compile the module from source instead (docs: guides/prebuilt-expo-modules).
//
// Not `exclude`: that removes the module from the app entirely, and the app then fails at runtime.

import fs from 'fs';
import path from 'path';

import { readJsonFileSync } from '../project/nodeModules';
import type { PackageJsonEdit } from './packageJson';

export type NativePlatform = 'ios' | 'android';

/**
 * Packages that are precompiled for iOS although they are not Expo modules, and the packages they
 * must be built together with. EAS downloads their XCFrameworks, and the prebuilt-modules guide
 * says "Source-building only one produces a mixed precompiled/source linkage that fails to resolve
 * the matching framework at runtime." It names `ios.buildFromSource` only, so the pair is an iOS
 * rule: an Android patch adds only the patched package.
 */
const IOS_PRECOMPILED_GROUPS: string[][] = [['react-native-reanimated', 'react-native-worklets']];

const APPLE_EXTENSIONS = new Set(['.swift', '.m', '.mm', '.podspec']);
const ANDROID_EXTENSIONS = new Set(['.kt', '.kts', '.java', '.gradle']);
/** C and C++ sources and headers: the platform comes from the directory, else both. */
const SHARED_NATIVE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp']);

/**
 * Which native platforms a file of a package belongs to. Empty for a JavaScript file.
 *
 * The top directory decides first, so `android/src/main/cpp/NativeProxy.h` is Android. A header or
 * a C++ file outside a platform directory (`Common/…`) is compiled into both platforms.
 */
export function nativePlatformsOfFile(file: string): NativePlatform[] {
  const normalized = file.replace(/\\/g, '/');
  const ext = path.posix.extname(normalized).toLowerCase();
  const top = normalized.split('/')[0];
  if (top === 'ios' || top === 'apple' || top === 'macos') {
    return ['ios'];
  }
  if (top === 'android') {
    return ['android'];
  }
  if (APPLE_EXTENSIONS.has(ext)) {
    return ['ios'];
  }
  if (ANDROID_EXTENSIONS.has(ext) || path.posix.basename(normalized) === 'CMakeLists.txt') {
    return ['android'];
  }
  if (SHARED_NATIVE_EXTENSIONS.has(ext)) {
    return ['ios', 'android'];
  }
  return [];
}

/**
 * Files that change the native project without being native code: the config plugin, which runs at
 * prebuild, and the files autolinking reads. A patch to one needs a new build, not a reload.
 */
export function isNativeConfigFile(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  return NATIVE_CONFIG_FILES.has(normalized) || normalized.startsWith('plugin/');
}

const NATIVE_CONFIG_FILES = new Set([
  'app.plugin.js',
  'expo-module.config.json',
  'package.json',
  'react-native.config.js',
]);

/** The native platforms a set of patched files touches, in a stable order. */
export function nativePlatformsOfFiles(files: string[]): NativePlatform[] {
  const found = new Set(files.flatMap(nativePlatformsOfFile));
  return (['ios', 'android'] as const).filter((platform) => found.has(platform));
}

/**
 * Whether a package ships precompiled native code for a platform, i.e. whether `buildFromSource`
 * applies to it there. An Expo module does on both; the third-party groups do on iOS only.
 */
export function isPrecompiledOn(
  packageName: string,
  packageDir: string,
  platform: NativePlatform
): boolean {
  return (
    fs.existsSync(path.join(packageDir, 'expo-module.config.json')) ||
    (platform === 'ios' && IOS_PRECOMPILED_GROUPS.some((group) => group.includes(packageName)))
  );
}

/** The package and the packages it has to be built from source together with, on a platform. */
export function buildFromSourceGroup(packageName: string, platform: NativePlatform): string[] {
  const group =
    platform === 'ios'
      ? IOS_PRECOMPILED_GROUPS.find((members) => members.includes(packageName))
      : null;
  return group ?? [packageName];
}

interface ExpoModuleConfig {
  android?: { name?: string; projects?: { name?: string; publication?: unknown }[] };
}

/**
 * The names `buildFromSource` is matched against for a package on a platform. iOS matches the npm
 * name. Android matches the Gradle project name, which autolinking makes from the npm name
 * (`@expo/ui` → `expo-ui`) unless `expo-module.config.json` names it, plus each extra project with
 * a publication [observed — expo-modules-autolinking `convertPackageToProjectName`,
 * `ExpoModuleConfig.androidProjects`, `SettingsManager.kt`].
 */
export function buildFromSourceNames(
  packageName: string,
  packageDir: string,
  platform: NativePlatform
): string[] {
  if (platform === 'ios') {
    return buildFromSourceGroup(packageName, platform);
  }
  const config = readJsonFileSync<ExpoModuleConfig>(
    path.join(packageDir, 'expo-module.config.json')
  );
  const projects = (config?.android?.projects ?? [])
    .filter((project) => project.publication && typeof project.name === 'string')
    .map((project) => project.name!);
  return [...new Set([config?.android?.name ?? androidProjectName(packageName), ...projects])];
}

function androidProjectName(packageName: string): string {
  return packageName.replace(/^@/g, '').replace(/\W+/g, '-');
}

/**
 * The entry that names exactly one package.
 *
 * The entries are regular expressions: Android matches them against the whole project name and iOS
 * anywhere in the pod or package name [observed — expo-modules-autolinking `SettingsManager.kt`,
 * `precompiled_modules.rb`]. A dot is the one character an npm name can carry that means something
 * else in a regular expression.
 */
export function buildFromSourceEntry(packageName: string): string {
  return packageName.replace(/[.]/g, '\\.');
}

/** Whether an existing entry already matches this name. */
function isCovered(entries: string[], name: string): boolean {
  return entries.some((entry) => {
    try {
      // Android's rule is the stricter one: a match of the whole name.
      return new RegExp(`^(?:${entry})$`).test(name);
    } catch {
      return false;
    }
  });
}

export interface BuildFromSourceChange {
  platform: NativePlatform;
  /** The key under `expo.autolinking` this run wrote: `ios`, `apple` or `android`. */
  key: string;
  /** Entries this run added. */
  added: string[];
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The list autolinking uses for a platform, and the key it reads it from. Observed in
 * expo-modules-autolinking 58.0.9 `parsePackageJsonOptions`: iOS reads `apple`, and `ios` only when
 * `apple` is missing; the platform object is spread over the top level, so a platform list
 * replaces the top-level `buildFromSource` and is not merged with it.
 */
function effectiveBuildFromSource(
  autolinking: unknown,
  platform: NativePlatform
): { key: string; list: unknown[] } {
  const options = isObject(autolinking) ? autolinking : {};
  const key = platform === 'android' ? 'android' : isObject(options.apple) ? 'apple' : 'ios';
  const own = isObject(options[key]) ? options[key].buildFromSource : undefined;
  if (Array.isArray(own)) {
    return { key, list: own };
  }
  return { key, list: Array.isArray(options.buildFromSource) ? options.buildFromSource : [] };
}

export interface BuildFromSourceTarget {
  platform: NativePlatform;
  /** What autolinking matches the entries against on that platform (`buildFromSourceNames`). */
  names: string[];
}

/**
 * Plan the additions to the `buildFromSource` list that autolinking reads for each platform. A new
 * platform list starts as a copy of the top-level list, so the modules that list builds from source
 * still do. Keeps every existing entry, and adds nothing an existing entry already matches.
 *
 * @returns what changes, per platform, and the edit that makes those changes.
 */
export function planBuildFromSource(
  pkg: Record<string, any>,
  targets: BuildFromSourceTarget[]
): { changes: BuildFromSourceChange[]; edit: PackageJsonEdit } {
  const changes: BuildFromSourceChange[] = [];
  for (const { platform, names } of targets) {
    const { key, list } = effectiveBuildFromSource(pkg.expo?.autolinking, platform);
    const entries = list.filter((e): e is string => typeof e === 'string');
    const added = names.filter((name) => !isCovered(entries, name)).map(buildFromSourceEntry);
    if (added.length) {
      changes.push({ platform, key, added });
    }
  }
  const edit: PackageJsonEdit = (json) => {
    for (const { platform, key, added } of changes) {
      const { list } = effectiveBuildFromSource(json.expo?.autolinking, platform);
      json.expo ??= {};
      json.expo.autolinking ??= {};
      json.expo.autolinking[key] ??= {};
      json.expo.autolinking[key].buildFromSource = [...list, ...added];
    }
  };
  return { changes, edit };
}
