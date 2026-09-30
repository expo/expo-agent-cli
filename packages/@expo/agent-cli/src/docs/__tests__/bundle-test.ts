import path from 'path';
import zlib from 'zlib';

import {
  pageRelativeFile,
  parseBundle,
  parseDocsIndex,
  versionNames,
  type BundleName,
} from '../bundle';

const SHA = 'a'.repeat(64);

function gzipLines(lines: unknown[]): Buffer {
  return zlib.gzipSync(lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

function validIndex(overrides: Record<string, unknown> = {}) {
  return {
    format: 1,
    generatedAt: '2026-09-30T12:00:00Z',
    latest: 'v57.0.0',
    beta: 'v58.0.0',
    bundles: {
      shared: { file: 'docs-shared.jsonl.gz', sha256: SHA, pages: 2 },
      'v57.0.0': { file: 'docs-v57.0.0.jsonl.gz', sha256: SHA, pages: 1 },
      'v58.0.0': { file: 'docs-v58.0.0.jsonl.gz', sha256: SHA, pages: 1 },
    },
    ...overrides,
  };
}

describe(parseDocsIndex, () => {
  it('reads format 1', () => {
    const index = parseDocsIndex(validIndex());
    expect(index.latest).toBe('v57.0.0');
    expect(index.beta).toBe('v58.0.0');
    expect(versionNames(index.bundles)).toEqual(['v58.0.0', 'v57.0.0']);
  });

  it('rejects an unknown format', () => {
    expect(() => parseDocsIndex(validIndex({ format: 2 }))).toThrow(/format 2/);
  });

  it.each([
    ['no shared bundle', { bundles: { 'v57.0.0': validIndex().bundles['v57.0.0'] } }],
    ['a latest without a bundle', { latest: 'v99.0.0' }],
    ['a latest that is not a version', { latest: 'latest' }],
    [
      'an unknown bundle name',
      { bundles: { ...validIndex().bundles, latest: validIndex().bundles.shared } },
    ],
    [
      'a bundle file with a directory',
      { bundles: { ...validIndex().bundles, shared: { file: '../x.gz', sha256: SHA, pages: 1 } } },
    ],
    [
      'a sha256 that is not one',
      { bundles: { ...validIndex().bundles, shared: { file: 'x.gz', sha256: 'abc', pages: 1 } } },
    ],
  ])('rejects %s', (_name, overrides) => {
    expect(() => parseDocsIndex(validIndex(overrides))).toThrow(
      expect.objectContaining({ code: 'DOCS_INDEX_INVALID' })
    );
  });
});

describe(parseBundle, () => {
  it('parses every page of a bundle', () => {
    const pages = parseBundle(
      gzipLines([
        { path: 'index', title: 'Home', content: '# Home' },
        { path: 'guides/overview', title: 'Overview', content: '# Overview' },
      ]),
      'shared'
    );
    expect(pages.map((page) => page.path)).toEqual(['index', 'guides/overview']);
  });

  it('rejects data that is not gzip', () => {
    expect(() => parseBundle(Buffer.from('nope'), 'shared')).toThrow(/not gzip/);
  });

  it('rejects a line that is not JSON', () => {
    expect(() => parseBundle(zlib.gzipSync('{"path":'), 'shared')).toThrow(/not JSON/);
  });

  it('rejects a line without content', () => {
    expect(() => parseBundle(gzipLines([{ path: 'index', title: 'Home' }]), 'shared')).toThrow(
      /without a path, title and content/
    );
  });

  it('rejects a page that occurs twice', () => {
    const page = { path: 'index', title: 'Home', content: '' };
    expect(() => parseBundle(gzipLines([page, page]), 'shared')).toThrow(/twice/);
  });
});

describe(pageRelativeFile, () => {
  it('maps a site path to its file', () => {
    expect(pageRelativeFile('index', 'shared')).toBe('index.md');
    expect(pageRelativeFile('guides/overview', 'shared')).toBe(path.join('guides', 'overview.md'));
    expect(pageRelativeFile('versions/v57.0.0/sdk/camera', 'v57.0.0')).toBe(
      path.join('versions', 'v57.0.0', 'sdk', 'camera.md')
    );
  });

  it.each<[string, BundleName]>([
    ['/etc/passwd', 'shared'],
    ['guides/../../etc', 'shared'],
    ['..', 'shared'],
    ['guides\\overview', 'shared'],
    ['Guides/Overview', 'shared'],
    ['.hidden', 'shared'],
    ['guides//overview', 'shared'],
    ['guides/./overview', 'shared'],
    ['', 'shared'],
    ['versions/v57.0.0/sdk/camera', 'shared'],
    ['sdk/camera', 'v57.0.0'],
    ['versions/v56.0.0/sdk/camera', 'v57.0.0'],
    ['versions/v57.0.0/../v56.0.0/sdk', 'v57.0.0'],
    ['versions/latest/sdk/camera', 'v57.0.0'],
  ])('rejects %j in the %s bundle', (pagePath, bundle) => {
    expect(() => pageRelativeFile(pagePath, bundle)).toThrow(
      expect.objectContaining({ code: 'DOCS_BUNDLE_INVALID' })
    );
  });
});
