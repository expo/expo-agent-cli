// @ref llp/0028-local-docs.rfc.md §Local cache
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { CommandError } from '../utils/errors';
import { expoHomeDirectory } from '../utils/expoHome';
import {
  bundleTargetDir,
  isVersionBundleName,
  pageRelativeFile,
  type BundleName,
  type BundlePage,
  type VersionBundleName,
} from './bundle';
import type { DocPage } from './search';

export const MANIFEST_FILE = 'manifest.json';
export const LOCK_FILE = '.lock';
export const DOCS_LOCK_STALE_MS = 10 * 60_000;

export interface ManifestBundle {
  sha256: string;
  pages: number;
}

/** `manifest.json`: what the cache holds. Written after each bundle. */
export interface DocsManifest {
  baseUrl: string;
  latest: VersionBundleName;
  syncedAt: string;
  bundles: { [name in BundleName]?: ManifestBundle };
}

export function docsCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_CLI_DOCS_DIR
    ? path.resolve(env.AGENT_CLI_DOCS_DIR)
    : path.join(expoHomeDirectory(env), 'agent-cli', 'docs');
}

export function versionDir(dir: string, version: VersionBundleName): string {
  return path.join(dir, 'versions', version);
}

/** The manifest, or null when there is none or it cannot be read: then nothing counts as synced. */
export async function readManifestAsync(dir: string): Promise<DocsManifest | null> {
  let raw: any;
  try {
    raw = JSON.parse(await fs.promises.readFile(path.join(dir, MANIFEST_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (
    raw == null ||
    typeof raw.baseUrl !== 'string' ||
    !isVersionBundleName(raw.latest) ||
    typeof raw.syncedAt !== 'string' ||
    raw.bundles == null ||
    typeof raw.bundles !== 'object'
  ) {
    return null;
  }
  const bundles: DocsManifest['bundles'] = {};
  for (const [name, entry] of Object.entries(raw.bundles as Record<string, any>)) {
    if (
      (name === 'shared' || isVersionBundleName(name)) &&
      typeof entry?.sha256 === 'string' &&
      typeof entry?.pages === 'number'
    ) {
      bundles[name] = { sha256: entry.sha256, pages: entry.pages };
    }
  }
  return { baseUrl: raw.baseUrl, latest: raw.latest, syncedAt: raw.syncedAt, bundles };
}

export async function writeManifestAsync(dir: string, manifest: DocsManifest): Promise<void> {
  const file = path.join(dir, MANIFEST_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n');
  await fs.promises.rename(tmp, file);
}

export interface DocsLockOptions {
  staleMs?: number;
  pollMs?: number;
  /** Called once when another run holds the lock. */
  onWait?: () => void;
}

export interface DocsLock {
  /** Whether another run held the lock first. */
  waited: boolean;
  release(): Promise<void>;
}

/** Take `.lock` by exclusive create. A lock older than `staleMs` belongs to a run that died. */
export async function acquireDocsLockAsync(
  dir: string,
  { staleMs = DOCS_LOCK_STALE_MS, pollMs = 200, onWait }: DocsLockOptions = {}
): Promise<DocsLock> {
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  const token = `${process.pid} ${crypto.randomUUID()}`;
  let waited = false;

  for (;;) {
    try {
      const handle = await fs.promises.open(file, 'wx');
      try {
        await handle.writeFile(token);
      } finally {
        await handle.close();
      }
      return {
        waited,
        async release() {
          const holder = await fs.promises.readFile(file, 'utf8').catch(() => null);
          if (holder === token) {
            await fs.promises.rm(file, { force: true });
          }
        },
      };
    } catch (error: any) {
      if (error.code !== 'EEXIST') {
        throw new CommandError(
          'DOCS_CACHE_UNWRITABLE',
          `Could not lock the docs cache at ${dir}: ${error.message}. Set AGENT_CLI_DOCS_DIR to a writable directory.`
        );
      }
    }

    const stat = await fs.promises.stat(file).catch(() => null);
    const holder = await fs.promises.readFile(file, 'utf8').catch(() => '');
    if ((stat && Date.now() - stat.mtimeMs > staleMs) || holderIsGone(holder)) {
      await fs.promises.rm(file, { force: true });
      continue;
    }
    if (!waited) {
      waited = true;
      onWait?.();
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Whether the run named in a lock file has exited, as after Ctrl-C or a closed pipe. Its lock
 * then goes at once, not after `staleMs`. A process this user cannot signal (EPERM) is alive.
 */
function holderIsGone(holder: string): boolean {
  const pid = Number(holder.split(' ')[0]);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: any) {
    return error.code === 'ESRCH';
  }
}

/** Remove what a killed run left behind. Only call it while holding the lock. */
export async function removeLeftoversAsync(dir: string): Promise<void> {
  const entries = await fs.promises.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter(
        (name) =>
          name.startsWith('.tmp-') ||
          name.startsWith('.old-') ||
          /^manifest\.json\..*\.tmp$/.test(name)
      )
      .map((name) => fs.promises.rm(path.join(dir, name), { recursive: true, force: true }))
  );
}

async function existsAsync(file: string): Promise<boolean> {
  return fs.promises.lstat(file).then(
    () => true,
    () => false
  );
}

/** Put `source` at `target`, whether or not `target` exists, keeping the old one until it is replaced. */
async function swapEntryAsync(source: string, target: string, parked: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(parked), { recursive: true });
  const hadOld = await existsAsync(target);
  if (hadOld) {
    await fs.promises.rename(target, parked);
  }
  try {
    await fs.promises.rename(source, target);
  } catch (error) {
    if (hadOld) {
      await fs.promises.rename(parked, target);
    }
    throw error;
  }
  await fs.promises.rm(parked, { recursive: true, force: true });
}

/**
 * Unpack one bundle into a temporary directory, then swap it in one top-level entry at a time.
 * Only call it while holding the lock.
 *
 * @ref llp/0028-local-docs.rfc.md §Swap
 */
export async function installBundleAsync(
  dir: string,
  bundle: BundleName,
  pages: BundlePage[]
): Promise<void> {
  const tmp = path.join(dir, `.tmp-${process.pid}`);
  const parked = path.join(dir, `.old-${process.pid}`);
  await fs.promises.rm(tmp, { recursive: true, force: true });
  await fs.promises.mkdir(path.join(tmp, bundleTargetDir(bundle)), { recursive: true });

  try {
    for (const page of pages) {
      const file = path.join(tmp, pageRelativeFile(page.path, bundle));
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, page.content);
    }

    if (bundle !== 'shared') {
      await fs.promises.mkdir(path.join(dir, 'versions'), { recursive: true });
      await swapEntryAsync(
        path.join(tmp, bundleTargetDir(bundle)),
        versionDir(dir, bundle),
        path.join(parked, bundle)
      );
      return;
    }

    const entries = await fs.promises.readdir(tmp);
    for (const name of entries) {
      await swapEntryAsync(path.join(tmp, name), path.join(dir, name), path.join(parked, name));
    }
    const current = await fs.promises.readdir(dir);
    for (const name of current) {
      if (
        !name.startsWith('.') &&
        name !== 'versions' &&
        name !== MANIFEST_FILE &&
        !entries.includes(name)
      ) {
        await fs.promises.rm(path.join(dir, name), { recursive: true, force: true });
      }
    }
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
    await fs.promises.rm(parked, { recursive: true, force: true });
  }
}

/**
 * Point `versions/latest` at the latest version, so the `versions/latest/...` links of shared pages
 * resolve. Without that version in the cache there is no link: a dangling one reads as a directory.
 */
export async function linkLatestAsync(dir: string, latest: VersionBundleName): Promise<void> {
  const link = path.join(dir, 'versions', 'latest');
  await fs.promises.unlink(link).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!(await existsAsync(versionDir(dir, latest)))) {
    return;
  }
  if (process.platform === 'win32') {
    await fs.promises.symlink(versionDir(dir, latest), link, 'junction');
  } else {
    await fs.promises.symlink(latest, link, 'dir');
  }
}

/** Every page in the search scope: all of the cache outside `versions/`, plus `versions/<version>/`. */
export async function readDocPagesAsync(
  dir: string,
  version: VersionBundleName
): Promise<(DocPage & { file: string })[]> {
  const files: { path: string; file: string }[] = [];

  async function walk(absolute: string, relative: string): Promise<void> {
    const entries = await fs.promises.readdir(absolute, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (!relative && entry.name === 'versions') {
        await walk(versionDir(dir, version), `versions/${version}`);
      } else if (entry.isDirectory()) {
        await walk(path.join(absolute, entry.name), childRelative);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push({
          path: childRelative.slice(0, -'.md'.length),
          file: path.join(absolute, entry.name),
        });
      }
    }
  }

  await walk(dir, '');
  return await Promise.all(
    files.map(async ({ path: pagePath, file }) => ({
      path: pagePath,
      file,
      content: await fs.promises.readFile(file, 'utf8'),
    }))
  );
}
