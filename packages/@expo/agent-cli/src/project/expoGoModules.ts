// @ref llp/0004-smart-start-and-project-state.rfc.md §Sub-features
// The native modules compiled into Expo Go, captured from apps/expo-go autolinking and
// shipped in this CLI. Lookups are Set.has. A project whose SDK major is not in the dump
// falls back to that SDK's bundledNativeModules.json so a new Expo release does not wait
// on an agent-cli update.
// Not `expoGoModules.json`: ncc merges a .ts and .json that share a basename into one
// namespace, and the named exports of this file disappear.
import dump from './expoGoNativeModules.json';

export interface ExpoGoSdkDump {
  captured: string;
  source: string;
  modules: string[];
}

export interface ExpoGoModulesDump {
  defaultSdk: string;
  alsoCompatible: string[];
  bySdk: Record<string, ExpoGoSdkDump>;
}

const DUMP = dump as ExpoGoModulesDump;

/** Packages Go implements without autolinking them. Templates depend on these. */
const ALSO_COMPATIBLE = new Set(DUMP.alsoCompatible);

/**
 * The Expo Go runtime itself. It ships native files (podspecs, ios/, android/) and is not an
 * autolinked third-party module, so it never appears in the dump.
 */
const RUNTIME_PACKAGES = new Set(['expo', 'react-native']);

/**
 * Packages whose native-looking files are build tooling, not something the app links.
 * `expo-modules-autolinking` ships `android/` for its Gradle plugin.
 */
const TOOLING_PACKAGES = new Set(['expo-modules-autolinking', '@react-native/gradle-plugin']);

/** One Set per SDK major, built once. `modules` ∪ `alsoCompatible`. */
const MODULES_BY_SDK = new Map<string, Set<string>>();
for (const [sdk, entry] of Object.entries(DUMP.bySdk)) {
  MODULES_BY_SDK.set(sdk, new Set([...entry.modules, ...DUMP.alsoCompatible]));
}

/** The leading integer of an SDK version string, or null when there is none. */
export function sdkMajor(sdkVersion: string | null | undefined): string | null {
  if (!sdkVersion) {
    return null;
  }
  const match = /^(\d+)/.exec(sdkVersion);
  return match?.[1] ?? null;
}

/** Whether this CLI has a captured autolink dump for the project's SDK major. */
export function dumpCoversSdk(sdkVersion: string | null | undefined): boolean {
  const major = sdkMajor(sdkVersion);
  return major != null && MODULES_BY_SDK.has(major);
}

/**
 * Whether a package's native code is in Expo Go for this project.
 *
 * Prefer the captured dump (O(1) Set). When this CLI has no dump for the SDK — a new release
 * we have not recaptured yet — fall back to the installed `expo` package's
 * `bundledNativeModules.json`. That catalog is over-inclusive, and it is available the day
 * the SDK ships.
 *
 * `alsoCompatible` applies on both paths: those packages are missing from Go's autolink
 * output on purpose and still run there. Runtime and tooling packages are never a reason:
 * `react-native` is the engine, and `expo-modules-autolinking` is a Gradle plugin.
 */
export function isExpoGoNativeModule(
  packageName: string,
  options: {
    sdkVersion: string | null;
    bundledNativeModules: Record<string, string> | null;
  }
): boolean {
  if (
    RUNTIME_PACKAGES.has(packageName) ||
    ALSO_COMPATIBLE.has(packageName) ||
    TOOLING_PACKAGES.has(packageName)
  ) {
    return true;
  }
  const dumped = sdkMajor(options.sdkVersion);
  const dumpSet = dumped ? MODULES_BY_SDK.get(dumped) : undefined;
  if (dumpSet) {
    return dumpSet.has(packageName);
  }
  return options.bundledNativeModules?.[packageName] != null;
}

export const EXPO_GO_MODULES_DUMP: ExpoGoModulesDump = DUMP;
