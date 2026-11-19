// @ref llp/0037-patch-command.rfc.md §Expo modules: build from source
// A patch to the native code of a precompiled module does nothing: the app links the binary that
// was built before the patch existed. `expo.autolinking.<platform>.buildFromSource` is the switch
// that makes autolinking compile the module from source instead (docs: guides/prebuilt-expo-modules).
//
// Not `exclude`: that removes the module from the app entirely, and the app then fails at runtime.

import fs from 'fs';
import path from 'path';

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

/** Whether an existing entry already makes this package build from source on both platforms. */
function isCovered(entries: string[], packageName: string): boolean {
  return entries.some((entry) => {
    try {
      // Android's rule is the stricter one: a match of the whole name.
      return new RegExp(`^(?:${entry})$`).test(packageName);
    } catch {
      return false;
    }
  });
}

export interface BuildFromSourceChange {
  platform: NativePlatform;
  /** Entries this run added. */
  added: string[];
}

/**
 * Add the packages to `expo.autolinking.<platform>.buildFromSource` of the project `package.json`.
 *
 * Keeps every existing entry and the key order of the file, and adds nothing an existing entry
 * already matches.
 *
 * @returns what changed, per platform; empty when the file already said all of it.
 */
export function addBuildFromSource(
  projectRoot: string,
  packageNames: string[],
  platforms: NativePlatform[]
): BuildFromSourceChange[] {
  if (!platforms.length || !packageNames.length) {
    return [];
  }
  const file = path.join(projectRoot, 'package.json');
  const text = fs.readFileSync(file, 'utf8');
  const pkg = JSON.parse(text);
  const changes: BuildFromSourceChange[] = [];

  for (const platform of platforms) {
    const existing: unknown = pkg.expo?.autolinking?.[platform]?.buildFromSource;
    const entries = Array.isArray(existing)
      ? existing.filter((e): e is string => typeof e === 'string')
      : [];
    const added = packageNames
      .filter((name) => !isCovered(entries, name))
      .map(buildFromSourceEntry);
    if (!added.length) {
      continue;
    }
    pkg.expo ??= {};
    pkg.expo.autolinking ??= {};
    pkg.expo.autolinking[platform] ??= {};
    pkg.expo.autolinking[platform].buildFromSource = [
      ...(Array.isArray(existing) ? existing : []),
      ...added,
    ];
    changes.push({ platform, added });
  }

  if (changes.length) {
    const indent = /^[ \t]+/m.exec(text)?.[0] ?? '  ';
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, indent)}\n`);
  }
  return changes;
}
