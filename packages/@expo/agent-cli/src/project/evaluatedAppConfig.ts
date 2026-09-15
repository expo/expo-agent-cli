// @ref llp/0011-impact-and-freshness.rfc.md §A fingerprint change is not "OTA-unsafe"
// @ref llp/0023-fingerprint-caching.rfc.md §What a cached hash is revalidated against
//
// The app config as the app sees it, for a project whose config is **code**. `app.config.js` and
// `app.config.ts` are evaluated by `expo config --json --type public`, a subprocess that loads the
// Expo CLI and runs the project's own module — about a second, on every run that needs one field
// out of it. A static `app.json` never comes here: it is one file read (`src/project/appConfig.ts`).
//
// The answer is remembered under `.expo/`, revalidated the way the fingerprint record is: against
// the size and modification time of the files that can move it, and never for longer than ten
// minutes. The same manifest, because it already pins every `app.config.*` spelling, `package.json`
// and the lockfile — a superset of what a config can read off disk — and because what the stamps
// cannot see (`process.env`, the date, another file) is the same gap the fingerprint cache already
// names and bounds with the same expiry. A report answered from here says so.

import fs from 'fs';
import path from 'path';

import { debugEvent } from './events';
import {
  buildFingerprintKeyManifestAsync,
  FINGERPRINT_KEY_KIND,
  manifestSize,
  manifestsMatch,
  type FingerprintKeyManifest,
} from './fingerprintKeys';
import { ensureDotExpoProjectDirectoryInitialized } from '../utils/dotExpo';
import { env } from '../utils/env';
import { spawnExpoAsync } from '../utils/expoCli';

/** Name of the record inside the project's `.expo` directory. */
export const APP_CONFIG_CACHE_FILE_NAME = 'agent-cli-app-config.json';

/** Bumped when the record's shape changes; an entry from another version is dropped, not migrated. */
export const APP_CONFIG_CACHE_SCHEMA_VERSION = 1;

/**
 * How long an evaluated config is believed, at most.
 *
 * The fingerprint cache's ten minutes, for the fingerprint cache's reason: a dynamic config can
 * read `process.env`, the date, or a file no sentinel names, and none of that moves a stamp
 * (llp/0023 §What the stamps miss). The expiry is the whole bound on it.
 */
export const APP_CONFIG_CACHE_TTL_MS = 10 * 60 * 1000;

/** What the report names as the source of an evaluated answer, cached or not. */
export const EVALUATED_APP_CONFIG_SOURCE = 'expo config --type public';

/** Where a remembered config came from, so a report never implies it was evaluated now. */
export interface EvaluatedAppConfigCache {
  /** When `expo config` was actually run. */
  computedAt: string;
  /** How old the entry was when it was believed, in milliseconds. */
  ageMs: number;
  /** How many pinned files it was revalidated against. */
  revalidatedAgainst: number;
  /** What kind of check that was — `mtime+size`. */
  keyKind: string;
}

export interface EvaluatedAppConfig {
  /** The public config, as `expo config --type public` printed it. */
  config: Record<string, any>;
  source: typeof EVALUATED_APP_CONFIG_SOURCE;
  /** Set when the answer came out of the record rather than a subprocess. Null when evaluated now. */
  cache: EvaluatedAppConfigCache | null;
}

interface CacheRecord {
  version: number;
  config: Record<string, any>;
  computedAt: string;
  keyManifest: FingerprintKeyManifest;
}

export interface ReadEvaluatedAppConfigOptions {
  /**
   * Whether this call may be answered out of the record. Defaults to true.
   *
   * False is what `--no-fingerprint-cache` and `AGENT_CLI_NO_FINGERPRINT_CACHE` set: the caller wants
   * a measurement. Such a run still *writes* the record, because what it evaluated is the truest
   * thing to put there.
   */
  cache?: boolean;
}

/**
 * The project's public config, evaluated by its own `expo` CLI — or remembered from the last time
 * it was.
 *
 * Never throws. Null when the subprocess could not answer, which the caller reports as no answer
 * rather than as any particular config.
 */
export async function readEvaluatedAppConfigAsync(
  projectRoot: string,
  options: ReadEvaluatedAppConfigOptions = {}
): Promise<EvaluatedAppConfig | null> {
  const cacheAllowed = options.cache ?? !env.AGENT_CLI_NO_FINGERPRINT_CACHE;
  const manifest = await buildFingerprintKeyManifestAsync(projectRoot);

  if (cacheAllowed && manifest.cacheable) {
    const hit = readCache(projectRoot, manifest);
    if (hit) {
      return { config: hit.config, source: EVALUATED_APP_CONFIG_SOURCE, cache: hit.cache };
    }
  }

  const config = await evaluateAsync(projectRoot);
  if (!config) {
    return null;
  }
  if (manifest.cacheable) {
    await writeCacheAsync(projectRoot, config, manifest);
  }
  return { config, source: EVALUATED_APP_CONFIG_SOURCE, cache: null };
}

/** Run `expo config --json --type public` and read the object it printed, or null. */
async function evaluateAsync(projectRoot: string): Promise<Record<string, any> | null> {
  let result;
  try {
    ({ result } = await spawnExpoAsync(projectRoot, ['config', '--json', '--type', 'public'], {
      output: 'capture',
    }));
  } catch {
    // `resolveExpoCli` never throws for a missing bin — it falls back to `npx` — so this only
    // fires on something unexpected, and an unexpected failure here is still just "no answer".
    return null;
  }
  if (result.exitCode !== 0 || result.spawnError) {
    return null;
  }
  return parseLastJsonObject(result.stdout);
}

/** The remembered config, when the project still looks the way it did and the entry is young. */
function readCache(
  projectRoot: string,
  manifest: FingerprintKeyManifest
): { config: Record<string, any>; cache: EvaluatedAppConfigCache } | null {
  const record = readRecord(projectRoot);
  if (!record) {
    return null;
  }
  const age = Date.now() - Date.parse(record.computedAt);
  if (!Number.isFinite(age) || age < 0 || age > APP_CONFIG_CACHE_TTL_MS) {
    return null;
  }
  if (!manifestsMatch(record.keyManifest, manifest)) {
    return null;
  }
  return {
    config: record.config,
    cache: {
      computedAt: record.computedAt,
      ageMs: age,
      revalidatedAgainst: manifestSize(manifest),
      keyKind: FINGERPRINT_KEY_KIND,
    },
  };
}

/**
 * Remember an evaluated config, if the project did not move while it was evaluated.
 *
 * The manifest is read a second time and the write only happens when the two agree — the same
 * hazard the fingerprint record guards against (llp/0023 §What invalidates an answer). Best-effort,
 * like every `.expo` record: a project whose `.expo` cannot be written loses a cache, not an answer.
 */
async function writeCacheAsync(
  projectRoot: string,
  config: Record<string, any>,
  manifest: FingerprintKeyManifest
): Promise<void> {
  const recordPath = getRecordPath(projectRoot);
  const temporaryPath = `${recordPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const after = await buildFingerprintKeyManifestAsync(projectRoot);
    if (!after.cacheable || !manifestsMatch(manifest, after)) {
      debugEvent('app_config_cache_skipped', { reason: 'project changed while evaluating' });
      return;
    }
    const record: CacheRecord = {
      version: APP_CONFIG_CACHE_SCHEMA_VERSION,
      config,
      computedAt: new Date().toISOString(),
      keyManifest: manifest,
    };
    ensureDotExpoProjectDirectoryInitialized(projectRoot);
    // A temporary name and a rename, because a reader is another process running the same command.
    await fs.promises.writeFile(temporaryPath, JSON.stringify(record) + '\n');
    await fs.promises.rename(temporaryPath, recordPath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    debugEvent('app_config_cache_write_failed', { error: debugEvent.error(error as Error) });
  }
}

/** Drop the record, for a project whose config can no longer be what it was. */
export function clearEvaluatedAppConfigCache(projectRoot: string): void {
  try {
    fs.rmSync(getRecordPath(projectRoot), { force: true });
  } catch {
    // A record that could not be removed is one more revalidation, which is what it is for.
  }
}

function getRecordPath(projectRoot: string): string {
  return path.join(projectRoot, '.expo', APP_CONFIG_CACHE_FILE_NAME);
}

/** The record, or null when there is nothing usable on disk. */
function readRecord(projectRoot: string): CacheRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(getRecordPath(projectRoot), 'utf8'));
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== APP_CONFIG_CACHE_SCHEMA_VERSION ||
    record.config == null ||
    typeof record.config !== 'object' ||
    Array.isArray(record.config) ||
    typeof record.computedAt !== 'string' ||
    record.keyManifest == null ||
    typeof record.keyManifest !== 'object'
  ) {
    return null;
  }
  const keyManifest = record.keyManifest as Partial<FingerprintKeyManifest>;
  if (keyManifest.files == null || typeof keyManifest.files !== 'object') {
    return null;
  }
  return {
    version: record.version,
    config: record.config as Record<string, any>,
    computedAt: record.computedAt,
    keyManifest: {
      files: keyManifest.files,
      cacheable: keyManifest.cacheable !== false,
      uncovered: Array.isArray(keyManifest.uncovered) ? keyManifest.uncovered : [],
    },
  };
}

/**
 * The config object on stdout.
 *
 * **The last JSON line wins**, the same rule `parseFingerprint` uses, and for the same reason: the
 * Expo CLI writes its own structured event lines to stdout ahead of the answer, so slicing from the
 * first `{` reads an event and then fails on the rest of the stream. Only if no single line parses
 * is the whole tail tried, which is what reads a pretty-printed payload spanning many lines.
 */
export function parseLastJsonObject(output: string): Record<string, any> | null {
  const lines = output.split('\n').reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    const parsed = parseObject(trimmed);
    // An event line parses too, and it has no `runtimeVersion` — but neither does a config that
    // names none, so the two cannot be told apart here. The *last* line is the answer either way:
    // the CLI prints the payload last, which is the property this depends on and the stub
    // reproduces deliberately.
    if (parsed) {
      return parsed;
    }
  }

  const start = output.indexOf('{');
  return start < 0 ? null : parseObject(output.slice(start));
}

function parseObject(value: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
