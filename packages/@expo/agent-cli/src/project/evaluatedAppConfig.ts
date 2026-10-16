// @ref llp/0011-impact-and-freshness.rfc.md §A fingerprint change is not "OTA-unsafe"
// @ref llp/0023-fingerprint-caching.rfc.md §What a cached hash is revalidated against
//
// Evaluates a dynamic `app.config.js` / `.ts` with `expo config --json --type public`, and
// remembers the answer under `.expo/`, revalidated against the fingerprint record's manifest.

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

export const APP_CONFIG_CACHE_FILE_NAME = 'agent-cli-app-config.json';

/** Bumped when the record's shape changes; an entry from another version is dropped, not migrated. */
export const APP_CONFIG_CACHE_SCHEMA_VERSION = 1;

// A dynamic config can read `process.env` or the date, which no stamp sees; the expiry bounds that.
export const APP_CONFIG_CACHE_TTL_MS = 10 * 60 * 1000;

export const EVALUATED_APP_CONFIG_SOURCE = 'expo config --type public';

export interface EvaluatedAppConfigCache {
  computedAt: string;
  ageMs: number;
  revalidatedAgainst: number;
  keyKind: string;
}

export interface EvaluatedAppConfig {
  config: Record<string, any>;
  source: typeof EVALUATED_APP_CONFIG_SOURCE;
  /** Null when evaluated now. */
  cache: EvaluatedAppConfigCache | null;
}

interface CacheRecord {
  version: number;
  config: Record<string, any>;
  computedAt: string;
  keyManifest: FingerprintKeyManifest;
}

export interface ReadEvaluatedAppConfigOptions {
  /** Whether the record may answer. A refusing run still writes it. Defaults to true. */
  cache?: boolean;
}

/** Never throws. Null when the subprocess could not answer. */
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

async function evaluateAsync(projectRoot: string): Promise<Record<string, any> | null> {
  let result;
  try {
    ({ result } = await spawnExpoAsync(projectRoot, ['config', '--json', '--type', 'public'], {
      output: 'capture',
    }));
  } catch {
    return null;
  }
  if (result.exitCode !== 0 || result.spawnError) {
    return null;
  }
  return parseLastJsonObject(result.stdout);
}

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

// Skips the write when the project moved while it was evaluated (llp/0023 §What invalidates an answer).
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

function getRecordPath(projectRoot: string): string {
  return path.join(projectRoot, '.expo', APP_CONFIG_CACHE_FILE_NAME);
}

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
 * The last JSON line wins: the Expo CLI writes event lines to stdout ahead of the answer. If no
 * single line parses, the whole tail is tried, for a pretty-printed payload.
 */
export function parseLastJsonObject(output: string): Record<string, any> | null {
  const lines = output.split('\n').reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    const parsed = parseObject(trimmed);
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
