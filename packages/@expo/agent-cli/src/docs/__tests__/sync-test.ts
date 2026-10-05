import fs from 'fs';
import path from 'path';

import { readManifestAsync } from '../cache';
import { docsBaseUrl, DEFAULT_DOCS_BUNDLE_URL, syncDocsAsync, type DocsSyncOptions } from '../sync';
import {
  BASE_URL,
  cleanupTempDirs,
  fakeHost,
  makeTempDir,
  page,
  sharedPages,
  type FakeHost,
} from './docsFixtures';

vi.unmock('fs');
vi.unmock('node:fs');

afterEach(() => {
  cleanupTempDirs();
});

function syncWith(host: FakeHost, dir: string, options: Partial<DocsSyncOptions> = {}) {
  return syncDocsAsync({
    dir,
    baseUrl: BASE_URL,
    sdkFlag: undefined,
    projectSdkVersion: null,
    fetch: host.fetch,
    lock: { pollMs: 5 },
    ...options,
  });
}

describe(syncDocsAsync, () => {
  it('downloads the shared pages and the latest version on a first sync', async () => {
    const host = fakeHost();
    const dir = makeTempDir();

    const result = await syncWith(host, dir);

    expect(result).toMatchObject({
      dir,
      sdkDir: path.join(dir, 'versions', 'v57.0.0'),
      selection: { source: 'latest', version: 'v57.0.0' },
      latest: 'v57.0.0',
      baseUrl: BASE_URL,
    });
    expect(result.bundles.map(({ name, status, pages }) => [name, status, pages])).toEqual([
      ['shared', 'downloaded', 3],
      ['v57.0.0', 'downloaded', 2],
    ]);
    expect(host.count('docs-v55.0.0.jsonl.gz')).toBe(0);
    expect(fs.existsSync(path.join(dir, 'guides', 'overview.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'versions', 'latest', 'sdk', 'camera.md'))).toBe(true);
    expect(await readManifestAsync(dir)).toMatchObject({
      baseUrl: BASE_URL,
      latest: 'v57.0.0',
      bundles: {
        shared: { pages: 3, sha256: result.bundles[0]!.sha256 },
        'v57.0.0': { pages: 2 },
      },
    });
  });

  it('fetches the index uncached', async () => {
    const host = fakeHost();
    const spy = vi.fn(host.fetch);
    await syncWith({ ...host, fetch: spy as typeof fetch }, makeTempDir());
    expect(spy).toHaveBeenCalledWith(`${BASE_URL}/index.json`, { cache: 'no-store' });
  });

  it('downloads nothing when the sha256 is unchanged', async () => {
    const host = fakeHost();
    const dir = makeTempDir();
    await syncWith(host, dir);

    const second = await syncWith(host, dir);

    expect(second.bundles.map((bundle) => bundle.status)).toEqual(['unchanged', 'unchanged']);
    expect(host.count('docs-shared.jsonl.gz')).toBe(1);
    expect(host.count('docs-v57.0.0.jsonl.gz')).toBe(1);
    expect(host.count('index.json')).toBe(2);
  });

  it('downloads again with force', async () => {
    const host = fakeHost();
    const dir = makeTempDir();
    await syncWith(host, dir);

    const second = await syncWith(host, dir, { force: true });

    expect(second.bundles.map((bundle) => bundle.status)).toEqual(['downloaded', 'downloaded']);
  });

  it('downloads only the bundle whose sha256 changed', async () => {
    const host = fakeHost();
    const dir = makeTempDir();
    await syncWith(host, dir);
    host.setBundle('shared', [
      page('index', 'Home', 'Changed.'),
      page('router/intro', 'Router', ''),
    ]);

    const second = await syncWith(host, dir);

    expect(second.bundles.map((bundle) => bundle.status)).toEqual(['downloaded', 'unchanged']);
    expect(fs.readFileSync(path.join(dir, 'index.md'), 'utf8')).toContain('Changed.');
    expect(fs.existsSync(path.join(dir, 'guides'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'versions', 'v57.0.0', 'sdk', 'camera.md'))).toBe(true);
  });

  it('keeps two versions side by side', async () => {
    const host = fakeHost();
    const dir = makeTempDir();
    await syncWith(host, dir, { sdkFlag: '55' });
    await syncWith(host, dir, { sdkFlag: '57' });

    expect(fs.existsSync(path.join(dir, 'versions', 'v55.0.0', 'sdk', 'camera.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'versions', 'v57.0.0', 'sdk', 'camera.md'))).toBe(true);
    expect(Object.keys((await readManifestAsync(dir))!.bundles).sort()).toEqual([
      'shared',
      'v55.0.0',
      'v57.0.0',
    ]);
  });

  it(`uses the project's SDK`, async () => {
    const result = await syncWith(fakeHost(), makeTempDir(), { projectSdkVersion: '55.0.3' });
    expect(result.selection).toEqual({
      source: 'project',
      version: 'v55.0.0',
      projectSdkVersion: '55.0.3',
    });
  });

  it('fails on a version without a bundle, and downloads nothing', async () => {
    const host = fakeHost();
    const dir = makeTempDir();

    await expect(syncWith(host, dir, { sdkFlag: '50' })).rejects.toMatchObject({
      code: 'DOCS_SDK_UNAVAILABLE',
    });
    expect(host.requests).toEqual([`${BASE_URL}/index.json`]);
  });

  it('refuses a bundle whose sha256 does not match, and keeps the old cache', async () => {
    const host = fakeHost();
    const dir = makeTempDir();
    await syncWith(host, dir);
    const before = await readManifestAsync(dir);
    host.setBundle('shared', [page('index', 'Home', 'Tampered.')]);
    host.shaOverride.set('docs-shared.jsonl.gz', 'b'.repeat(64));

    await expect(syncWith(host, dir)).rejects.toMatchObject({ code: 'DOCS_CHECKSUM_MISMATCH' });

    expect(fs.readFileSync(path.join(dir, 'index.md'), 'utf8')).toContain('Welcome');
    expect((await readManifestAsync(dir))!.bundles).toEqual(before!.bundles);
    expect(fs.existsSync(path.join(dir, '.lock'))).toBe(false);
  });

  it('keeps the old cache when unpacking fails midway', async () => {
    const host = fakeHost();
    const dir = makeTempDir();
    await syncWith(host, dir);
    const before = await readManifestAsync(dir);
    host.setBundle('shared', [page('guides/a', 'A', ''), page('guides/a.md/b', 'B', '')]);

    await expect(syncWith(host, dir)).rejects.toThrow();

    expect(fs.readFileSync(path.join(dir, 'guides', 'overview.md'), 'utf8')).toContain('camera');
    expect((await readManifestAsync(dir))!.bundles.shared).toEqual(before!.bundles.shared);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('removes what a killed run left behind', async () => {
    const host = fakeHost();
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, '.tmp-99999', 'guides'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.old-99999'), { recursive: true });

    await syncWith(host, dir);

    expect(fs.readdirSync(dir).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('downloads once when two syncs run at the same time', async () => {
    const host = fakeHost();
    const dir = makeTempDir();

    const [first, second] = await Promise.all([syncWith(host, dir), syncWith(host, dir)]);

    expect(host.count('docs-shared.jsonl.gz')).toBe(1);
    expect(host.count('docs-v57.0.0.jsonl.gz')).toBe(1);
    const statuses = [first, second].map((result) => result.bundles[0]!.status).sort();
    expect(statuses).toEqual(['downloaded', 'unchanged']);
  });

  it('refuses a directory that holds other files and no manifest', async () => {
    const dir = makeTempDir();
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
    await expect(syncWith(fakeHost(), dir)).rejects.toMatchObject({ code: 'DOCS_CACHE_NOT_EMPTY' });
    expect(fs.readdirSync(dir)).toEqual(['notes.txt']);
  });

  it('refuses a directory whose manifest.json is not a docs manifest', async () => {
    const dir = makeTempDir();
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"name":"My web app","start_url":"/"}');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');

    await expect(syncWith(fakeHost(), dir)).rejects.toMatchObject({ code: 'DOCS_CACHE_NOT_EMPTY' });
    expect(fs.readdirSync(dir).sort()).toEqual(['manifest.json', 'notes.txt']);
    expect(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).toContain('My web app');
  });

  it('drops a bundle from the manifest while its swap runs, so a failed swap is redone', async () => {
    const host = fakeHost();
    const dir = makeTempDir();
    await syncWith(host, dir);
    host.setBundle('shared', [...sharedPages, page('guides/new', 'New', 'A new page.')]);
    const rename = fs.promises.rename;
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('.tmp-') && String(to) === path.join(dir, 'guides')) {
        throw new Error('killed mid-swap');
      }
      return rename(from, to);
    });

    await expect(syncWith(host, dir)).rejects.toThrow('killed mid-swap');
    spy.mockRestore();
    expect((await readManifestAsync(dir))!.bundles.shared).toBeUndefined();

    const result = await syncWith(host, dir);
    expect(result.bundles.find((bundle) => bundle.name === 'shared')!.status).toBe('downloaded');
    expect(fs.existsSync(path.join(dir, 'guides', 'new.md'))).toBe(true);
  });

  it('repairs a shared bundle whose swap was interrupted', async () => {
    const host = fakeHost();
    const dir = makeTempDir();
    await syncWith(host, dir);
    // The state a kill leaves between the two renames of a swap: the entry parked, the bundle
    // already gone from the manifest.
    const manifest = (await readManifestAsync(dir))!;
    delete manifest.bundles.shared;
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    fs.mkdirSync(path.join(dir, '.old-99999'));
    fs.renameSync(path.join(dir, 'guides'), path.join(dir, '.old-99999', 'guides'));

    const result = await syncWith(host, dir);

    expect(result.bundles.find((bundle) => bundle.name === 'shared')!.status).toBe('downloaded');
    expect(fs.existsSync(path.join(dir, 'guides', 'overview.md'))).toBe(true);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('writes the manifest before the first page, so an interrupted first sync can be retried', async () => {
    const host = fakeHost();
    const dir = makeTempDir();
    const failing = (async (url: string) =>
      String(url).includes('docs-v57')
        ? new Response('', { status: 503 })
        : host.fetch(url)) as typeof fetch;

    await expect(syncWith({ ...host, fetch: failing }, dir)).rejects.toMatchObject({
      code: 'DOCS_FETCH_FAILED',
    });
    expect(await readManifestAsync(dir)).not.toBeNull();

    const result = await syncWith(host, dir);
    expect(result.bundles.map((bundle) => bundle.status)).toEqual(['unchanged', 'downloaded']);
  });

  it('reports a download whose body breaks off with the URL', async () => {
    const host = fakeHost();
    const breaking = (async (url: string) => {
      if (!String(url).endsWith('.gz')) return host.fetch(url);
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([31, 139]));
          controller.error(new Error('socket hang up'));
        },
      });
      return new Response(body);
    }) as typeof fetch;

    await expect(syncWith({ ...host, fetch: breaking }, makeTempDir())).rejects.toMatchObject({
      code: 'DOCS_FETCH_FAILED',
      message: expect.stringContaining('socket hang up'),
    });
  });

  it('names a host without an index as one that publishes no bundles', async () => {
    const missing = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;

    await expect(syncWith({ ...fakeHost(), fetch: missing }, makeTempDir())).rejects.toMatchObject({
      code: 'DOCS_UNAVAILABLE',
      message: expect.stringContaining('AGENT_CLI_DOCS_URL'),
    });
  });

  it('reports an HTTP failure with the URL', async () => {
    const host = fakeHost();
    const failing = (async (url: string) =>
      String(url).endsWith('.gz')
        ? new Response('', { status: 503 })
        : host.fetch(url)) as typeof fetch;

    await expect(syncWith({ ...host, fetch: failing }, makeTempDir())).rejects.toMatchObject({
      code: 'DOCS_FETCH_FAILED',
      message: expect.stringContaining(`${BASE_URL}/docs-shared.jsonl.gz: HTTP 503`),
    });
  });

  it('reports a network failure', async () => {
    const offline = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND docs.test') });
    }) as typeof fetch;

    await expect(syncWith({ ...fakeHost(), fetch: offline }, makeTempDir())).rejects.toMatchObject({
      code: 'DOCS_FETCH_FAILED',
      message: expect.stringContaining('ENOTFOUND'),
    });
  });

  it('keeps the shared pages that link to versions/latest readable', async () => {
    const dir = makeTempDir();
    await syncWith(fakeHost(), dir);
    const link = /versions\/latest\/sdk\/camera/.exec(sharedPages[1]!.content)![0];
    expect(fs.existsSync(path.join(dir, `${link}.md`))).toBe(true);
  });
});

describe(docsBaseUrl, () => {
  it('defaults to the docs site, and takes AGENT_CLI_DOCS_URL without a trailing slash', () => {
    expect(docsBaseUrl({})).toBe(DEFAULT_DOCS_BUNDLE_URL);
    expect(docsBaseUrl({ AGENT_CLI_DOCS_URL: 'http://127.0.0.1:1/x/' })).toBe(
      'http://127.0.0.1:1/x'
    );
  });
});
