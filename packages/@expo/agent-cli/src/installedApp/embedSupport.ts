// @ref llp/0004-smart-start-and-project-state.rfc.md §What this cannot see
// Whether the project's `expo-constants` embeds `app.fingerprint` in a build at all. 58.0.5 is the
// first version that does (expo/expo#49905). Before that no build carries the file, so there is
// nothing on a device to compare and no rebuild would change that — the check says so instead of
// reading a device.

import fs from 'fs';
import path from 'path';
import semver from 'semver';

import { readJsonFileSync, resolvePackageRootSync } from '../project/nodeModules';

/** The first `expo-constants` release whose build phase writes the file. */
export const FIRST_EMBEDDING_CONSTANTS_VERSION = '58.0.5';

export interface FingerprintEmbedSupport {
  supported: boolean;
  /** The `expo-constants` version the project resolves, or null when it is not installed. */
  version: string | null;
}

/**
 * Read off the installed package. Two lookups, the way `resolveFingerprintCliVersion` does it:
 * from the project, then from beside `expo`, which is where pnpm's isolated store keeps a
 * transitive dependency. A prerelease sorts below its release, so a canary older than 58.0.5
 * reads as unsupported — the conservative answer.
 */
export function readFingerprintEmbedSupport(projectRoot: string): FingerprintEmbedSupport {
  const root =
    resolvePackageRootSync(projectRoot, 'expo-constants') ?? resolveBesideExpo(projectRoot);
  const manifest = root
    ? readJsonFileSync<{ version?: unknown }>(path.join(root, 'package.json'))
    : null;
  const version =
    typeof manifest?.version === 'string' && manifest.version ? manifest.version : null;
  return {
    supported:
      version != null &&
      semver.valid(version) != null &&
      semver.gte(version, FIRST_EMBEDDING_CONSTANTS_VERSION),
    version,
  };
}

function resolveBesideExpo(projectRoot: string): string | null {
  const expoRoot = resolvePackageRootSync(projectRoot, 'expo');
  if (!expoRoot) {
    return null;
  }
  let realRoot = expoRoot;
  try {
    realRoot = fs.realpathSync(expoRoot);
  } catch {
    // Unresolvable (a broken link): the path is used as-is, like `realPathOrSelf` in fingerprintCache.
  }
  return resolvePackageRootSync(realRoot, 'expo-constants');
}
