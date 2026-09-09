import fs from 'node:fs';
import path from 'node:path';
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
