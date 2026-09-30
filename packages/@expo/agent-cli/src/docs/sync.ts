// @ref llp/0028-local-docs.rfc.md §Decisions — change detection by sha256, and the base URL.
import crypto from 'crypto';
import fs from 'fs';

import { CommandError } from '../utils/errors';
import {
  parseBundle,
  parseDocsIndex,
  versionNames,
  type BundleName,
  type DocsIndex,
  type VersionBundleName,
} from './bundle';
import {
  acquireDocsLockAsync,
  installBundleAsync,
  linkLatestAsync,
  readManifestAsync,
  removeLeftoversAsync,
  versionDir,
  writeManifestAsync,
  type DocsLockOptions,
  type DocsManifest,
} from './cache';
import { selectSdkVersion, type SdkSelection } from './version';

export const DEFAULT_DOCS_BUNDLE_URL = 'https://docs.expo.dev/static/agents';

export function docsBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.AGENT_CLI_DOCS_URL || DEFAULT_DOCS_BUNDLE_URL).replace(/\/+$/, '');
}

/** The same reading of `EXPO_OFFLINE` as `src/device/expoGoVersion.ts`. */
export function isOffline(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EXPO_OFFLINE != null && env.EXPO_OFFLINE !== '0';
}

export interface BundleSyncReport {
  name: BundleName;
  status: 'downloaded' | 'unchanged';
  pages: number;
  sha256: string;
}

export interface DocsSyncResult {
  dir: string;
  sdkDir: string;
  selection: SdkSelection;
  latest: VersionBundleName;
  baseUrl: string;
  bundles: BundleSyncReport[];
}

export interface DocsSyncOptions {
  dir: string;
  baseUrl: string;
  sdkFlag: string | undefined;
  projectSdkVersion: string | null;
  force?: boolean;
  fetch?: typeof fetch;
  progress?: (line: string) => void;
  lock?: DocsLockOptions;
}

function fetchFailed(url: string, reason: string): CommandError {
  return new CommandError(
    'DOCS_FETCH_FAILED',
    `Could not download ${url}: ${reason}. Check the network connection. AGENT_CLI_DOCS_URL overrides where the docs come from.`
  );
}

// Node's fetch honours `cache`, but `@types/node` 22 leaves it out of `RequestInit`.
type FetchInit = RequestInit & { cache?: 'no-store' };

async function fetchBytesAsync(
  url: string,
  fetchImpl: typeof fetch,
  init?: FetchInit
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(url, init as RequestInit);
  } catch (error: any) {
    throw fetchFailed(url, error.cause?.message ?? error.message);
  }
  if (!response.ok) {
    throw fetchFailed(url, `HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function fetchDocsIndexAsync(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<DocsIndex> {
  const url = `${baseUrl}/index.json`;
  const bytes = await fetchBytesAsync(url, fetchImpl, { cache: 'no-store' });
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new CommandError('DOCS_INDEX_INVALID', `The docs index at ${url} is not JSON.`);
  }
  return parseDocsIndex(json);
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Download the shared bundle and the chosen version when their sha256 differs from the manifest.
 *
 * @ref llp/0028-local-docs.rfc.md §Concurrency — the manifest is read after the lock is taken, so a
 * run that waited for another one finds its work done.
 */
export async function syncDocsAsync(options: DocsSyncOptions): Promise<DocsSyncResult> {
  const { dir, baseUrl, force = false, progress = () => {} } = options;
  const fetchImpl = options.fetch ?? fetch;

  const index = await fetchDocsIndexAsync(baseUrl, fetchImpl);
  const selection = selectSdkVersion({
    flag: options.sdkFlag,
    projectSdkVersion: options.projectSdkVersion,
    latest: index.latest,
    available: versionNames(index.bundles),
  });
  const wanted: BundleName[] = ['shared', selection.version];

  const lock = await acquireDocsLockAsync(dir, {
    onWait: () => progress('Waiting for another docs sync to finish…'),
    ...options.lock,
  });
  try {
    await removeLeftoversAsync(dir);
    const manifest: DocsManifest = {
      bundles: {},
      ...(await readManifestAsync(dir)),
      baseUrl,
      latest: index.latest,
      syncedAt: new Date().toISOString(),
    };

    const reports: BundleSyncReport[] = [];
    for (const name of wanted) {
      const entry = index.bundles[name]!;
      const local = manifest.bundles[name];
      const onDisk = name === 'shared' || fs.existsSync(versionDir(dir, name));
      if (!force && onDisk && local?.sha256 === entry.sha256) {
        reports.push({ name, status: 'unchanged', pages: local.pages, sha256: entry.sha256 });
        continue;
      }

      const url = `${baseUrl}/${entry.file}`;
      progress(`Downloading ${url}`);
      const bytes = await fetchBytesAsync(url, fetchImpl);
      const digest = sha256(bytes);
      if (digest !== entry.sha256) {
        throw new CommandError(
          'DOCS_CHECKSUM_MISMATCH',
          `The ${name} docs bundle from ${url} has sha256 ${digest}, but the docs index says ${entry.sha256}. Nothing was unpacked. The files may be mid-upload: run this again in a minute.`
        );
      }
      const pages = parseBundle(bytes, name);
      await installBundleAsync(dir, name, pages);
      manifest.bundles[name] = { sha256: entry.sha256, pages: pages.length };
      await writeManifestAsync(dir, manifest);
      reports.push({ name, status: 'downloaded', pages: pages.length, sha256: entry.sha256 });
    }

    await writeManifestAsync(dir, manifest);
    await linkLatestAsync(dir, index.latest);

    return {
      dir,
      sdkDir: versionDir(dir, selection.version),
      selection,
      latest: index.latest,
      baseUrl,
      bundles: reports,
    };
  } finally {
    await lock.release();
  }
}
