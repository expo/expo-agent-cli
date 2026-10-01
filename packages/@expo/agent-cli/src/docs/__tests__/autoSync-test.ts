import { spawn } from 'child_process';
import { vol } from 'memfs';
import path from 'path';

import {
  autoSyncDisabledReason,
  docsSummary,
  projectSdkVersionAsync,
  refreshDocsAfterInstallAsync,
  startBackgroundDocsSync,
  syncDocsForProjectAsync,
} from '../autoSync';

const projectRoot = path.resolve('/project');
const docsDir = path.resolve('/docs');
const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.AGENT_CLI_DOCS_DIR = docsDir;
  delete process.env.AGENT_CLI_NO_DOCS_SYNC;
  delete process.env.EXPO_OFFLINE;
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockReturnValue({ on: vi.fn(), unref: vi.fn() } as any);
});

afterEach(() => {
  vol.reset();
  process.env = { ...savedEnv };
});

function writeManifest(bundles: Record<string, { sha256: string; pages: number }>) {
  vol.fromJSON({
    [path.join(docsDir, 'manifest.json')]: JSON.stringify({
      baseUrl: 'https://example.test',
      latest: 'v57.0.0',
      syncedAt: new Date().toISOString(),
      bundles,
    }),
    [path.join(docsDir, 'versions', 'v57.0.0', 'sdk', 'camera.md')]: '# Camera',
  });
}

describe(projectSdkVersionAsync, () => {
  it('reads the installed expo', async () => {
    vol.fromJSON({
      [path.join(projectRoot, 'package.json')]: JSON.stringify({
        dependencies: { expo: '~56.0.0' },
      }),
      [path.join(projectRoot, 'node_modules', 'expo', 'package.json')]: JSON.stringify({
        version: '56.0.3',
      }),
    });
    await expect(projectSdkVersionAsync(projectRoot)).resolves.toBe('56.0.3');
  });

  it('falls back to the expo range of a project without node_modules', async () => {
    vol.fromJSON({
      [path.join(projectRoot, 'package.json')]: JSON.stringify({
        dependencies: { expo: '^55.0.1' },
      }),
    });
    await expect(projectSdkVersionAsync(projectRoot)).resolves.toBe('55.0.1');
  });

  it('is null for a range that names no version', async () => {
    vol.fromJSON({
      [path.join(projectRoot, 'package.json')]: JSON.stringify({
        dependencies: { expo: 'latest' },
      }),
    });
    await expect(projectSdkVersionAsync(projectRoot)).resolves.toBeNull();
  });
});

describe(autoSyncDisabledReason, () => {
  it('names the variable that turns automatic syncs off', () => {
    expect(autoSyncDisabledReason()).toBeNull();
    process.env.EXPO_OFFLINE = '1';
    expect(autoSyncDisabledReason()).toBe('EXPO_OFFLINE is set');
    process.env.AGENT_CLI_NO_DOCS_SYNC = '1';
    expect(autoSyncDisabledReason()).toBe('AGENT_CLI_NO_DOCS_SYNC is set');
  });
});

describe(syncDocsForProjectAsync, () => {
  it('skips without touching the network when automatic syncs are off', async () => {
    process.env.AGENT_CLI_NO_DOCS_SYNC = '1';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(syncDocsForProjectAsync(projectRoot)).resolves.toEqual({
      status: 'skipped',
      reason: 'AGENT_CLI_NO_DOCS_SYNC is set',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('reports a failure instead of throwing it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const result = await syncDocsForProjectAsync(projectRoot);
    expect(result).toMatchObject({ status: 'failed' });
    expect(docsSummary(result)).toContain('failed');
    fetchSpy.mockRestore();
  });
});

describe(startBackgroundDocsSync, () => {
  it('starts a detached docs:sync for the version', () => {
    expect(startBackgroundDocsSync('v56.0.0')).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [process.argv[1], 'docs:sync', '--sdk', '56', '--json', '--no-followups'],
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    );
  });

  it('starts nothing under EXPO_OFFLINE', () => {
    process.env.EXPO_OFFLINE = '1';
    expect(startBackgroundDocsSync('v56.0.0')).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe(refreshDocsAfterInstallAsync, () => {
  it('syncs the new SDK when the cache is in use and lacks it', async () => {
    writeManifest({ shared: { sha256: 'a', pages: 1 }, 'v57.0.0': { sha256: 'b', pages: 1 } });
    vol.fromJSON({
      [path.join(projectRoot, 'node_modules', 'expo', 'package.json')]: JSON.stringify({
        version: '58.0.0',
      }),
    });
    await expect(refreshDocsAfterInstallAsync(projectRoot)).resolves.toBe(true);
    expect(vi.mocked(spawn).mock.calls[0]![1]).toContain('58');
  });

  it('does nothing when the cache already has the SDK', async () => {
    writeManifest({ shared: { sha256: 'a', pages: 1 }, 'v57.0.0': { sha256: 'b', pages: 1 } });
    vol.fromJSON({
      [path.join(projectRoot, 'node_modules', 'expo', 'package.json')]: JSON.stringify({
        version: '57.0.2',
      }),
    });
    await expect(refreshDocsAfterInstallAsync(projectRoot)).resolves.toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does nothing for a user who never synced the docs', async () => {
    vol.fromJSON({
      [path.join(projectRoot, 'node_modules', 'expo', 'package.json')]: JSON.stringify({
        version: '58.0.0',
      }),
    });
    await expect(refreshDocsAfterInstallAsync(projectRoot)).resolves.toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});
