// @ref llp/0030-local-docs.rfc.md §Testing
//
// `docs:sync` and `docs:search` through the built CLI, against a local host that serves an
// `index.json` and small bundles built here. The bundles are behind a redirect, the way a release
// asset is, so the download follows one and records only the base URL.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  documentedJsonKeys,
  executeAgentCliAsync,
  getTemporaryPath,
  setupFixtureAsync,
} from '../utils';

interface Page {
  path: string;
  title: string;
  content: string;
}

function page(pagePath: string, title: string, body: string): Page {
  return { path: pagePath, title, content: `---\ntitle: ${title}\n---\n# ${title}\n\n${body}\n` };
}

function versionPages(version: string): Page[] {
  return [
    page(
      `versions/${version}/sdk/camera`,
      'Camera',
      `## Barcode scanning\n\nThe ${version} camera does barcode scanning. Call launchScanner() to start.`
    ),
  ];
}

const BUNDLES: Record<string, Page[]> = {
  shared: [
    page('index', 'Home', 'Welcome to the Expo docs.'),
    page('guides/overview', 'Overview', 'Read about the [camera](/versions/latest/sdk/camera).'),
  ],
  'v54.0.0': versionPages('v54.0.0'),
  'v57.0.0': versionPages('v57.0.0'),
};

let server: Server;
let baseUrl: string;
const requests: string[] = [];
const files = new Map<string, Buffer>();
const index = {
  format: 1,
  generatedAt: '2026-09-30T12:00:00Z',
  latest: 'v57.0.0',
  bundles: {} as Record<string, unknown>,
};

/** Put a bundle on the host, as a docs deploy would. Returns the undo. */
function publish(name: string, pages: Page[]): () => void {
  const bytes = zlib.gzipSync(pages.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const file = `docs-${name}.jsonl.gz`;
  files.set(file, bytes);
  index.bundles[name] = {
    file,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    pages: pages.length,
  };
  return () => {
    files.delete(file);
    delete index.bundles[name];
  };
}

beforeAll(async () => {
  for (const [name, pages] of Object.entries(BUNDLES)) {
    publish(name, pages);
  }

  server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push(url);
    if (url === '/agents/index.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(index));
      return;
    }
    const redirected = /^\/agents\/(docs-[^/]+\.jsonl\.gz)$/.exec(url);
    if (redirected) {
      response.writeHead(302, { location: `/signed/${redirected[1]}?expires=1` });
      response.end();
      return;
    }
    const signed = /^\/signed\/(docs-[^/?]+\.jsonl\.gz)\?expires=1$/.exec(url);
    const bytes = signed && files.get(signed[1]!);
    if (bytes) {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(bytes);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agents`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

let cwd: string;
let docsDir: string;

beforeEach(async () => {
  requests.length = 0;
  const root = getTemporaryPath();
  cwd = path.join(root, 'not-a-project');
  docsDir = path.join(root, 'docs');
  await fs.promises.mkdir(cwd, { recursive: true });
});

function docsEnv(extra: Record<string, string> = {}) {
  return { env: { AGENT_CLI_DOCS_URL: baseUrl, AGENT_CLI_DOCS_DIR: docsDir, ...extra } };
}

function bundleDownloads(): string[] {
  return requests.filter((url) => url.startsWith('/signed/'));
}

describe('docs:sync', () => {
  it('names AGENT_CLI_DOCS_URL when the host publishes no bundles', async () => {
    const result = await executeAgentCliAsync(cwd, ['docs:sync', '--json'], {
      env: { AGENT_CLI_DOCS_URL: `${baseUrl}/missing`, AGENT_CLI_DOCS_DIR: docsDir },
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({ code: 'DOCS_UNAVAILABLE' });
    expect(fs.existsSync(docsDir)).toBe(false);
  });

  it('downloads the shared docs and the latest SDK outside a project, and prints the directories', async () => {
    const result = await executeAgentCliAsync(cwd, ['docs', 'sync', '--json'], docsEnv());
    const report = JSON.parse(result.stdout);

    expect(report).toMatchObject({
      dir: docsDir,
      sdkDir: path.join(docsDir, 'versions', 'v57.0.0'),
      sdk: 'v57.0.0',
      latest: 'v57.0.0',
      baseUrl,
    });
    expect(report.bundles.map((bundle: any) => [bundle.name, bundle.status, bundle.pages])).toEqual(
      [
        ['shared', 'downloaded', 2],
        ['v57.0.0', 'downloaded', 1],
      ]
    );
    expect(report.followups.map((followup: any) => followup.id)).toEqual(['docs-search']);
    expect(fs.existsSync(path.join(docsDir, 'guides', 'overview.md'))).toBe(true);
    expect(fs.existsSync(path.join(docsDir, 'versions', 'latest', 'sdk', 'camera.md'))).toBe(true);
    expect(result.stderr).toContain('Downloading');

    const manifest = JSON.parse(fs.readFileSync(path.join(docsDir, 'manifest.json'), 'utf8'));
    expect(manifest.baseUrl).toBe(baseUrl);
    expect(JSON.stringify(manifest)).not.toContain('/signed/');
  });

  it('downloads nothing on a second sync', async () => {
    await executeAgentCliAsync(cwd, ['docs:sync'], docsEnv());
    expect(bundleDownloads()).toHaveLength(2);

    const second = await executeAgentCliAsync(cwd, ['docs:sync', '--json'], docsEnv());

    expect(JSON.parse(second.stdout).bundles.map((bundle: any) => bundle.status)).toEqual([
      'unchanged',
      'unchanged',
    ]);
    expect(bundleDownloads()).toHaveLength(2);
  });

  it(`picks the project's SDK`, async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    const result = await executeAgentCliAsync(projectRoot, ['docs:sync', '--json'], docsEnv());

    expect(JSON.parse(result.stdout).sdk).toBe('v54.0.0');
    expect(fs.existsSync(path.join(docsDir, 'versions', 'v54.0.0', 'sdk', 'camera.md'))).toBe(true);
  });

  it('prints the two directories to grep as its last report lines', async () => {
    const result = await executeAgentCliAsync(cwd, ['docs:sync', '--no-followups'], docsEnv());
    const lines = result.stdout.trim().split('\n');

    expect(lines.at(-2)).toBe(`Docs        ${docsDir}`);
    expect(lines.at(-1)).toBe(`SDK docs    ${path.join(docsDir, 'versions', 'v57.0.0')}`);
  });

  it('fails on an SDK without docs, naming the ones that exist', async () => {
    const result = await executeAgentCliAsync(cwd, ['docs:sync', '--sdk', '50', '--json'], {
      ...docsEnv(),
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: 'DOCS_SDK_UNAVAILABLE',
      message: expect.stringContaining('v57.0.0, v54.0.0'),
    });
    expect(bundleDownloads()).toEqual([]);
  });

  it('documents exactly the keys it emits', async () => {
    const help = await executeAgentCliAsync(cwd, ['docs:sync', '--help']);
    const report = await executeAgentCliAsync(cwd, ['docs:sync', '--json'], docsEnv());

    expect(documentedJsonKeys(help.stdout).sort()).toEqual(
      Object.keys(JSON.parse(report.stdout)).sort()
    );
  });
});

describe('docs:search', () => {
  it('asks the host again for an SDK newer than the last sync knew', async () => {
    await executeAgentCliAsync(cwd, ['docs:sync'], docsEnv());
    const unpublish = publish('v58.0.0', versionPages('v58.0.0'));
    try {
      const result = await executeAgentCliAsync(
        cwd,
        ['docs:search', 'camera', '--sdk', '58', '--json'],
        docsEnv()
      );

      expect(JSON.parse(result.stdout).sdk).toBe('v58.0.0');
      expect(bundleDownloads()).toContain('/signed/docs-v58.0.0.jsonl.gz?expires=1');
    } finally {
      unpublish();
    }
  });

  it(`asks the host again for a newer project SDK only when the last sync is over an hour old`, async () => {
    const project = path.join(path.dirname(cwd), 'new-sdk-app');
    await fs.promises.mkdir(path.join(project, 'node_modules', 'expo'), { recursive: true });
    await fs.promises.writeFile(
      path.join(project, 'package.json'),
      JSON.stringify({ name: 'new-sdk-app', dependencies: { expo: '~58.0.0' } })
    );
    await fs.promises.writeFile(
      path.join(project, 'node_modules', 'expo', 'package.json'),
      JSON.stringify({ name: 'expo', version: '58.0.1' })
    );
    await executeAgentCliAsync(project, ['docs:sync'], docsEnv());
    const unpublish = publish('v58.0.0', versionPages('v58.0.0'));
    try {
      requests.length = 0;
      const recent = await executeAgentCliAsync(
        project,
        ['docs:search', 'camera', '--json'],
        docsEnv()
      );
      expect(JSON.parse(recent.stdout).sdk).toBe('v57.0.0');
      expect(requests).toEqual([]);

      const manifestFile = path.join(docsDir, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, syncedAt: twoHoursAgo }));

      const later = await executeAgentCliAsync(
        project,
        ['docs:search', 'camera', '--json'],
        docsEnv()
      );
      expect(JSON.parse(later.stdout).sdk).toBe('v58.0.0');
    } finally {
      unpublish();
    }
  });

  it('searches the synced latest docs of a project whose SDK has none, without asking the host again', async () => {
    const project = path.join(path.dirname(cwd), 'old-sdk-app');
    await fs.promises.mkdir(path.join(project, 'node_modules', 'expo'), { recursive: true });
    await fs.promises.writeFile(
      path.join(project, 'package.json'),
      JSON.stringify({ name: 'old-sdk-app', dependencies: { expo: '~50.0.0' } })
    );
    await fs.promises.writeFile(
      path.join(project, 'node_modules', 'expo', 'package.json'),
      JSON.stringify({ name: 'expo', version: '50.0.3' })
    );
    await executeAgentCliAsync(project, ['docs:sync'], docsEnv());
    requests.length = 0;

    const result = await executeAgentCliAsync(
      project,
      ['docs:search', 'camera', '--json'],
      docsEnv()
    );

    expect(JSON.parse(result.stdout).sdk).toBe('v57.0.0');
    expect(requests).toEqual([]);
  });

  it('downloads on a first search with EXPO_OFFLINE=false', async () => {
    const result = await executeAgentCliAsync(
      cwd,
      ['docs:search', 'camera', '--json'],
      docsEnv({ EXPO_OFFLINE: 'false' })
    );

    expect(JSON.parse(result.stdout).hits.length).toBeGreaterThan(0);
    expect(bundleDownloads().length).toBeGreaterThan(0);
  });

  it('takes a --regex query as typed, whitespace included', async () => {
    await executeAgentCliAsync(cwd, ['docs:sync'], docsEnv());

    const result = await executeAgentCliAsync(
      cwd,
      ['docs:search', '--regex', '^ ', '--json'],
      docsEnv()
    );
    const report = JSON.parse(result.stdout);

    expect(report.query).toBe('^ ');
    expect(report.hits.every((hit: { snippet: string }) => !hit.snippet.startsWith('#'))).toBe(
      true
    );
  });

  it('syncs first when nothing is synced, then ranks the pages', async () => {
    const result = await executeAgentCliAsync(
      cwd,
      ['docs', 'search', 'barcode', 'scanning', '--json'],
      docsEnv()
    );
    const report = JSON.parse(result.stdout);

    expect(result.stderr).toContain('Syncing the Expo docs first');
    expect(report).toMatchObject({ dir: docsDir, sdk: 'v57.0.0', query: 'barcode scanning' });
    expect(report.hits).toEqual([
      {
        path: 'versions/v57.0.0/sdk/camera',
        file: path.join(docsDir, 'versions', 'v57.0.0', 'sdk', 'camera.md'),
        url: 'https://docs.expo.dev/versions/v57.0.0/sdk/camera.md',
        title: 'Camera',
        heading: 'Barcode scanning',
        line: 6,
        snippet: '## Barcode scanning',
      },
    ]);
    const lines = fs.readFileSync(report.hits[0].file, 'utf8').split('\n');
    expect(lines[report.hits[0].line - 1]).toBe('## Barcode scanning');
  });

  it('greps lines with --regex, in the version it is asked for', async () => {
    await executeAgentCliAsync(cwd, ['docs:sync', '--sdk', '54'], docsEnv());

    const result = await executeAgentCliAsync(
      cwd,
      ['docs:search', '--regex', 'launchScanner\\(', '--sdk', '54'],
      docsEnv()
    );

    const file = path.join(docsDir, 'versions', 'v54.0.0', 'sdk', 'camera.md');
    expect(result.stdout).toContain(`Camera  ${file}:8`);
    expect(result.stdout).toContain('The v54.0.0 camera does barcode scanning.');
    expect(result.stdout).not.toContain('v57.0.0');
  });

  it('refuses to download under EXPO_OFFLINE, and names docs:sync', async () => {
    const result = await executeAgentCliAsync(cwd, ['docs:search', 'camera', '--json'], {
      ...docsEnv({ EXPO_OFFLINE: '1' }),
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: 'DOCS_NOT_SYNCED',
      suggestedCommand: 'npx @expo/agent-cli docs:sync',
    });
    expect(requests).toEqual([]);
  });

  it('names the missing version under EXPO_OFFLINE when another one is synced', async () => {
    await executeAgentCliAsync(cwd, ['docs:sync'], docsEnv());
    requests.length = 0;

    const result = await executeAgentCliAsync(
      cwd,
      ['docs:search', 'camera', '--sdk', '54', '--json'],
      { ...docsEnv({ EXPO_OFFLINE: '1' }), reject: false }
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: 'DOCS_NOT_SYNCED',
      suggestedCommand: 'npx @expo/agent-cli docs:sync --sdk 54',
    });
    expect(requests).toEqual([]);
  });

  it('warns when the synced docs are more than a week old', async () => {
    await executeAgentCliAsync(cwd, ['docs:sync'], docsEnv());
    const manifestFile = path.join(docsDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({ ...manifest, syncedAt: '2026-01-01T00:00:00.000Z' })
    );

    const result = await executeAgentCliAsync(cwd, ['docs:search', 'camera', '--json'], docsEnv());

    expect(result.stderr).toContain('last synced 2026-01-01');
    expect(JSON.parse(result.stdout).hits.length).toBeGreaterThan(0);
  });

  it('documents exactly the keys it emits', async () => {
    const help = await executeAgentCliAsync(cwd, ['docs:search', '--help']);
    const report = await executeAgentCliAsync(cwd, ['docs:search', 'camera', '--json'], docsEnv());

    expect(documentedJsonKeys(help.stdout).sort()).toEqual(
      Object.keys(JSON.parse(report.stdout)).sort()
    );
  });
});

describe('docs', () => {
  it('lists its two actions and exits 0', async () => {
    const result = await executeAgentCliAsync(cwd, ['docs'], docsEnv());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('docs:sync');
    expect(result.stdout).toContain('docs:search');
    expect(requests).toEqual([]);
  });

  it('is listed under Learn in the top-level help', async () => {
    const result = await executeAgentCliAsync(cwd, ['--help']);
    const learn = result.stdout.slice(result.stdout.indexOf('Learn'));

    expect(learn.slice(0, learn.indexOf('Account'))).toContain('docs:search');
  });
});
