// Bundles and a fake host for the docs tests. Only for suites that have called `vi.unmock('fs')`.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import type { BundlePage } from '../bundle';

const os = await vi.importActual<typeof import('os')>('os');

export function gzipPages(pages: BundlePage[]): Buffer {
  return zlib.gzipSync(pages.map((page) => JSON.stringify(page)).join('\n') + '\n');
}

export function page(pagePath: string, title: string, body: string): BundlePage {
  return { path: pagePath, title, content: `---\ntitle: ${title}\n---\n# ${title}\n\n${body}\n` };
}

export const sharedPages: BundlePage[] = [
  page('index', 'Home', 'Welcome to the Expo docs.'),
  page(
    'guides/overview',
    'Overview',
    'See [camera](https://docs.expo.dev/versions/latest/sdk/camera).'
  ),
  page('eas/build', 'EAS Build', 'Build your app in the cloud.'),
];

export function versionPages(version: string): BundlePage[] {
  return [
    page(
      `versions/${version}/sdk/camera`,
      'Camera',
      `## Barcode scanning\n\nCamera of ${version}.`
    ),
    page(`versions/${version}/sdk/audio`, 'Audio', `Audio of ${version}.`),
  ];
}

export interface FakeHost {
  files: Map<string, Buffer>;
  /** Overrides the sha256 of a file in `index.json`. */
  shaOverride: Map<string, string>;
  latest: string;
  requests: string[];
  fetch: typeof fetch;
  setBundle(name: string, pages: BundlePage[]): void;
  count(file: string): number;
}

export const BASE_URL = 'https://docs.test/agents';

export function fakeHost(
  versions: string[] = ['v55.0.0', 'v57.0.0'],
  latest = 'v57.0.0'
): FakeHost {
  const host: FakeHost = {
    files: new Map(),
    shaOverride: new Map(),
    latest,
    requests: [],
    setBundle(name, pages) {
      host.files.set(`docs-${name}.jsonl.gz`, gzipPages(pages));
    },
    count(file) {
      return host.requests.filter((url) => url === `${BASE_URL}/${file}`).length;
    },
    fetch: (async (input: string | URL) => {
      const url = String(input);
      host.requests.push(url);
      const file = url.slice(BASE_URL.length + 1);
      if (file === 'index.json') {
        const bundles: Record<string, unknown> = {};
        for (const [name, bytes] of host.files) {
          const bundle = /^docs-(.+)\.jsonl\.gz$/.exec(name)![1]!;
          bundles[bundle] = {
            file: name,
            sha256:
              host.shaOverride.get(name) ?? crypto.createHash('sha256').update(bytes).digest('hex'),
            pages: 0,
          };
        }
        return new Response(
          JSON.stringify({ format: 1, generatedAt: 'now', latest: host.latest, bundles })
        );
      }
      const bytes = host.files.get(file);
      return bytes ? new Response(bytes) : new Response('missing', { status: 404 });
    }) as typeof fetch,
  };
  host.setBundle('shared', sharedPages);
  for (const version of versions) {
    host.setBundle(version, versionPages(version));
  }
  return host;
}

const created: string[] = [];

export function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-docs-'));
  created.push(dir);
  return path.join(dir, 'docs');
}

export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
