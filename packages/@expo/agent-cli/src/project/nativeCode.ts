// @ref llp/0004-smart-start-and-project-state.rfc.md
// Detecting native code from files on disk, for both the Expo Go check and the post-install
// impact classifier. Autolinking would give a more precise answer, but it runs project code and
// needs the packages to be linkable; these signals only need a directory listing.
import fs from 'fs';
import path from 'path';

import { directoryExistsAsync } from '../utils/dir';
import { spawnCaptureAsync } from '../utils/spawnCapture';

/** What a package's own files say about the native surface it adds. */
export interface PackageNativeSignals {
  /** An `ios/` directory. */
  ios: boolean;
  /** An `android/` directory. */
  android: boolean;
  /** An `expo-module.config.json`, so autolinking picks the package up as an Expo module. */
  expoModuleConfig: boolean;
  /** A `*.podspec`, how a React Native library ships iOS code without an `ios/` directory. */
  podspec: boolean;
  /** An `app.plugin.js`, the entry point convention for a config plugin. */
  appPlugin: boolean;
}

const EMPTY_SIGNALS: PackageNativeSignals = {
  ios: false,
  android: false,
  expoModuleConfig: false,
  podspec: false,
  appPlugin: false,
};

/** Read the native-code signals of an installed package from its top-level entries. */
export async function inspectPackageAsync(packageRoot: string): Promise<PackageNativeSignals> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(packageRoot, { withFileTypes: true });
  } catch {
    return { ...EMPTY_SIGNALS };
  }

  const signals = { ...EMPTY_SIGNALS };
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'ios') signals.ios = true;
      if (entry.name === 'android') signals.android = true;
    } else {
      if (entry.name === 'expo-module.config.json') signals.expoModuleConfig = true;
      if (entry.name === 'app.plugin.js') signals.appPlugin = true;
      if (entry.name.endsWith('.podspec')) signals.podspec = true;
    }
  }
  return signals;
}

/** Whether the package adds native code that a prebuilt runtime cannot contain. */
export function hasNativeCode(signals: PackageNativeSignals): boolean {
  return signals.ios || signals.android || signals.expoModuleConfig || signals.podspec;
}

/** One phrase per native-code signal, for the `reasons` of a report. */
export function describeNativeCode(signals: PackageNativeSignals): string[] {
  const reasons: string[] = [];
  if (signals.ios) reasons.push('ships an ios/ directory');
  if (signals.android) reasons.push('ships an android/ directory');
  if (signals.expoModuleConfig) reasons.push('ships an expo-module.config.json');
  if (signals.podspec) reasons.push('ships a podspec');
  return reasons;
}

/** Autolinking's default local-modules directory (`expo.autolinking.nativeModulesDir`). */
export const LOCAL_MODULES_DIR = 'modules';

/**
 * Native projects **checked into the repository**, i.e. bare rather than CNG.
 *
 * Directory existence is not enough: `expo prebuild` writes `ios/` and `android/` that the
 * template `.gitignore` ignores. Those dirs are regenerable and do not mean the app has native
 * code Expo Go lacks. Fingerprint's project workflow uses the same rule — present and not
 * gitignored is `generic`, gitignored or missing is `managed` — without importing it
 * (llp/0001 process boundary).
 *
 * `.gitignore` is read first for the template patterns (`/ios`, `/android`). When those
 * match, `git check-ignore` decides whether the dir is tracked anyway (`git add -f`).
 * A tracked file is not ignored even if `.gitignore` names it.
 */
export async function readProjectNativeDirsAsync(
  projectRoot: string
): Promise<{ ios: boolean; android: boolean }> {
  const [ios, android] = await Promise.all([
    isCheckedInNativeDirAsync(projectRoot, 'ios'),
    isCheckedInNativeDirAsync(projectRoot, 'android'),
  ]);
  return { ios, android };
}

/** Packages under `./modules`, which autolinking links ahead of `node_modules`. */
export async function listLocalModulePackagesAsync(
  projectRoot: string
): Promise<{ name: string; root: string }[]> {
  const modulesRoot = path.join(projectRoot, LOCAL_MODULES_DIR);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(modulesRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const packages: { name: string; root: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const root = path.join(modulesRoot, entry.name);
    const packageJson = await readJsonName(path.join(root, 'package.json'));
    if (packageJson == null) {
      continue;
    }
    packages.push({ name: packageJson, root });
  }
  return packages;
}

/**
 * Whether a `.gitignore` body ignores a native directory at the project root.
 *
 * Only the patterns Expo's template writes (`/ios`, `/android`, and the unanchored forms).
 * Nested or negated rules belong to `git check-ignore`.
 */
export function gitignoreIgnoresNativeDir(contents: string, dirName: 'ios' | 'android'): boolean {
  const matches = new Set([dirName, `${dirName}/`, `/${dirName}`, `/${dirName}/`]);
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) {
      continue;
    }
    if (matches.has(line)) {
      return true;
    }
  }
  return false;
}

async function isCheckedInNativeDirAsync(
  projectRoot: string,
  dirName: 'ios' | 'android'
): Promise<boolean> {
  if (!(await directoryExistsAsync(path.join(projectRoot, dirName)))) {
    return false;
  }

  let gitignored = false;
  try {
    const gitignore = await fs.promises.readFile(path.join(projectRoot, '.gitignore'), 'utf8');
    gitignored = gitignoreIgnoresNativeDir(gitignore, dirName);
  } catch {
    // No .gitignore, or unreadable.
  }

  if (!gitignored) {
    return true;
  }

  // The template gitignore would hide this. Ask git whether the dir is tracked anyway
  // (`git add -f`). Spawn only in that case, so tests that mock `spawn` for simctl/adb
  // and have a bare `ios/` without a gitignore still see a checked-in native project.
  return (await gitCheckIgnoreAsync(projectRoot, dirName)) === 'tracked';
}

/**
 * `git check-ignore -q <dir>` from the project root.
 *
 * Exit 0 is ignored (untracked prebuild output). Exit 1 is not ignored, including a file
 * that is tracked despite matching `.gitignore`. Anything else — no git, not a repo — is
 * unknown, and a gitignored directory is treated as CNG.
 */
async function gitCheckIgnoreAsync(
  projectRoot: string,
  dirName: 'ios' | 'android'
): Promise<'ignored' | 'tracked' | 'unknown'> {
  try {
    const result = await spawnCaptureAsync('git', ['check-ignore', '-q', dirName], {
      cwd: projectRoot,
      timeoutMs: 3_000,
    });
    if (result.spawnError || result.exitCode == null) {
      return 'unknown';
    }
    if (result.exitCode === 0) {
      return 'ignored';
    }
    if (result.exitCode === 1) {
      return 'tracked';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

async function readJsonName(filePath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as { name?: string };
    return typeof parsed.name === 'string' && parsed.name ? parsed.name : null;
  } catch {
    return null;
  }
}
