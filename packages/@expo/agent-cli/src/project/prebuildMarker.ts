// @ref llp/0028-installed-app-check.rfc.md §The prebuild marker
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
import { resolveFingerprintCliVersion } from './fingerprintCache';

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

export interface PrebuildSourceChange {
  /** A readable name of the source, such as `app config` or `plugins/withFoo.js`. */
  source: string;
  change: 'added' | 'removed' | 'changed';
  /** Only project sources are named in messages; a dependency path is not something to act on. */
  scope: 'project' | 'dependency';
}

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
  const before = toSourceHashMap(filterPrebuildSources(marker.sources));
  const after = toSourceHashMap(filterPrebuildSources(currentSources));

  const changes: PrebuildSourceChange[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(key);
    const is = after.get(key);
    if (was?.hash === is?.hash) {
      continue;
    }
    changes.push({
      ...describeSource((is ?? was)!.source),
      change: was === undefined ? 'added' : is === undefined ? 'removed' : 'changed',
    });
  }
  changes.sort((a, b) =>
    a.scope === b.scope ? a.source.localeCompare(b.source) : a.scope === 'project' ? -1 : 1
  );
  return { status: changes.length ? 'stale' : 'fresh', changes };
}

export function filterPrebuildSources(sources: FingerprintSource[]): FingerprintSource[] {
  return sources.filter((source) =>
    (source.reasons ?? []).some((reason) => PREBUILD_RELEVANT_REASONS.includes(reason))
  );
}

/**
 * The changed project sources, for a sentence. Dependency sources are left out: they point at code
 * the developer did not write. Empty when nothing nameable changed, so the caller drops the clause.
 */
export function formatPrebuildChanges(changes: PrebuildSourceChange[], max: number = 3): string {
  const project = changes.filter((change) => change.scope === 'project');
  const named = project.slice(0, max).map((change) => change.source);
  const remaining = project.length - named.length;
  return named.join(', ') + (remaining > 0 ? `, and ${remaining} more` : '');
}

function describeSource(source: FingerprintSource): Pick<PrebuildSourceChange, 'source' | 'scope'> {
  if (source.type === 'contents') {
    return {
      source: source.id === 'expoConfig' ? 'app config' : (source.id ?? 'contents'),
      scope: 'project',
    };
  }
  if (source.type === 'package') {
    return { source: `package ${source.name ?? ''}`.trim(), scope: 'dependency' };
  }
  const filePath = source.filePath ?? '';
  return { source: filePath, scope: isDependencyPath(filePath) ? 'dependency' : 'project' };
}

/** A path outside the project: a linked workspace package (`..`) or an installed one. */
function isDependencyPath(filePath: string): boolean {
  const segments = filePath.split(/[\\/]/);
  return segments[0] === '..' || segments.includes('node_modules');
}

/**
 * Index sources by a stable identity. `overrideHashKey` is part of the key when set: it exists to
 * keep a source identifiable when its path varies between environments.
 */
function toSourceHashMap(
  sources: FingerprintSource[]
): Map<string, { hash: string; source: FingerprintSource }> {
  const map = new Map<string, { hash: string; source: FingerprintSource }>();
  for (const source of sources) {
    if (typeof source.hash !== 'string') {
      continue;
    }
    const override = typeof source.overrideHashKey === 'string' ? source.overrideHashKey : null;
    const key =
      source.type === 'contents'
        ? `contents:${source.id}`
        : source.type === 'package'
          ? `package:${override ?? source.name}`
          : `${source.type}:${override ?? source.filePath}`;
    map.set(key, { hash: source.hash, source });
  }
  return map;
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
    } catch {
      // No marker is a valid state. Never fail a prebuild over bookkeeping.
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
