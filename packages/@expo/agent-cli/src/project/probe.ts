// @ref llp/0004-smart-start-and-project-state.rfc.md §Inputs
// The project-state probe: one read of everything the decision table needs. Every field is
// observable from the project itself, so a probe needs no device, no dev server and no network.
import { readAppStateSync } from './expoApp';
import { checkExpoGoCompatibilityAsync } from './expoGo';
import { generateFingerprintAsync } from './fingerprint';
import { readProjectNativeDirsAsync } from './nativeCode';
import {
  isInstalledDependencyAsync,
  listDependencyNames,
  readProjectPackageJsonAsync,
  readSdkVersionAsync,
} from './nodeModules';
import type { ProjectState } from './types';

export interface ProbeOptions {
  /**
   * Whether the fingerprint may be answered out of the project's `.expo` record.
   *
   * Undefined leaves the decision to `AGENT_CLI_NO_FINGERPRINT_CACHE`; false is what
   * `--no-fingerprint-cache` sets, and makes this probe spawn the fingerprint CLI.
   *
   * @see llp/0023-fingerprint-caching.rfc.md
   */
  fingerprintCache?: boolean;
  signal?: AbortSignal;
}

/**
 * Gather the state of a project.
 *
 * Never throws for a missing tool or an unreadable project: a field the probe cannot determine
 * is reported as `null` (with an error for the fingerprint), so an agent always receives a
 * complete state object it can reason about.
 */
export async function probeProjectStateAsync(
  projectRoot: string,
  options: ProbeOptions = {}
): Promise<ProjectState> {
  options.signal?.throwIfAborted();
  const packageJson = await readProjectPackageJsonAsync(projectRoot);
  const dependencyNames = listDependencyNames(packageJson);

  const [sdkVersion, nativeDirs, usesDevClient, hasWeb, expoGo, fingerprint] = await Promise.all([
    readSdkVersionAsync(projectRoot),
    readProjectNativeDirsAsync(projectRoot),
    isInstalledDependencyAsync(projectRoot, dependencyNames, 'expo-dev-client'),
    isInstalledDependencyAsync(projectRoot, dependencyNames, 'react-native-web'),
    checkExpoGoCompatibilityAsync(projectRoot),
    generateFingerprintAsync(projectRoot, {
      cache: options.fingerprintCache,
      signal: options.signal,
    }),
  ]);

  options.signal?.throwIfAborted();
  return {
    projectRoot,
    // @ref llp/0004-smart-start-and-project-state.rfc.md §Not an Expo app — the same read as the
    // stops at the top of a command that acts on the app, which refuse what this describes.
    app: readAppStateSync(projectRoot),
    sdkVersion,
    nativeDirs,
    usesDevClient,
    hasWeb,
    expoGo,
    fingerprint,
  };
}
