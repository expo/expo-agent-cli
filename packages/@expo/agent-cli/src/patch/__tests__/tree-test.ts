import fs from 'fs';
import path from 'path';

import { diffTrees, restoreTree } from '../tree';

// The real fs: memfs 3 follows a symlink in `rmSync` and stores a relative target as absolute.
vi.unmock('fs');
vi.unmock('node:fs');

const os = await vi.importActual<typeof import('os')>('os');

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-tree-test-'));
  for (const dir of ['clean', 'edited']) {
    fs.mkdirSync(path.join(root, dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'index.js'), 'module.exports = 1;\n');
    fs.symlinkSync('lib', path.join(root, dir, 'link-to-dir'));
  }
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe(diffTrees, () => {
  it('compares a symlink by its target, and never reads a link to a directory as a file', () => {
    const clean = path.join(root, 'clean');
    const edited = path.join(root, 'edited');
    expect(diffTrees(clean, edited)).toEqual({ changed: [], added: [], removed: [] });

    fs.rmSync(path.join(edited, 'link-to-dir'));
    fs.symlinkSync('index.js', path.join(edited, 'link-to-dir'));
    expect(diffTrees(clean, edited).changed).toEqual(['link-to-dir']);
  });
});

describe(restoreTree, () => {
  it('puts the backup back over a directory that was replaced, symlinks kept as symlinks', () => {
    const backup = path.join(root, 'edited');
    const target = path.join(root, 'clean');
    fs.writeFileSync(path.join(backup, 'index.js'), 'module.exports = 2; // edit\n');
    fs.rmSync(target, { recursive: true });
    fs.mkdirSync(target);

    restoreTree(backup, target);

    expect(fs.readFileSync(path.join(target, 'index.js'), 'utf8')).toBe(
      'module.exports = 2; // edit\n'
    );
    expect(fs.readlinkSync(path.join(target, 'link-to-dir'))).toBe('lib');
  });
});
