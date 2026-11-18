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
 * Packages that are precompiled although they are not Expo modules, and the packages they must be
 * built together with. The docs: "Source-building only one produces a mixed precompiled/source
 * linkage that fails to resolve the matching framework at runtime."
 */
const PRECOMPILED_GROUPS: string[][] = [['react-native-reanimated', 'react-native-worklets']];

const APPLE_EXTENSIONS = new Set(['.swift', '.m', '.mm', '.h', '.hpp', '.podspec']);
const ANDROID_EXTENSIONS = new Set(['.kt', '.kts', '.java', '.gradle']);
const SHARED_NATIVE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx']);

/** Which native platforms a file of a package belongs to. Empty for a JavaScript file. */
export function nativePlatformsOfFile(file: string): NativePlatform[] {
  const normalized = file.replace(/\\/g, '/');
  const ext = path.posix.extname(normalized).toLowerCase();
  const top = normalized.split('/')[0];
  if (top === 'ios' || top === 'apple' || top === 'macos' || APPLE_EXTENSIONS.has(ext)) {
    return ['ios'];
  }
  if (
    top === 'android' ||
    ANDROID_EXTENSIONS.has(ext) ||
    path.posix.basename(normalized) === 'CMakeLists.txt'
  ) {
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

/** Whether a package ships precompiled native code, i.e. whether `buildFromSource` applies to it. */
export function isPrecompiledCandidate(packageName: string, packageDir: string): boolean {
  return (
    fs.existsSync(path.join(packageDir, 'expo-module.config.json')) ||
    PRECOMPILED_GROUPS.some((group) => group.includes(packageName))
  );
}

/** The package and the packages it has to be built from source together with. */
export function buildFromSourceGroup(packageName: string): string[] {
  return PRECOMPILED_GROUPS.find((group) => group.includes(packageName)) ?? [packageName];
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
