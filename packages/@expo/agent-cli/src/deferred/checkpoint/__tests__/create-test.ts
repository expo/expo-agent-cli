// Deferred from v1 (2026-08-26) — kept as reference, imported by nothing; see llp/0008
//
import { vol } from 'memfs';

import * as Log from '../../../log';
import { createCheckpointAsync, printCheckpointAsync } from '../create';
import { event } from '../events';
import {
  GitError,
  commitSnapshotTreeAsync,
  resolveWorkTreeAsync,
  writeSnapshotTreeAsync,
} from '../git';
import { readCheckpoints } from '../store';

vi.mock('../../log');
vi.mock('../events', () => ({
  event: vi.fn(),
  debugEvent: Object.assign(vi.fn(), { error: vi.fn((error) => error) }),
}));
vi.mock('../git', async () => ({
  ...await vi.importActual('../git'),
  resolveWorkTreeAsync: vi.fn(),
  writeSnapshotTreeAsync: vi.fn(),
  commitSnapshotTreeAsync: vi.fn(),
}));

const projectRoot = '/repo/apps/app';
const worktree = { toplevel: '/repo', prefix: 'apps/app' };

/** Everything the command printed, joined into one string. */
function printed(): string {
  return vi.mocked(Log.log).mock.calls.flat().join('\n');
}

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ [`${projectRoot}/package.json`]: '{}' });
  vi.mocked(resolveWorkTreeAsync).mockResolvedValue(worktree);
  vi.mocked(writeSnapshotTreeAsync).mockResolvedValue({ tree: 'tree-oid', files: 12 });
  vi.mocked(commitSnapshotTreeAsync).mockResolvedValue('c0ffee1234567890abcdef');
});

describe(createCheckpointAsync, () => {
  it(`should snapshot the project and store the record`, async () => {
    const result = await createCheckpointAsync(projectRoot, {
      label: '@expo/agent-cli install',
      argv: ['@expo/agent-cli', 'install', 'expo-sqlite'],
    });

    expect(result.skipped).toBeNull();
    expect(result.files).toBe(12);
    expect(result.record).toEqual({
      id: 'c0ffee1234567890abcdef',
      label: '@expo/agent-cli install',
      createdAt: expect.any(String),
      argv: ['@expo/agent-cli', 'install', 'expo-sqlite'],
      path: 'apps/app',
    });
    expect(readCheckpoints(projectRoot)).toEqual([result.record]);
    expect(commitSnapshotTreeAsync).toHaveBeenCalledWith(
      worktree,
      'tree-oid',
      expect.stringContaining('@expo/agent-cli install')
    );
    expect(event).toHaveBeenCalledWith('created', {
      id: 'c0ffee1234567890abcdef',
      label: '@expo/agent-cli install',
      files: 12,
      path: 'apps/app',
    });
  });

  it(`should skip a project that is not in a git work tree`, async () => {
    vi.mocked(resolveWorkTreeAsync).mockResolvedValue(null);

    const result = await createCheckpointAsync(projectRoot, { label: '@expo/agent-cli install' });

    expect(result.record).toBeNull();
    expect(result.skipped).toBe('not-a-git-repo');
    expect(writeSnapshotTreeAsync).not.toHaveBeenCalled();
    expect(readCheckpoints(projectRoot)).toEqual([]);
    expect(event).toHaveBeenCalledWith('skipped', {
      label: '@expo/agent-cli install',
      reason: 'not-a-git-repo',
    });
  });

  it(`should skip a project where git tracks no file`, async () => {
    vi.mocked(writeSnapshotTreeAsync).mockResolvedValue({ tree: 'empty-tree', files: 0 });

    const result = await createCheckpointAsync(projectRoot, {
      label: '@expo/agent-cli agents:setup',
    });

    expect(result.skipped).toBe('no-files');
    expect(commitSnapshotTreeAsync).not.toHaveBeenCalled();
    expect(readCheckpoints(projectRoot)).toEqual([]);
  });

  it(`should report a failing git command as a skip instead of throwing`, async () => {
    vi.mocked(writeSnapshotTreeAsync)
      .mockRejectedValue(new GitError(['add', '-A', '.'], 'fatal: index lock exists', 128));

    const result = await createCheckpointAsync(projectRoot, { label: '@expo/agent-cli install' });

    expect(result.skipped).toBe('git-failed');
    expect(result.detail).toContain('index lock exists');
    expect(readCheckpoints(projectRoot)).toEqual([]);
  });
});

describe(printCheckpointAsync, () => {
  it(`should print the id and what the checkpoint covers`, async () => {
    await printCheckpointAsync(projectRoot, { label: 'before refactor' });

    expect(printed()).toContain('c0ffee1');
    expect(printed()).toContain('before refactor');
    expect(printed()).toContain('12 files');
    expect(printed()).toContain('npx @expo/agent-cli checkpoint:undo');
  });

  it(`should print one JSON object with a stable key set`, async () => {
    await printCheckpointAsync(projectRoot, { json: true });

    const report = JSON.parse(printed());
    expect(Object.keys(report).sort()).toEqual([
      'created',
      'createdAt',
      'files',
      'id',
      'label',
      'path',
      'skipped',
    ]);
    expect(report).toMatchObject({ created: true, files: 12, skipped: null });
  });

  it(`should fail with a next action when the project is not in a git repository`, async () => {
    vi.mocked(resolveWorkTreeAsync).mockResolvedValue(null);

    await expect(printCheckpointAsync(projectRoot, {})).rejects.toMatchObject({
      code: 'NOT_A_GIT_REPO',
      suggestedCommand: expect.stringContaining('git init'),
    });
  });

  it(`should fail when the snapshot could not be written`, async () => {
    vi.mocked(writeSnapshotTreeAsync)
      .mockRejectedValue(new GitError(['write-tree'], 'fatal: broken', 128));

    await expect(printCheckpointAsync(projectRoot, {})).rejects.toMatchObject({
      code: 'CHECKPOINT_FAILED',
    });
  });
});
