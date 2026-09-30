// @ref llp/0028-local-docs.rfc.md §Swap — against a real directory, because renames and symlinks
// are the subject.
import fs from 'fs';
import path from 'path';

import {
  acquireDocsLockAsync,
  docsCacheDir,
  installBundleAsync,
  linkLatestAsync,
  LOCK_FILE,
  readDocPagesAsync,
  readManifestAsync,
  writeManifestAsync,
} from '../cache';
import { cleanupTempDirs, makeTempDir, page, sharedPages, versionPages } from './docsFixtures';

vi.unmock('fs');
vi.unmock('node:fs');

afterEach(() => {
  cleanupTempDirs();
});

describe(docsCacheDir, () => {
  it('uses AGENT_CLI_DOCS_DIR, else the Expo home', () => {
    expect(docsCacheDir({ AGENT_CLI_DOCS_DIR: '/x/docs' })).toBe(path.resolve('/x/docs'));
    expect(docsCacheDir({ __UNSAFE_EXPO_HOME_DIRECTORY: '/home/e' })).toBe(
      path.join('/home/e', 'agent-cli', 'docs')
    );
  });
});

describe(installBundleAsync, () => {
  it('writes one .md file per page, mirroring the site paths', async () => {
    const dir = makeTempDir();
    await installBundleAsync(dir, 'shared', sharedPages);
    await installBundleAsync(dir, 'v57.0.0', versionPages('v57.0.0'));

    expect(fs.readFileSync(path.join(dir, 'index.md'), 'utf8')).toContain('# Home');
    expect(fs.existsSync(path.join(dir, 'guides', 'overview.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'versions', 'v57.0.0', 'sdk', 'camera.md'))).toBe(true);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('replaces a shared bundle, and deletes the folders it no longer has', async () => {
    const dir = makeTempDir();
    await installBundleAsync(dir, 'shared', sharedPages);
    await installBundleAsync(dir, 'v57.0.0', versionPages('v57.0.0'));
    await writeManifestAsync(dir, {
      baseUrl: 'x',
      latest: 'v57.0.0',
      syncedAt: 'now',
      bundles: {},
    });
    fs.writeFileSync(path.join(dir, '.keep'), '');

    await installBundleAsync(dir, 'shared', [
      page('index', 'Home', 'New home.'),
      page('router/intro', 'Router', 'Routes.'),
    ]);

    expect(fs.readFileSync(path.join(dir, 'index.md'), 'utf8')).toContain('New home.');
    expect(fs.existsSync(path.join(dir, 'router', 'intro.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'guides'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'eas'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'versions', 'v57.0.0', 'sdk', 'camera.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.keep'))).toBe(true);
  });

  it('replaces a version bundle without touching the others', async () => {
    const dir = makeTempDir();
    await installBundleAsync(dir, 'v55.0.0', versionPages('v55.0.0'));
    await installBundleAsync(dir, 'v57.0.0', versionPages('v57.0.0'));

    await installBundleAsync(dir, 'v57.0.0', [page('versions/v57.0.0/sdk/video', 'Video', '')]);

    expect(fs.readdirSync(path.join(dir, 'versions', 'v57.0.0', 'sdk'))).toEqual(['video.md']);
    expect(fs.existsSync(path.join(dir, 'versions', 'v55.0.0', 'sdk', 'camera.md'))).toBe(true);
  });

  it('leaves the old files when unpacking fails', async () => {
    const dir = makeTempDir();
    await installBundleAsync(dir, 'shared', sharedPages);

    // `guides/a.md` is a file, so the second page cannot make it a directory.
    await expect(
      installBundleAsync(dir, 'shared', [page('guides/a', 'A', ''), page('guides/a.md/b', 'B', '')])
    ).rejects.toThrow();

    expect(fs.readFileSync(path.join(dir, 'guides', 'overview.md'), 'utf8')).toContain('camera');
    expect(fs.existsSync(path.join(dir, 'guides', 'a.md'))).toBe(false);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('.'))).toEqual([]);
  });
});

describe(linkLatestAsync, () => {
  it('links versions/latest to the latest version, and moves it', async () => {
    const dir = makeTempDir();
    await installBundleAsync(dir, 'v55.0.0', versionPages('v55.0.0'));
    await installBundleAsync(dir, 'v57.0.0', versionPages('v57.0.0'));

    await linkLatestAsync(dir, 'v55.0.0');
    await linkLatestAsync(dir, 'v57.0.0');

    expect(
      fs.readFileSync(path.join(dir, 'versions', 'latest', 'sdk', 'camera.md'), 'utf8')
    ).toContain('Camera of v57.0.0');
  });

  it('makes no link to a version that is not in the cache', async () => {
    const dir = makeTempDir();
    await installBundleAsync(dir, 'v55.0.0', versionPages('v55.0.0'));
    await linkLatestAsync(dir, 'v55.0.0');

    await linkLatestAsync(dir, 'v57.0.0');

    expect(() => fs.lstatSync(path.join(dir, 'versions', 'latest'))).toThrow();
  });
});

describe(readDocPagesAsync, () => {
  it('reads the shared pages and one version, never through versions/latest', async () => {
    const dir = makeTempDir();
    await installBundleAsync(dir, 'shared', sharedPages);
    await installBundleAsync(dir, 'v55.0.0', versionPages('v55.0.0'));
    await installBundleAsync(dir, 'v57.0.0', versionPages('v57.0.0'));
    await linkLatestAsync(dir, 'v57.0.0');
    await writeManifestAsync(dir, { baseUrl: 'x', latest: 'v57.0.0', syncedAt: '', bundles: {} });

    const pages = await readDocPagesAsync(dir, 'v55.0.0');

    expect(pages.map((entry) => entry.path).sort()).toEqual([
      'eas/build',
      'guides/overview',
      'index',
      'versions/v55.0.0/sdk/audio',
      'versions/v55.0.0/sdk/camera',
    ]);
    expect(pages.find((entry) => entry.path === 'index')!.file).toBe(path.join(dir, 'index.md'));
  });
});

describe(readManifestAsync, () => {
  it('reads what was written, and nothing from a broken file', async () => {
    const dir = makeTempDir();
    fs.mkdirSync(dir, { recursive: true });
    const manifest = {
      baseUrl: 'https://x',
      latest: 'v57.0.0' as const,
      syncedAt: '2026-09-30T00:00:00.000Z',
      bundles: { shared: { sha256: 'a', pages: 3 } },
    };
    await writeManifestAsync(dir, manifest);
    expect(await readManifestAsync(dir)).toEqual(manifest);

    fs.writeFileSync(path.join(dir, 'manifest.json'), '{');
    expect(await readManifestAsync(dir)).toBeNull();
  });
});

describe(acquireDocsLockAsync, () => {
  it('makes a second taker wait until the first releases', async () => {
    const dir = makeTempDir();
    const first = await acquireDocsLockAsync(dir);
    const onWait = vi.fn();
    let secondAcquired = false;
    const second = acquireDocsLockAsync(dir, { pollMs: 10, onWait }).then((lock) => {
      secondAcquired = true;
      return lock;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondAcquired).toBe(false);
    expect(onWait).toHaveBeenCalledTimes(1);

    await first.release();
    const lock = await second;
    expect(lock.waited).toBe(true);
    await lock.release();
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
  });

  it('replaces a stale lock', async () => {
    const dir = makeTempDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, LOCK_FILE);
    fs.writeFileSync(file, '1 dead');
    const past = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(file, past, past);

    const lock = await acquireDocsLockAsync(dir);

    expect(lock.waited).toBe(false);
    await lock.release();
  });
});
