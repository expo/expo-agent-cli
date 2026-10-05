// @ref llp/0030-local-docs.rfc.md §Commands — what `docs:sync` and `docs:search` print.
import chalk from 'chalk';
import fs from 'fs';

import {
  buildDocsSyncFollowUps,
  followUpsEnabled,
  reportFollowUps,
  type FollowUp,
} from '../followups';
import * as Log from '../log';
import { PROGRAM_PREFIX } from '../programName';
import { readSdkVersionAsync } from '../project/nodeModules';
import { env } from '../utils/env';
import { CommandError } from '../utils/errors';
import { findUpProjectRootOrCwd } from '../utils/findUp';
import { versionMajor, versionNames, type VersionBundleName } from './bundle';
import {
  docsCacheDir,
  readDocPagesAsync,
  readManifestAsync,
  versionDir,
  type DocsManifest,
} from './cache';
import { searchRegex, searchTerms, type SearchHit } from './search';
import { docsBaseUrl, syncDocsAsync, type BundleSyncReport } from './sync';
import { selectSdkVersion, type SdkSelection } from './version';

const DOCS_SITE = 'https://docs.expo.dev';
const DEFAULT_LIMIT = 20;
const STALE_AFTER_MS = 7 * 24 * 60 * 60_000;
const LABEL_WIDTH = 12;

interface OutputOptions {
  json: boolean;
  followups: boolean;
}

async function projectSdkVersionAsync(): Promise<string | null> {
  try {
    return await readSdkVersionAsync(findUpProjectRootOrCwd(process.cwd()));
  } catch {
    return null;
  }
}

function row(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`;
}

function describeSelection(selection: SdkSelection): string {
  switch (selection.source) {
    case 'explicit':
      return `${selection.version} (--sdk)`;
    case 'project':
      return `${selection.version} (the project's expo ${selection.projectSdkVersion})`;
    case 'latest':
      return `${selection.version} (latest${selection.reason ? '' : ', no Expo project here'})`;
  }
}

function noteSelection(selection: SdkSelection): void {
  if (selection.source === 'latest' && selection.reason) {
    Log.progress(`Note: ${selection.reason}.`);
  }
}

export async function runDocsSyncAsync(
  options: OutputOptions & { sdkFlag: string | undefined; force: boolean }
): Promise<void> {
  const result = await syncDocsAsync({
    dir: docsCacheDir(),
    baseUrl: docsBaseUrl(),
    sdkFlag: options.sdkFlag,
    projectSdkVersion: await projectSdkVersionAsync(),
    force: options.force,
    progress: Log.progress,
  });
  noteSelection(result.selection);

  const followups: FollowUp[] = followUpsEnabled(options.followups)
    ? buildDocsSyncFollowUps({
        sdkMajor:
          result.selection.source === 'explicit' ? versionMajor(result.selection.version) : null,
      })
    : [];

  if (options.json) {
    Log.log(
      JSON.stringify(
        {
          dir: result.dir,
          sdkDir: result.sdkDir,
          sdk: result.selection.version,
          latest: result.latest,
          baseUrl: result.baseUrl,
          bundles: result.bundles,
          followups,
        },
        null,
        2
      )
    );
    return;
  }

  for (const bundle of result.bundles) {
    Log.log(row(bundle.name, formatBundle(bundle)));
  }
  Log.log(row('SDK', describeSelection(result.selection)));
  Log.log('');
  Log.log(chalk.dim('Grep these directories, then read the matching .md files:'));
  Log.log(row('Docs', result.dir));
  Log.log(row('SDK docs', result.sdkDir));
  reportFollowUps('docs:sync', followups);
}

function formatBundle(bundle: BundleSyncReport): string {
  return `${bundle.status.padEnd(12)}${bundle.pages} page${bundle.pages === 1 ? '' : 's'}`;
}

/** The versions the cache holds on disk, newest first. */
function syncedVersions(dir: string, manifest: DocsManifest): VersionBundleName[] {
  return versionNames(manifest.bundles).filter((name) => fs.existsSync(versionDir(dir, name)));
}

function parseLimit(value: string | undefined): number {
  if (value == null) {
    return DEFAULT_LIMIT;
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CommandError(
      'BAD_ARGS',
      `--limit takes a whole number of 1 or more, but got ${value}.`
    );
  }
  return limit;
}

function parseRegex(query: string): RegExp {
  try {
    return new RegExp(query, 'i');
  } catch (error: any) {
    throw new CommandError(
      'BAD_ARGS',
      `The --regex query is not a regular expression: ${error.message}.`
    );
  }
}

/**
 * The version to search, syncing first when the cache lacks the bundles it needs.
 *
 * @ref llp/0030-local-docs.rfc.md §Commands — `EXPO_OFFLINE` searches what is there.
 */
async function resolveSearchScopeAsync(
  dir: string,
  sdkFlag: string | undefined
): Promise<{ selection: SdkSelection; synced: boolean }> {
  const projectSdkVersion = await projectSdkVersionAsync();
  const manifest = await readManifestAsync(dir);
  // The selection sync made, from the versions the host published: an SDK without docs falls back
  // to latest here as it did there, instead of counting as never synced.
  const selection = manifest
    ? selectSdkVersion({
        flag: sdkFlag,
        projectSdkVersion,
        latest: manifest.latest,
        available: manifest.available ?? versionNames(manifest.bundles),
      })
    : null;
  const ready =
    manifest?.bundles.shared != null &&
    selection != null &&
    manifest.bundles[selection.version] != null &&
    fs.existsSync(versionDir(dir, selection.version));

  if (!ready && !env.EXPO_OFFLINE) {
    Log.progress('Syncing the Expo docs first…');
    const result = await syncDocsAsync({
      dir,
      baseUrl: docsBaseUrl(),
      sdkFlag,
      projectSdkVersion,
      progress: Log.progress,
    });
    return { selection: result.selection, synced: true };
  }

  if (!manifest?.bundles.shared || !selection) {
    const error = new CommandError(
      'DOCS_NOT_SYNCED',
      `The Expo docs are not synced to ${dir}, and EXPO_OFFLINE is set, so nothing was downloaded. Run "${PROGRAM_PREFIX} docs:sync" with a network connection first.`
    );
    error.suggestedCommand = `${PROGRAM_PREFIX} docs:sync`;
    throw error;
  }
  if (!ready) {
    // Offline, the project's SDK falls back to a synced one. A version asked for by name does not.
    const synced = syncedVersions(dir, manifest);
    if (sdkFlag != null || !synced.length) {
      const error = new CommandError(
        'DOCS_NOT_SYNCED',
        `The ${selection.version} docs are not synced to ${dir}, and EXPO_OFFLINE is set, so nothing was downloaded. The synced versions are ${synced.join(', ') || 'none'}.`
      );
      error.suggestedCommand = `${PROGRAM_PREFIX} docs:sync --sdk ${versionMajor(selection.version)}`;
      throw error;
    }
    return {
      selection: selectSdkVersion({
        flag: undefined,
        projectSdkVersion,
        latest: synced.includes(manifest.latest) ? manifest.latest : synced[0]!,
        available: synced,
      }),
      synced: false,
    };
  }
  if (Date.now() - Date.parse(manifest.syncedAt) > STALE_AFTER_MS) {
    Log.warn(
      `The local Expo docs were last synced ${manifest.syncedAt.slice(0, 10)}. Run "${PROGRAM_PREFIX} docs:sync" to update them.`
    );
  }
  return { selection, synced: false };
}

export interface DocsSearchHitJson extends SearchHit {
  file: string;
  url: string;
}

export async function runDocsSearchAsync(
  options: OutputOptions & {
    query: string;
    regex: boolean;
    sdkFlag: string | undefined;
    limit: string | undefined;
  }
): Promise<void> {
  // A regular expression is taken as typed: trimming `^ ` would turn it into `^`.
  const query = options.regex ? options.query : options.query.trim();
  if (!query.trim()) {
    const error = new CommandError(
      'BAD_ARGS',
      `Missing query. Usage: ${PROGRAM_PREFIX} docs:search <query>`
    );
    error.suggestedCommand = `${PROGRAM_PREFIX} docs:search --help`;
    throw error;
  }
  const limit = parseLimit(options.limit);
  const pattern = options.regex ? parseRegex(query) : null;

  const dir = docsCacheDir();
  const { selection } = await resolveSearchScopeAsync(dir, options.sdkFlag);
  noteSelection(selection);

  const pages = await readDocPagesAsync(dir, selection.version);
  const files = new Map(pages.map((page) => [page.path, page.file]));
  const found = pattern ? searchRegex(pages, pattern, limit) : searchTerms(pages, query, limit);
  const hits: DocsSearchHitJson[] = found.map((hit) => ({
    path: hit.path,
    file: files.get(hit.path)!,
    url: `${DOCS_SITE}/${hit.path}.md`,
    title: hit.title,
    heading: hit.heading,
    line: hit.line,
    snippet: hit.snippet,
  }));
  const followups: FollowUp[] = [];

  if (options.json) {
    Log.log(JSON.stringify({ dir, sdk: selection.version, query, hits, followups }, null, 2));
    return;
  }

  if (!hits.length) {
    Log.log(
      `No page of the shared docs or the ${selection.version} docs matches ${JSON.stringify(query)}.`
    );
    return;
  }
  for (const hit of hits) {
    Log.log(`${chalk.bold(hit.title)}  ${hit.file}:${hit.line}`);
    Log.log(chalk.dim(`  ${hit.snippet}`));
  }
  reportFollowUps('docs:search', followups);
}
