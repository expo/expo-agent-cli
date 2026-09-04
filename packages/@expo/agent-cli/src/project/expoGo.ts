// @ref llp/0004-smart-start-and-project-state.rfc.md §Sub-features
// "Can this project run in Expo Go?" — answered from files only, with a reason per finding.
//
// Expo Go ships a fixed native runtime. A project can use it only when every native module it
// needs is already inside that runtime (the vendored autolink dump, falling back to
// `expo/bundledNativeModules.json` for an SDK this CLI has not recaptured), no config plugin
// changes the native projects, and no native project is checked in.
import { requireAutolinking } from '../utils/autolinking';
import { readStaticAppConfigAsync } from './appConfig';
import { debugEvent } from './events';
import { dumpCoversSdk, isExpoGoNativeModule } from './expoGoModules';
import {
  describeNativeCode,
  hasNativeCode,
  inspectPackageAsync,
  listLocalModulePackagesAsync,
  readProjectNativeDirsAsync,
} from './nativeCode';
import {
  listDependencyNames,
  loadBundledNativeModulesAsync,
  readProjectPackageJsonAsync,
  readSdkVersionAsync,
  resolvePackageRootAsync,
  type ProjectPackageJson,
} from './nodeModules';
import type { ExpoGoCompatibility, ExpoGoIncompatibility } from './types';

/** One installed package the native-module scan will inspect. */
interface InstalledPackage {
  name: string;
  root: string;
}

/**
 * Check whether a project can run in Expo Go, and why not.
 *
 * Never throws: an unreadable project yields an `unknown-sdk` reason instead of an error, so the
 * probe of {@link import('./probe').probeProjectStateAsync} always returns a full state.
 */
export async function checkExpoGoCompatibilityAsync(
  projectRoot: string
): Promise<ExpoGoCompatibility> {
  const [sdkVersion, bundledNativeModules, packageJson, appConfig, nativeDirs] = await Promise.all([
    readSdkVersionAsync(projectRoot),
    loadBundledNativeModulesAsync(projectRoot),
    readProjectPackageJsonAsync(projectRoot),
    readStaticAppConfigAsync(projectRoot),
    readProjectNativeDirsAsync(projectRoot),
  ]);

  const reasons: ExpoGoIncompatibility[] = [];

  if (sdkVersion == null || (!dumpCoversSdk(sdkVersion) && bundledNativeModules == null)) {
    reasons.push({
      kind: 'unknown-sdk',
      detail:
        sdkVersion == null
          ? `The project has no installed "expo" package, so the SDK version and its Expo Go runtime are unknown. Install the project dependencies and check again.`
          : `This CLI has no Expo Go module dump for SDK ${sdkVersion}, and the installed expo package ships no bundledNativeModules.json, so the modules of its Expo Go runtime are unknown.`,
    });
  }

  const bareDirs = [nativeDirs.ios && 'ios', nativeDirs.android && 'android'].filter(Boolean);
  if (bareDirs.length) {
    reasons.push({
      kind: 'custom-native-code',
      detail: `The project has checked-in native directories (${bareDirs.join(', ')}), which can contain native code that the Expo Go runtime does not have.`,
    });
  }

  const allowlist = { sdkVersion, bundledNativeModules };
  for (const installed of await listInstalledPackagesAsync(projectRoot, packageJson)) {
    if (isExpoGoNativeModule(installed.name, allowlist)) {
      continue;
    }
    const signals = await inspectPackageAsync(installed.root);
    if (!hasNativeCode(signals)) {
      continue;
    }
    reasons.push({
      kind: 'unbundled-native-module',
      packageName: installed.name,
      detail: `${installed.name} contains native code (${describeNativeCode(signals).join(', ')}) and is not bundled in the Expo Go runtime${sdkVersion ? ` of SDK ${sdkVersion}` : ''}.`,
    });
  }

  if (appConfig.dynamic && !appConfig.source) {
    // A dynamic-only config is not evaluated here, so its plugins stay unknown.
    debugEvent('config_plugins_unknown', { reason: 'dynamic-app-config' });
  }
  for (const plugin of appConfig.plugins) {
    // A plugin of a bundled module is accepted: its module is inside the Expo Go runtime. This
    // is deliberately optimistic — a plugin like `expo-build-properties` still changes the
    // native projects, and those changes are absent from Expo Go.
    if (plugin.packageName && bundledNativeModules?.[plugin.packageName]) {
      continue;
    }
    reasons.push({
      kind: 'config-plugin',
      ...(plugin.packageName ? { packageName: plugin.packageName } : null),
      detail: plugin.packageName
        ? `The config plugin "${plugin.id}" comes from ${plugin.packageName}, which is not bundled in the Expo Go runtime, so its native changes are missing there.`
        : `The config plugin "${plugin.id}" is a file in the project, so its native changes only exist in a build you make yourself.`,
    });
  }

  return { compatible: reasons.length === 0, reasons };
}

/**
 * Installed packages to inspect for native code.
 *
 * Prefer the autolinking graph (transitive). Fall back to declared dependencies when the
 * linker cannot load — the ordinary state of a unit test against a virtual filesystem, and of
 * a project whose `expo` package ships no autolinking exports.
 *
 * Always include `./modules`, which autolinking links first and which the npm graph does not
 * contain unless the package is also a `file:` dependency.
 */
async function listInstalledPackagesAsync(
  projectRoot: string,
  packageJson: ProjectPackageJson | null
): Promise<InstalledPackage[]> {
  const fromGraph = await scanAutolinkingGraphAsync(projectRoot);
  const installed = fromGraph.length
    ? fromGraph
    : await listDeclaredPackagesAsync(projectRoot, packageJson);
  const local = await listLocalModulePackagesAsync(projectRoot);
  if (!local.length) {
    return installed;
  }

  const seen = new Set(installed.map((pkg) => pkg.name));
  for (const pkg of local) {
    if (!seen.has(pkg.name)) {
      installed.push(pkg);
      seen.add(pkg.name);
    }
  }
  return installed;
}

async function listDeclaredPackagesAsync(
  projectRoot: string,
  packageJson: ProjectPackageJson | null
): Promise<InstalledPackage[]> {
  const installed: InstalledPackage[] = [];
  for (const name of listDependencyNames(packageJson)) {
    const root = await resolvePackageRootAsync(projectRoot, name);
    if (root) {
      installed.push({ name, root });
    }
  }
  return installed;
}

async function scanAutolinkingGraphAsync(projectRoot: string): Promise<InstalledPackage[]> {
  try {
    const autolinking = requireAutolinking(projectRoot);
    const linker = autolinking.makeCachedDependenciesLinker({ projectRoot });
    const resolutions = await linker.scanDependenciesRecursively();
    const installed: InstalledPackage[] = [];
    for (const resolution of Object.values(resolutions)) {
      if (resolution?.name && resolution.path) {
        installed.push({ name: resolution.name, root: resolution.path });
      }
    }
    return installed;
  } catch {
    return [];
  }
}

/**
 * The reason kinds that **rule Expo Go out**, as opposed to merely counting against it.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §Expo Go is only a target for a project that fits in it
 *
 * Two of the four kinds, and which two is the whole content of this list.
 *
 * `unbundled-native-module` is native code that is not in the runtime, so the app cannot run there.
 * `config-plugin` changes the native projects, and Expo Go is not built from those projects — the
 * check is already deliberately optimistic here, accepting a plugin whose module *is* bundled, so
 * what reaches this point is a plugin whose changes really are absent.
 *
 * The two that are left out are not weaker versions of the same thing; they are different
 * statements. `unknown-sdk` is this check saying it could not read the project — the ordinary state
 * of a fresh clone with no `node_modules`. And `custom-native-code` is a checked-in native directory,
 * which its own `detail` calls out as something that *can* contain native code the runtime lacks: a
 * bare project with no unbundled module still runs in Expo Go, which is exactly the uncertainty
 * {@link import('../navigate/target').ExpoGoDecision.certain} exists to carry. Treating either as
 * decisive would refuse working projects.
 */
const RULES_OUT_EXPO_GO = new Set<ExpoGoIncompatibility['kind']>([
  'unbundled-native-module',
  'config-plugin',
]);

/**
 * Whether the project can run in Expo Go, as a three-valued answer for a caller that must *act*.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §Expo Go is only a target for a project that fits in it
 *
 * {@link ExpoGoCompatibility.compatible} is two-valued and cannot be used for this, because it is
 * `false` for all four reason kinds and only two of them rule Expo Go out
 * (@ref ./expoGo §RULES_OUT_EXPO_GO). A caller that read it directly would refuse a fresh clone and
 * would claim certainty about a bare project, and the unit suites that run against a virtual
 * filesystem caught both [observed, 2026-09-03].
 *
 * `true` means the check read the project and found nothing against it. `null` means "decide from
 * something else": either the project could not be read, or what was found is a reason that counts
 * against Expo Go without settling it.
 */
export function decidesAgainstExpoGo(compatibility: ExpoGoCompatibility): boolean | null {
  if (compatibility.reasons.some((reason) => RULES_OUT_EXPO_GO.has(reason.kind))) {
    return false;
  }
  return compatibility.reasons.length === 0 ? true : null;
}
