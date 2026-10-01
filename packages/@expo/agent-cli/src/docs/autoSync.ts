// @ref llp/0028-local-docs.rfc.md §Automatic sync
import chalk from 'chalk';
import { spawn } from 'child_process';
import fs from 'fs';

import * as Log from '../log';
import { readProjectPackageJsonAsync, readSdkVersionAsync } from '../project/nodeModules';
import { env } from '../utils/env';
import { versionMajor, type VersionBundleName } from './bundle';
import { docsCacheDir, readManifestAsync, versionDir } from './cache';
import { docsBaseUrl, isOffline, syncDocsAsync } from './sync';
import { wantedVersion } from './version';

/** What an automatic sync did, for the report of the command that ran it. */
export type DocsAutoSyncResult =
  | { status: 'synced'; sdk: VersionBundleName; dir: string; sdkDir: string; downloaded: boolean }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

/**
 * The project's SDK: the installed `expo`, else the `expo` range in package.json, which is all a
 * project created with `--no-install` has.
 */
export async function projectSdkVersionAsync(projectRoot: string): Promise<string | null> {
  try {
    const installed = await readSdkVersionAsync(projectRoot);
    if (installed) {
      return installed;
    }
    const packageJson = await readProjectPackageJsonAsync(projectRoot);
    const range = packageJson?.dependencies?.expo ?? packageJson?.devDependencies?.expo;
    return /^[\^~]?(\d+(?:\.\d+)*)/.exec(range ?? '')?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Why no automatic sync may run, or null when one may. */
export function autoSyncDisabledReason(): string | null {
  if (env.AGENT_CLI_NO_DOCS_SYNC) {
    return 'AGENT_CLI_NO_DOCS_SYNC is set';
  }
  if (isOffline()) {
    return 'EXPO_OFFLINE is set';
  }
  return null;
}

/** Sync the docs of the project's SDK in this process. Never throws: a failed sync fails nothing else. */
export async function syncDocsForProjectAsync(projectRoot: string): Promise<DocsAutoSyncResult> {
  const disabled = autoSyncDisabledReason();
  if (disabled) {
    return { status: 'skipped', reason: disabled };
  }
  try {
    const result = await syncDocsAsync({
      dir: docsCacheDir(),
      baseUrl: docsBaseUrl(),
      sdkFlag: undefined,
      projectSdkVersion: await projectSdkVersionAsync(projectRoot),
      progress: Log.progress,
    });
    return {
      status: 'synced',
      sdk: result.selection.version,
      dir: result.dir,
      sdkDir: result.sdkDir,
      downloaded: result.bundles.some((bundle) => bundle.status === 'downloaded'),
    };
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Start `docs:sync --sdk <version>` in a detached process, so this command does not wait for it.
 * The cache lock keeps it from colliding with another sync.
 *
 * @returns whether a sync was started.
 */
export function startBackgroundDocsSync(version: VersionBundleName): boolean {
  const bin = process.argv[1];
  if (autoSyncDisabledReason() || !bin) {
    return false;
  }
  try {
    const child = spawn(
      process.execPath,
      [bin, 'docs:sync', '--sdk', String(versionMajor(version)), '--json', '--no-followups'],
      { detached: true, stdio: 'ignore', env: process.env }
    );
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * After an install, fetch the docs of the project's SDK when the cache is in use and lacks them:
 * an SDK upgrade otherwise leaves only the old version's docs to read.
 */
export async function refreshDocsAfterInstallAsync(projectRoot: string): Promise<boolean> {
  try {
    const dir = docsCacheDir();
    const manifest = await readManifestAsync(dir);
    const sdkVersion = await projectSdkVersionAsync(projectRoot);
    if (!manifest || !sdkVersion) {
      return false;
    }
    const wanted = wantedVersion({
      flag: undefined,
      projectSdkVersion: sdkVersion,
      latest: manifest.latest,
    });
    if (manifest.bundles[wanted] && fs.existsSync(versionDir(dir, wanted))) {
      return false;
    }
    return startBackgroundDocsSync(wanted);
  } catch {
    return false;
  }
}

/** One line for the summary of setup or `new`. */
export function docsSummary(docs: DocsAutoSyncResult): string {
  switch (docs.status) {
    case 'synced':
      return `${docs.downloaded ? 'synced' : 'up to date'} (${docs.sdk}, ${docs.sdkDir})`;
    case 'skipped':
      return chalk.dim(`skipped (${docs.reason})`);
    case 'failed':
      return chalk.dim(`failed (${docs.reason})`);
  }
}
