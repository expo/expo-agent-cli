import { vol } from 'memfs';
import fs from 'fs';
import path from 'path';
import * as Log from '../../log';

import { applyManagedBlock } from '../../agents/agentsMd';
import { renderSkillIndex } from '../../agents/skillIndex';
import { discoverSkillsAsync } from '../discovery';
import { autoSyncSkillsAsync, syncSkillsAsync } from '../skillsAsync';
import type { DiscoveredSkill } from '../types';

vi.mock('../../log');
vi.mock('../discovery', () => ({ discoverSkillsAsync: vi.fn() }));
vi.mock('../agents', () => ({
  getAllAgents: () => [{ id: 'codex', displayName: 'Codex', skillsDir: '.agents/skills' }],
  getPersistedAgentIdsAsync: async () => ['codex'],
  resolveAgentsAsync: async () => ({
    agents: [{ id: 'codex', displayName: 'Codex', skillsDir: '.agents/skills' }],
    source: 'cache',
  }),
}));

const skills: DiscoveredSkill[] = ['one', 'two'].map((name) => ({
  name,
  linkName: name,
  packageName: `expo-${name}`,
  path: `/app/node_modules/expo-${name}/skills/${name}`,
}));

beforeEach(() => {
  vol.reset();
  vol.fromJSON({
    '/app/AGENTS.md': applyManagedBlock(null, 'Project facts\n' + renderSkillIndex([])),
    ...Object.fromEntries(skills.map((skill) => [skill.path + '/SKILL.md', '# Guidance'])),
  });
  vi.mocked(discoverSkillsAsync).mockResolvedValue(skills);
  // memfs@3 resolves relative symlinks against cwd; match real filesystem behavior here.
  const symlink = fs.promises.symlink;
  vi.spyOn(fs.promises, 'symlink').mockImplementation((target, link, type) =>
    symlink(path.resolve(path.dirname(link as string), target as string), link, type)
  );
});

afterEach(() => vi.restoreAllMocks());

describe('Refreshing instructions during automatic skill sync', () => {
  it('should retain unrelated index rows during a package-scoped install sync', async () => {
    await autoSyncSkillsAsync('/app');
    expect(vi.mocked(Log.warn).mock.calls).toEqual([]);
    const initial = vol.readFileSync('/app/AGENTS.md', 'utf8');
    expect(initial).toContain('| expo-one | one |');
    expect(initial).toContain('| expo-two | two |');
    await autoSyncSkillsAsync('/app', { packages: ['expo-two@1.0.0'], silent: true });
    expect(vol.readFileSync('/app/AGENTS.md', 'utf8')).toBe(initial);
  });

  it('should prune removed packages from the index during a full auto-sync', async () => {
    await autoSyncSkillsAsync('/app');
    expect(vi.mocked(Log.warn).mock.calls).toEqual([]);
    vi.mocked(discoverSkillsAsync).mockResolvedValue([skills[0]!]);
    await autoSyncSkillsAsync('/app');
    expect(vi.mocked(Log.warn).mock.calls).toEqual([]);
    expect(vol.readFileSync('/app/AGENTS.md', 'utf8')).toContain('| expo-one | one |');
    expect(vol.readFileSync('/app/AGENTS.md', 'utf8')).not.toContain('| expo-two | two |');
  });

  it('should leave the instruction index unchanged during a sync dry run', async () => {
    const initial = vol.readFileSync('/app/AGENTS.md', 'utf8');
    await syncSkillsAsync('/app', { agents: ['codex'], dryRun: true });
    expect(vol.readFileSync('/app/AGENTS.md', 'utf8')).toBe(initial);
    expect(vol.existsSync('/app/.agents/skills/one')).toBe(false);
  });
});
