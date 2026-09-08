import { vol } from 'memfs';

import { applyManagedBlock } from '../agentsMd';
import { collectLinkedSkillsAsync, renderSkillIndex, refreshSkillIndexAsync } from '../skillIndex';
import type { DiscoveredSkill } from '../../skills/types';

const skill: DiscoveredSkill = {
  packageName: 'expo-sqlite',
  name: 'usage',
  linkName: 'usage',
  path: '/app/node_modules/expo-sqlite/skills/usage',
};

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ [skill.path + '/SKILL.md']: '# SQLite' });
  vol.mkdirSync('/app/.claude/skills', { recursive: true });
  vol.mkdirSync('/app/.agents/skills', { recursive: true });
});

describe('Indexing linked package skills', () => {
  it('should index verified links once per package skill with relative paths', async () => {
    vol.symlinkSync(skill.path, '/app/.claude/skills/usage');
    vol.symlinkSync(skill.path, '/app/.agents/skills/usage');
    const entries = await collectLinkedSkillsAsync(
      '/app',
      [skill],
      ['.claude/skills', '.agents/skills', '.agents/skills']
    );
    expect(entries).toEqual([
      {
        packageName: 'expo-sqlite',
        name: 'usage',
        paths: ['.agents/skills/usage/SKILL.md', '.claude/skills/usage/SKILL.md'],
      },
    ]);
    const table = renderSkillIndex(entries);
    expect(table).toContain('| Package | Skill | Read |');
    expect(table).toContain('(.claude/skills/usage/SKILL.md)');
    expect(table).not.toContain('/app/');
  });

  it('should omit occupied directories, wrong targets, and broken links', async () => {
    vol.mkdirSync('/app/.claude/skills/usage');
    vol.writeFileSync('/app/.claude/skills/usage/SKILL.md', '# User skill');
    vol.symlinkSync('/app/node_modules/other/skills/usage', '/app/.agents/skills/usage');
    expect(
      await collectLinkedSkillsAsync('/app', [skill], ['.claude/skills', '.agents/skills'])
    ).toEqual([]);
    vol.fromJSON({ '/app/node_modules/other/skills/usage/SKILL.md': '# Other' });
    expect(await collectLinkedSkillsAsync('/app', [skill], ['.agents/skills'])).toEqual([]);
  });

  it('should escape package metadata without letting it add table rows or instructions', () => {
    const table = renderSkillIndex([
      { packageName: 'pkg|<tag>\n@secret', name: 'x`y', paths: ['.agents/skills/usage/SKILL.md'] },
    ]);
    expect(table).toContain('pkg&#124;&lt;tag&gt; &#64;secret');
    expect(table).not.toContain('\n@secret');
    expect(table).toContain('x&#96;y');
  });

  it('should refresh only the skill section and prune unlinked entries', async () => {
    vol.symlinkSync(skill.path, '/app/.agents/skills/usage');
    const initial =
      'User rules\n\n' +
      applyManagedBlock(null, 'Commands unchanged\n\n' + renderSkillIndex([])) +
      '\nUser footer\n';
    vol.writeFileSync('/app/AGENTS.md', initial);
    await refreshSkillIndexAsync('/app', [skill], ['.agents/skills']);
    expect(vol.readFileSync('/app/AGENTS.md', 'utf8')).toContain('| expo-sqlite | usage |');
    vol.unlinkSync('/app/.agents/skills/usage');
    await refreshSkillIndexAsync('/app', [skill], ['.agents/skills']);
    expect(vol.readFileSync('/app/AGENTS.md', 'utf8')).toBe(initial);
  });

  it('should not create instruction files or edit an unmanaged file', async () => {
    await refreshSkillIndexAsync('/app', [skill], ['.agents/skills']);
    expect(vol.existsSync('/app/AGENTS.md')).toBe(false);
    vol.writeFileSync('/app/AGENTS.md', '# My instructions\n');
    await refreshSkillIndexAsync('/app', [skill], ['.agents/skills']);
    expect(vol.readFileSync('/app/AGENTS.md', 'utf8')).toBe('# My instructions\n');
  });
  it('should reject an unmatched index marker without modifying the file', async () => {
    const contents = applyManagedBlock(
      null,
      renderSkillIndex([]).replace('<!-- END EXPO PACKAGE SKILLS -->', '')
    );
    vol.writeFileSync('/app/AGENTS.md', contents);
    await expect(refreshSkillIndexAsync('/app', [skill], ['.agents/skills'])).rejects.toThrow(
      /unmatched markers/
    );
    expect(vol.readFileSync('/app/AGENTS.md', 'utf8')).toBe(contents);
  });

  it('should distinguish unavailable discovery from an empty index', () => {
    expect(renderSkillIndex(null)).toContain('Package skills could not be inspected.');
    expect(renderSkillIndex(null)).not.toContain('No linked package skills');
  });

  it('should only attribute a duplicate skill name to its actual linked package', async () => {
    const other = { ...skill, packageName: 'other', path: '/app/node_modules/other/skills/usage' };
    vol.fromJSON({ [other.path + '/SKILL.md']: '# Other usage' });
    vol.symlinkSync(skill.path, '/app/.agents/skills/usage');
    expect(await collectLinkedSkillsAsync('/app', [skill, other], ['.agents/skills'])).toEqual([
      { packageName: 'expo-sqlite', name: 'usage', paths: ['.agents/skills/usage/SKILL.md'] },
    ]);
  });
});
