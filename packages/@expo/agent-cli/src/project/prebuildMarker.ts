// @ref llp/0004-smart-start-and-project-state.rfc.md §The prebuild marker
// What the generated native directories were made from, and whether they are stale now.
//
// This CLI owns the path and the schema, and both writes and reads it: `expo prebuild` records
// nothing, so the write happens in the `prebuild` passthrough, the one place that knows a prebuild
// ran. A prebuild run outside this CLI leaves no marker, which reads as `unknown` — coarser advice,
// never wrong.

import fs from 'fs';
import path from 'path';

import type { NativePlatform } from '../plan/types';
import {
  clearFingerprintMemo,
  generateFingerprintAsync,
  type FingerprintSource,
} from './fingerprint';
import { debugEvent } from './events';
import { resolveFingerprintCliVersion } from './fingerprintCache';
import { diffSources, type SourceChange } from './sourceDiff';

const MARKER_VERSION = 1;

/**
 * The fingerprint source `reasons` that move what `expo prebuild` writes. Other sources
 * (autolinking, patches, `eas.json`, `package.json` scripts) change the build without making the
 * generated directories stale.
 */
export const PREBUILD_RELEVANT_REASONS: readonly string[] = [
  'expoConfig',
  'expoConfigPlugins',
  'expoConfigExternalFile',
  'expoCNGPatches',
];

/** What one platform's native directories were generated from, as `expo prebuild` wrote it. */
export interface PrebuildMarkerEntry {
  hash: string;
  sources: FingerprintSource[] | null;
  /** The `@expo/fingerprint` version that produced `sources`, or null when it could not be read. */
  fingerprintVersion: string | null;
  createdAt: string;
}

/** Named in `sourceDiff`, which both this and the installed-app check share. */
export type PrebuildSourceChange = SourceChange;

export type PrebuildStalenessStatus = 'fresh' | 'stale' | 'unknown';

export interface PrebuildStaleness {
  status: PrebuildStalenessStatus;
  /** The sources that differ from the marker. Empty unless `stale`. */
  changes: PrebuildSourceChange[];
}

export type NativeDirectoryStalenessStatus = PrebuildStalenessStatus | 'not-applicable';

export interface NativeDirectoryStaleness {
  status: NativeDirectoryStalenessStatus;
  changes: PrebuildSourceChange[];
}

/** Where `expo prebuild` records what it generated one platform's native directory from. */
export function getPrebuildMarkerPath(projectRoot: string, platform: NativePlatform): string {
  return path.join(projectRoot, '.expo', 'prebuild', `fingerprint-${platform}.json`);
}

/**
 * Read one platform's marker, or null when there is none to believe.
 *
 * The four rejected fields mirror the writer's own reader exactly, so the two tools agree on what
 * counts as a marker. Never throws: an unreadable marker is no marker.
 */
export function readPrebuildMarker(
  projectRoot: string,
  platform: NativePlatform
): PrebuildMarkerEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(getPrebuildMarkerPath(projectRoot, platform), 'utf8'));
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== MARKER_VERSION ||
    parsed.platform !== platform ||
    typeof parsed.hash !== 'string' ||
    !Array.isArray(parsed.sources)
  ) {
    return null;
  }
  return {
    hash: parsed.hash,
    sources: parsed.sources as FingerprintSource[],
    fingerprintVersion:
      typeof parsed.fingerprintVersion === 'string' ? parsed.fingerprintVersion : null,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
  };
}

/**
 * Staleness of a platform's generated native directory, from the marker.
 *
 * `not-applicable` when the project has no native directory. `unknown` when nothing recorded what
 * generated it, which falls through to the plain rebuild advice.
 */
export function getNativeDirectoryStaleness(
  projectRoot: string,
  platform: NativePlatform,
  current: { sources: FingerprintSource[] | null; fingerprintVersion: string | null }
): NativeDirectoryStaleness {
  if (!fs.existsSync(path.join(projectRoot, platform))) {
    return { status: 'not-applicable', changes: [] };
  }
  return getPrebuildStaleness({
    marker: readPrebuildMarker(projectRoot, platform),
    currentSources: current.sources,
    currentFingerprintVersion: current.fingerprintVersion,
  });
}

/**
 * Compare the prebuild-relevant sources of the marker with the current ones, and name what moved.
 * Only prebuild-relevant sources count, so a new native dependency does not make the directories
 * stale.
 */
export function getPrebuildStaleness({
  marker,
  currentSources,
  currentFingerprintVersion,
}: {
  marker: PrebuildMarkerEntry | null;
  currentSources: FingerprintSource[] | null;
  currentFingerprintVersion: string | null;
}): PrebuildStaleness {
  if (!marker || !marker.sources || !currentSources) {
    return { status: 'unknown', changes: [] };
  }
  // Reason tags and hashing may change between fingerprint versions.
  if (!marker.fingerprintVersion || marker.fingerprintVersion !== currentFingerprintVersion) {
    return { status: 'unknown', changes: [] };
  }
  const changes = diffSources(
    filterPrebuildSources(marker.sources),
    filterPrebuildSources(currentSources)
  );
  changes.sort((a, b) =>
    a.scope === b.scope ? a.source.localeCompare(b.source) : a.scope === 'project' ? -1 : 1
  );
  return { status: changes.length ? 'stale' : 'fresh', changes };
}

export { formatChangedSources as formatPrebuildChanges } from './sourceDiff';

export function filterPrebuildSources(sources: FingerprintSource[]): FingerprintSource[] {
  return sources.filter((source) =>
    (source.reasons ?? []).some((reason) => PREBUILD_RELEVANT_REASONS.includes(reason))
  );
}





function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Record what a successful `expo prebuild` generated the native directories from.
 *
 * Called from the `prebuild` passthrough, because that is the only moment anything here knows a
 * prebuild ran. Best effort throughout: a hash that cannot be computed, or a file that cannot be
 * written, leaves no marker, and no marker reads as `unknown` — never as fresh. A prebuild the
 * developer runs with `npx expo prebuild` instead of through this CLI records nothing, for the
 * same reason.
 *
 * @param args The arguments the command was forwarded with, read only for `--platform`.
 */
export async function recordPrebuildMarkersAsync(
  projectRoot: string,
  args: string[],
  deps: {
    generateFingerprint?: typeof generateFingerprintAsync;
    clearMemo?: typeof clearFingerprintMemo;
  } = {}
): Promise<NativePlatform[]> {
  const generate = deps.generateFingerprint ?? generateFingerprintAsync;
  const clearMemo = deps.clearMemo ?? clearFingerprintMemo;
  // Prebuild just rewrote the native directories, so any hash measured before it is of a project
  // that no longer exists.
  clearMemo(projectRoot);

  const recorded: NativePlatform[] = [];
  for (const platform of platformsToRecord(projectRoot, args)) {
    const fingerprint = await generate(projectRoot, { platform, cache: false });
    if (!fingerprint.hash || !fingerprint.sources) {
      continue;
    }
    const entry = {
      version: MARKER_VERSION,
      platform,
      hash: fingerprint.hash,
      sources: fingerprint.sources,
      fingerprintVersion: resolveFingerprintCliVersion(projectRoot),
      createdAt: new Date().toISOString(),
    };
    const filePath = getPrebuildMarkerPath(projectRoot, platform);
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, JSON.stringify(entry, null, 2));
      recorded.push(platform);
    } catch (error) {
      // No marker is a valid state. Never fail a prebuild over bookkeeping — but say so under
      // EXPO_DEBUG, because a read-only `.expo/` leaves every later check reporting `unknown`
      // with nothing anywhere naming the cause.
      debugEvent('prebuild_marker_write_failed', {
        platform,
        error: debugEvent.error(error as Error),
      });
    }
  }
  return recorded;
}

/**
 * The platforms `prebuild` generated, as far as this can tell.
 *
 * `--platform` narrows what prebuild was asked for; the directory test is what says it exists. A
 * platform asked for but not generated must record nothing, or the marker would describe a
 * directory that is not there.
 */
function platformsToRecord(projectRoot: string, args: string[]): NativePlatform[] {
  const asked = platformArg(args);
  const candidates: NativePlatform[] = asked ? [asked] : ['ios', 'android'];
  return candidates.filter((platform) => fs.existsSync(path.join(projectRoot, platform)));
}

/** The value of `--platform` / `-p`, or null for every other form, including `all`. */
function platformArg(args: string[]): NativePlatform | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const value = arg.startsWith('--platform=')
      ? arg.slice('--platform='.length)
      : arg === '--platform' || arg === '-p'
        ? args[index + 1]
        : null;
    if (value === 'ios' || value === 'android') {
      return value;
    }
  }
  return null;
}
