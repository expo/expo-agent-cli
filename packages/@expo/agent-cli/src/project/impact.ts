// @ref llp/0004-smart-start-and-project-state.rfc.md §Sub-features
// "What must rerun after installing this package?" — the same classification the decision table
// uses, consumed right after `expo install`.
import { readAppConfigPlugins } from './appConfig';
import {
  describeNativeCode,
  hasNativeCode,
  inspectPackageAsync,
  readProjectNativeDirsAsync,
} from './nativeCode';
import {
  listDependencyNames,
  loadBundledNativeModulesAsync,
  parsePackageName,
  readProjectPackageJsonAsync,
  resolvePackageRootAsync,
} from './nodeModules';
import type { InstallImpact, InstallImpactReport } from './types';

/** The project fingerprint on both sides of an install, and what the last build was made from. */
export interface FingerprintAcrossInstall {
  before: string;
  after: string;
  /** The hashes of the recorded builds, one per platform; empty without a record. */
  lastBuildHashes: string[];
}

export interface ClassifyInstallImpactOptions {
  /**
   * Measures the fingerprint after the install, or answers null when either side is unknown.
   * Called only when the answer can change an action: a native module without a config plugin, in
   * a project that builds its own runtime.
   */
  fingerprintAcrossInstallAsync?: () => Promise<FingerprintAcrossInstall | null>;
}

/** Which runtime the project runs on: Expo Go, or a build of its own. */
export interface RuntimeTarget {
  /** Checked-in native directories, which CNG must not regenerate. */
  isBare: boolean;
  /** No native directories and no `expo-dev-client`: the native runtime is Expo Go's. */
  targetsExpoGo: boolean;
}

export async function resolveRuntimeTargetAsync(projectRoot: string): Promise<RuntimeTarget> {
  const [nativeDirs, packageJson] = await Promise.all([
    readProjectNativeDirsAsync(projectRoot),
    readProjectPackageJsonAsync(projectRoot),
  ]);
  const isBare = nativeDirs.ios || nativeDirs.android;
  // `expo-dev-client` as a dependency means the project builds its own runtime, so a new native
  // module needs a new build even when Expo Go would have it.
  const usesDevClient = listDependencyNames(packageJson).includes('expo-dev-client');
  return { isBare, targetsExpoGo: !isBare && !usesDevClient };
}

/**
 * Classify what each installed package changed, and what must rerun because of it.
 *
 * Pure inspection of `node_modules` and the project config; nothing is spawned, so this is safe
 * to run right after an install. Unknown packages are reported as JavaScript-only, the cheapest
 * action, rather than making the caller guess.
 *
 * @param packageNames package specs as passed to `expo install`, version ranges included.
 */
export async function classifyInstallImpactAsync(
  projectRoot: string,
  packageNames: string[],
  { fingerprintAcrossInstallAsync }: ClassifyInstallImpactOptions = {}
): Promise<InstallImpactReport[]> {
  if (!packageNames.length) {
    return [];
  }

  const [bundledNativeModules, appConfig, { isBare, targetsExpoGo }] = await Promise.all([
    loadBundledNativeModulesAsync(projectRoot),
    readAppConfigPlugins(projectRoot),
    resolveRuntimeTargetAsync(projectRoot),
  ]);

  const reports: InstallImpactReport[] = [];
  // Reports the fingerprint may downgrade to a reload: native code and nothing else. A config
  // plugin is not in the hash until the app config lists it, so its build stays owed.
  const linkedOnly: InstallImpactReport[] = [];
  for (const spec of packageNames) {
    const packageName = parsePackageName(spec);
    const reasons: string[] = [];
    let isNativeModule = false;
    let isConfigPlugin = false;

    const packageRoot = await resolvePackageRootAsync(projectRoot, packageName);
    if (!packageRoot) {
      reasons.push(
        `not found in node_modules, so it is reported as JavaScript only; rerun the classification once it is installed`
      );
    } else {
      const signals = await inspectPackageAsync(packageRoot);
      isNativeModule = hasNativeCode(signals);
      reasons.push(...describeNativeCode(signals));

      if (signals.appPlugin) {
        isConfigPlugin = true;
        reasons.push('ships an app.plugin.js config plugin');
      }
      if (appConfig.plugins.some((plugin) => plugin.packageName === packageName)) {
        isConfigPlugin = true;
        reasons.push(`is listed in the ${appConfig.source} plugins`);
      }
      if (!isNativeModule && !isConfigPlugin) {
        reasons.push('ships no native code and no config plugin');
      }
    }

    // A package can be both; the native module decides the impact, because it is the stronger
    // requirement. Both findings stay in `reasons`.
    const impact: InstallImpact = isNativeModule
      ? 'native-module'
      : isConfigPlugin
        ? 'config-plugin'
        : 'js-only';
    const expoGoBundled = !!bundledNativeModules?.[packageName];

    const report: InstallImpactReport = {
      packageName,
      impact,
      expoGoBundled,
      action: resolveAction({ impact, expoGoBundled, targetsExpoGo, isBare }),
      reasons,
    };
    reports.push(report);
    if (isNativeModule && !isConfigPlugin && !targetsExpoGo) {
      linkedOnly.push(report);
    }
  }

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Sub-features — autolinking links every
  // native module in the dependency graph, so a package another dependency brought in is already
  // in the build. The fingerprint says so; the package list does not.
  const surface =
    linkedOnly.length && fingerprintAcrossInstallAsync
      ? await fingerprintAcrossInstallAsync()
      : null;
  if (surface) {
    for (const report of linkedOnly) {
      applyFingerprint(report, surface);
    }
  }

  return reports;
}

function applyFingerprint(report: InstallImpactReport, surface: FingerprintAcrossInstall): void {
  if (surface.before !== surface.after) {
    report.fingerprint = 'changed';
    report.reasons.push(
      `this install changed the project fingerprint from ${shortHash(surface.before)} to ${shortHash(surface.after)}`
    );
    return;
  }
  report.fingerprint = 'unchanged';
  if (surface.lastBuildHashes.length) {
    report.lastBuild = surface.lastBuildHashes.every((hash) => hash === surface.after)
      ? 'current'
      : 'stale';
  }
  if (report.lastBuild === 'stale') {
    report.reasons.push(
      `this install did not change the project fingerprint ${shortHash(surface.after)}, but the last recorded build was made from another one`
    );
    return;
  }
  report.action = 'reload';
  report.reasons.push(
    `this install did not change the project fingerprint ${shortHash(surface.after)}, so it added no native code`
  );
}

function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

function resolveAction({
  impact,
  expoGoBundled,
  targetsExpoGo,
  isBare,
}: {
  impact: InstallImpact;
  expoGoBundled: boolean;
  targetsExpoGo: boolean;
  isBare: boolean;
}): InstallImpactReport['action'] {
  if (impact === 'js-only') {
    // The dev server serves the new code after a reload; the native runtime is unchanged.
    return 'reload';
  }
  if (expoGoBundled && targetsExpoGo) {
    // The native module is already inside the Expo Go runtime the project runs on.
    return 'reload';
  }
  // Bare projects own their native directories, so CNG must not regenerate them.
  return isBare ? 'native-sync' : 'prebuild-and-build';
}
