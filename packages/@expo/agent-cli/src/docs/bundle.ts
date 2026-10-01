// @ref llp/0028-local-docs.rfc.md §Decisions — the hosted format, parsed at the boundary.
// @ref llp/0028-local-docs.rfc.md §Unpack safety
import path from 'path';
import zlib from 'zlib';

import { CommandError } from '../utils/errors';

export const DOCS_INDEX_FORMAT = 1;

/** A docs version as the site spells it, e.g. `v57.0.0`. */
export type VersionBundleName = `v${number}.0.0`;

/** `shared` holds every page outside `versions/`. */
export type BundleName = 'shared' | VersionBundleName;

export interface BundleEntry {
  file: string;
  sha256: string;
  pages: number;
}

/** `index.json`, format 1. */
export interface DocsIndex {
  format: typeof DOCS_INDEX_FORMAT;
  generatedAt: string;
  latest: VersionBundleName;
  beta: VersionBundleName | null;
  bundles: { shared: BundleEntry } & { [name: VersionBundleName]: BundleEntry };
}

/** One line of a bundle. `path` is the site path without `.md`. */
export interface BundlePage {
  path: string;
  title: string;
  content: string;
}

const VERSION_NAME = /^v(\d+)\.0\.0$/;
const PAGE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const BUNDLE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function isVersionBundleName(value: unknown): value is VersionBundleName {
  return typeof value === 'string' && VERSION_NAME.test(value);
}

export function versionBundleName(major: number | string): VersionBundleName {
  return `v${Number(major)}.0.0` as VersionBundleName;
}

/** The version bundles an index or manifest holds, newest first. */
export function versionNames(bundles: { [name: string]: unknown }): VersionBundleName[] {
  return Object.keys(bundles)
    .filter(isVersionBundleName)
    .sort((a, b) => versionMajor(b) - versionMajor(a));
}

export function versionMajor(name: VersionBundleName): number {
  return Number(VERSION_NAME.exec(name)![1]);
}

function invalidIndex(reason: string): CommandError {
  return new CommandError('DOCS_INDEX_INVALID', `The docs index is not usable: ${reason}.`);
}

function parseBundleEntry(name: string, value: unknown): BundleEntry {
  const entry = value as Partial<BundleEntry> | null;
  if (
    entry == null ||
    typeof entry.file !== 'string' ||
    !BUNDLE_FILE.test(entry.file) ||
    typeof entry.sha256 !== 'string' ||
    !SHA256.test(entry.sha256) ||
    typeof entry.pages !== 'number'
  ) {
    throw invalidIndex(
      `the "${name}" bundle entry needs a plain file name, a sha256 and a page count`
    );
  }
  return { file: entry.file, sha256: entry.sha256, pages: entry.pages };
}

export function parseDocsIndex(value: unknown): DocsIndex {
  const raw = value as Record<string, unknown> | null;
  if (raw == null || typeof raw !== 'object') {
    throw invalidIndex('it is not a JSON object');
  }
  if (raw.format !== DOCS_INDEX_FORMAT) {
    throw invalidIndex(
      `format ${JSON.stringify(raw.format)} is not format ${DOCS_INDEX_FORMAT}, the one this CLI reads. Update @expo/agent-cli`
    );
  }
  if (!isVersionBundleName(raw.latest)) {
    throw invalidIndex('"latest" is not a version such as v57.0.0');
  }
  if (raw.beta != null && !isVersionBundleName(raw.beta)) {
    throw invalidIndex('"beta" is not a version such as v58.0.0');
  }
  const rawBundles = raw.bundles as Record<string, unknown> | null;
  if (rawBundles == null || typeof rawBundles !== 'object') {
    throw invalidIndex('it has no "bundles" object');
  }

  const bundles: Record<string, BundleEntry> = {};
  for (const [name, entry] of Object.entries(rawBundles)) {
    if (name !== 'shared' && !isVersionBundleName(name)) {
      throw invalidIndex(`"${name}" is not a bundle name`);
    }
    bundles[name] = parseBundleEntry(name, entry);
  }
  if (!bundles.shared) {
    throw invalidIndex('it has no "shared" bundle');
  }
  if (!bundles[raw.latest]) {
    throw invalidIndex(`"latest" names ${raw.latest}, which has no bundle`);
  }

  return {
    format: DOCS_INDEX_FORMAT,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    latest: raw.latest,
    beta: raw.beta ?? null,
    bundles: bundles as DocsIndex['bundles'],
  };
}

/** The directory a bundle's pages land in, relative to the cache root. */
export function bundleTargetDir(bundle: BundleName): string {
  return bundle === 'shared' ? '.' : path.join('versions', bundle);
}

/**
 * Reject a page path that would write outside where its bundle belongs.
 *
 * @returns the file of the page, relative to the cache root.
 */
export function pageRelativeFile(pagePath: string, bundle: BundleName): string {
  const reject = (reason: string) =>
    new CommandError(
      'DOCS_BUNDLE_INVALID',
      `The ${bundle} docs bundle has an unsafe page path ${JSON.stringify(pagePath)}: ${reason}.`
    );

  if (!PAGE_PATH.test(pagePath)) {
    throw reject(
      'a path is letters, digits, ".", "_", "-" and "/", and starts with a letter or digit'
    );
  }
  if (
    pagePath.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')
  ) {
    throw reject('it has an empty, "." or ".." segment');
  }
  if (bundle === 'shared') {
    if (pagePath.startsWith('versions/')) {
      throw reject('the shared bundle has no pages under versions/');
    }
  } else if (!pagePath.startsWith(`versions/${bundle}/`)) {
    throw reject(`every page of this bundle is under versions/${bundle}/`);
  }

  const relative = `${pagePath}.md`;
  const root = path.resolve('/', bundleTargetDir(bundle));
  const resolved = path.resolve('/', relative);
  if (!resolved.startsWith(root === path.resolve('/') ? root : root + path.sep)) {
    throw reject('it resolves outside the bundle directory');
  }
  return path.normalize(relative);
}

/** Gunzip one bundle and validate every line of it. */
export function parseBundle(gzipped: Uint8Array, bundle: BundleName): BundlePage[] {
  let text: string;
  try {
    text = zlib.gunzipSync(gzipped).toString('utf8');
  } catch (error: any) {
    throw new CommandError(
      'DOCS_BUNDLE_INVALID',
      `The ${bundle} docs bundle is not gzip data: ${error.message}.`
    );
  }

  const pages: BundlePage[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) {
      continue;
    }
    let value: Partial<BundlePage>;
    try {
      value = JSON.parse(line);
    } catch {
      throw new CommandError(
        'DOCS_BUNDLE_INVALID',
        `The ${bundle} docs bundle has a line that is not JSON (line ${index + 1}).`
      );
    }
    if (
      typeof value?.path !== 'string' ||
      typeof value.title !== 'string' ||
      typeof value.content !== 'string'
    ) {
      throw new CommandError(
        'DOCS_BUNDLE_INVALID',
        `The ${bundle} docs bundle has a line without a path, title and content (line ${index + 1}).`
      );
    }
    pageRelativeFile(value.path, bundle);
    if (seen.has(value.path)) {
      throw new CommandError(
        'DOCS_BUNDLE_INVALID',
        `The ${bundle} docs bundle has the page ${value.path} twice.`
      );
    }
    seen.add(value.path);
    pages.push({ path: value.path, title: value.title, content: value.content });
  }
  return pages;
}
