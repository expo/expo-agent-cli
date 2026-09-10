import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { copyWorkspace, snapshot } from '../workspace';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('starts each attempt from an isolated fixture, with no successful outcome already present', () => {
  const first = copyWorkspace('e2e/fixtures/skills-app');
  const second = copyWorkspace('e2e/fixtures/skills-app');
  roots.push(first, second);
  expect(fs.existsSync(path.join(first, '.claude/skills/usage'))).toBe(false);
  fs.writeFileSync(path.join(first, 'AGENTS.md'), 'changed');
  expect(snapshot(first)).toHaveProperty('AGENTS.md');
  expect(snapshot(second)).not.toHaveProperty('AGENTS.md');
  expect(Object.keys(snapshot(first)).some((key) => key.startsWith('node_modules/'))).toBe(false);
});
it('does not copy a fixture outside this package', () => {
  expect(() => copyWorkspace('../../..')).toThrow('Invalid fixture');
});

it('runs a fresh project against real locked packages without copying node_modules', () => {
  const root = copyWorkspace('evals/fixtures/real-app', true);
  roots.push(root);
  expect(fs.lstatSync(path.join(root, 'node_modules')).isSymbolicLink()).toBe(true);
  expect(
    JSON.parse(fs.readFileSync(path.join(root, 'node_modules/expo/package.json'), 'utf8')).version
  ).toBe('57.0.19');
  expect(snapshot(root)).toHaveProperty('index.js');
});

it.skipIf(process.platform === 'win32')(
  'snapshots project files without reading a live Unix socket',
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-snapshot-'));
    const server = net.createServer();
    try {
      fs.writeFileSync(path.join(root, 'App.js'), 'export default null;');
      fs.symlinkSync('App.js', path.join(root, 'linked.js'));
      const before = snapshot(root);
      // Linux dev locks leave a filesystem socket; macOS uses another lock mechanism.
      // A short pathname keeps this portable across Unix socket path-length limits.
      server.listen(path.join(root, 's'));
      await once(server, 'listening');
      expect(fs.lstatSync(path.join(root, 's')).isSocket()).toBe(true);
      expect(snapshot(root)).toEqual(before);
      expect(before['App.js']).toMatch(/^[a-f0-9]{64}$/);
      expect(before['linked.js']).toBe('link:App.js');
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
