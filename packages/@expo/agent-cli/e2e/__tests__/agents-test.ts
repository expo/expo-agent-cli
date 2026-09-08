// @ref llp/0006-agent-native-cli-surface.rfc.md §Surface improvements
//
// `@expo/agent-cli agents:setup` links the agent skills and maintains one managed block in the project's
// AGENTS.md. These tests run it through the CLI it is published as, on a copy of the
// `skills-app` fixture.
import fs from 'node:fs';
import path from 'node:path';

import { executeAgentCliAsync, readProjectFile, setupFixtureAsync } from '../utils';

const BLOCK_START = '<!-- BEGIN EXPO AGENT CLI MANAGED BLOCK -->';
const BLOCK_END = '<!-- END EXPO AGENT CLI MANAGED BLOCK -->';

/** The shape `agents:setup --json` prints, per `src/agents/types.ts`. */
type SetupReport = {
  projectRoot: string;
  skills: {
    synced: boolean;
    discovered: number;
    packages: number;
    agents: string[];
    skillsDirs: string[];
  } | null;
  agentsMd: { path: string; action: 'created' | 'updated' | 'skipped' } | null;
  agents: string[];
  notes: string[];
};

describe('@expo/agent-cli agents:setup', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await setupFixtureAsync('skills-app');
  });

  it('should print usage with `agents:setup --help`', async () => {
    const result = await executeAgentCliAsync(projectRoot, [
      'agents:setup',
      '--yes',
      '--no-plugins',
      '--help',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.all).toContain('--agent');
    expect(result.all).toContain('--no-agents-md');
    expect(result.all).toContain('--no-agent-skills');
    expect(result.all).toContain('--json');
  });

  it('should link the skills and creates AGENTS.md with the managed block', async () => {
    const result = await executeAgentCliAsync(projectRoot, [
      'agents:setup',
      '--yes',
      '--no-plugins',
      '--agent',
      'claude-code',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('AGENTS.md');
    expect(result.stdout).toContain('created');

    // The skill sync of `skills:sync` ran.
    expect(fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'usage'))).toBe(true);

    const agentsMd = readProjectFile(projectRoot, 'AGENTS.md')!;
    expect(agentsMd).toContain(BLOCK_START);
    expect(agentsMd).toContain(BLOCK_END);
    // The project facts come from the probe.
    expect(agentsMd).toContain('skills-app');
    expect(agentsMd).toContain('54.0.0');
    expect(agentsMd).toContain('Expo Go');
    // The command cheat sheet.
    expect(agentsMd).toContain('@expo/agent-cli status');
    expect(agentsMd).toContain('@expo/agent-cli status --json');
    expect(agentsMd).toContain('add --plan to print the steps without running them');
    expect(agentsMd).toContain('@expo/agent-cli install');
    expect(agentsMd).toContain('@expo/agent-cli runtime:eval');
    expect(agentsMd).toContain('@expo/agent-cli navigate');
    expect(agentsMd).toContain('@expo/agent-cli skills:list');
    // The linked skills location.
    expect(agentsMd).toContain('[.claude/skills/usage/SKILL.md](.claude/skills/usage/SKILL.md)');
    expect(readProjectFile(projectRoot, 'CLAUDE.md')).toBe('@AGENTS.md\n');
  });

  it('should write a byte-identical AGENTS.md on a rerun', async () => {
    await executeAgentCliAsync(projectRoot, [
      'agents:setup',
      '--yes',
      '--no-plugins',
      '--agent',
      'claude-code',
    ]);
    const first = readProjectFile(projectRoot, 'AGENTS.md')!;

    const result = await executeAgentCliAsync(projectRoot, [
      'agents:setup',
      '--yes',
      '--no-plugins',
      '--agent',
      'claude-code',
    ]);

    expect(result.exitCode).toBe(0);
    expect(readProjectFile(projectRoot, 'AGENTS.md')).toBe(first);
    expect(result.stdout).toContain('skipped');
  });

  it('should link and index package skills for Grok Build and migrate template install commands', async () => {
    fs.writeFileSync(
      path.join(projectRoot, 'AGENTS.md'),
      '# Rules\nUse `bunx expo install expo-camera`.\n'
    );
    const result = await executeAgentCliAsync(projectRoot, [
      'agents:setup',
      '--yes',
      '--no-plugins',
      '--agent',
      'grok',
      '--json',
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      agents: ['grok'],
      skills: { synced: true, skillsDirs: ['.grok/skills'] },
      agentsMd: { path: 'AGENTS.md', action: 'updated' },
      errors: [],
    });
    expect(fs.existsSync(path.join(projectRoot, '.grok', 'skills', 'usage', 'SKILL.md'))).toBe(
      true
    );
    const instructions = readProjectFile(projectRoot, 'AGENTS.md')!;
    expect(instructions).toContain('Use `bunx @expo/agent-cli install expo-camera`.');
    expect(instructions).toContain('[.grok/skills/usage/SKILL.md](.grok/skills/usage/SKILL.md)');
  });

  it('should preserve user content outside the managed block', async () => {
    const before = ['# House rules', '', 'Never force push.', ''].join('\n');
    await fs.promises.writeFile(path.join(projectRoot, 'AGENTS.md'), before);

    await executeAgentCliAsync(projectRoot, [
      'agents:setup',
      '--yes',
      '--no-plugins',
      '--agent',
      'claude-code',
    ]);
    const withBlock = readProjectFile(projectRoot, 'AGENTS.md')!;

    expect(withBlock.startsWith(before)).toBe(true);
    expect(withBlock).toContain(BLOCK_START);

    // A second run rewrites only the block, so the user content stays byte for byte.
    await executeAgentCliAsync(projectRoot, [
      'agents:setup',
      '--yes',
      '--no-plugins',
      '--agent',
      'claude-code',
    ]);
    expect(readProjectFile(projectRoot, 'AGENTS.md')).toBe(withBlock);
  });

  it('should append a Claude import while preserving its existing rules', async () => {
    const claudeMd = '# Rules for this project\n';
    await fs.promises.writeFile(path.join(projectRoot, 'CLAUDE.md'), claudeMd);

    const result = await executeAgentCliAsync(projectRoot, [
      'agents:setup',
      '--yes',
      '--no-plugins',
      '--agent',
      'claude-code',
    ]);

    expect(readProjectFile(projectRoot, 'CLAUDE.md')).toBe(claudeMd + '\n@AGENTS.md\n');
    expect(result.all).toContain('CLAUDE.md');
  });

  it('should write only AGENTS.md with `--no-agent-skills`', async () => {
    const result = await executeAgentCliAsync(projectRoot, [
      'agents:setup',
      '--yes',
      '--no-plugins',
      '--no-agent-skills',
    ]);

    expect(result.exitCode).toBe(0);
    expect(readProjectFile(projectRoot, 'AGENTS.md')).toContain(BLOCK_START);
    expect(fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'usage'))).toBe(false);
  });

  it('should link only the skills with `--no-agents-md`', async () => {
    const result = await executeAgentCliAsync(projectRoot, [
      'agents:setup',
      '--yes',
      '--no-plugins',
      '--agent',
      'claude-code',
      '--no-agents-md',
    ]);

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(projectRoot, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'usage'))).toBe(true);
  });

  it('should print exactly one JSON object with `--json`', async () => {
    const result = await executeAgentCliAsync(projectRoot, [
      'agents:setup',
      '--yes',
      '--no-plugins',
      '--agent',
      'claude-code',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const report: SetupReport = JSON.parse(result.stdout);
    // Top-level keys are the stable contract of the command (llp/0006 §Output contract).
    expect(Object.keys(report).sort()).toEqual([
      'agents',
      'agentsMd',
      'cancelled',
      'claudeMd',
      'errors',
      'notes',
      'plugins',
      'projectRoot',
      'scope',
      'skills',
    ]);
    expect(report.agents).toEqual(['claude-code']);
    expect(report.agentsMd).toEqual({ path: 'AGENTS.md', action: 'created' });
    expect(report.skills).toEqual({
      synced: true,
      discovered: 1,
      packages: 1,
      agents: ['claude-code'],
      skillsDirs: ['.claude/skills'],
    });
  });

  it('should report an unknown agent', async () => {
    const result = await executeAgentCliAsync(
      projectRoot,
      ['agents:setup', '--yes', '--no-plugins', '--agent', 'nope'],
      {
        reject: false,
      }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.all).toContain('nope');
  });
  it('should refresh and prune the skill index with sync and cleanup while preserving other instructions', async () => {
    await fs.promises.writeFile(path.join(projectRoot, 'AGENTS.md'), '# User rules\n');
    await executeAgentCliAsync(projectRoot, [
      'agents:setup',
      '--yes',
      '--no-plugins',
      '--agent',
      'codex',
    ]);
    const initial = readProjectFile(projectRoot, 'AGENTS.md')!;
    expect(readProjectFile(projectRoot, 'CLAUDE.md')).toBeNull();
    const packageDir = path.join(projectRoot, 'node_modules/fake-module-with-skills');
    const extraDir = path.join(packageDir, 'skills/extra');
    await fs.promises.mkdir(extraDir);
    await fs.promises.writeFile(path.join(extraDir, 'SKILL.md'), '# Extra guidance');
    await executeAgentCliAsync(projectRoot, ['skills:sync', '--dry-run', '--json']);
    expect(readProjectFile(projectRoot, 'AGENTS.md')).toBe(initial);
    await executeAgentCliAsync(projectRoot, ['skills:sync', '--json']);
    const updated = readProjectFile(projectRoot, 'AGENTS.md')!;
    expect(updated).toContain('| fake-module-with-skills | extra |');
    expect(updated).toContain('| fake-module-with-skills | usage |');
    expect(updated.startsWith('# User rules\n')).toBe(true);
    await executeAgentCliAsync(projectRoot, ['skills:clean', '--dry-run', '--json']);
    expect(readProjectFile(projectRoot, 'AGENTS.md')).toBe(updated);
    await fs.promises.rm(extraDir, { recursive: true });
    await executeAgentCliAsync(projectRoot, ['skills:sync', '--json']);
    expect(readProjectFile(projectRoot, 'AGENTS.md')).toBe(initial);
    await executeAgentCliAsync(projectRoot, ['skills:clean', '--json']);
    const cleaned = readProjectFile(projectRoot, 'AGENTS.md')!;
    expect(cleaned).toContain('No linked package skills are available.');
    expect(cleaned).not.toContain('usage/SKILL.md');
    expect(cleaned.split('<!-- BEGIN EXPO PACKAGE SKILLS -->')[0]).toBe(
      initial.split('<!-- BEGIN EXPO PACKAGE SKILLS -->')[0]
    );
  });

  it('should not refresh either instruction file when setup opts out', async () => {
    await executeAgentCliAsync(projectRoot, [
      'agents:setup',
      '--yes',
      '--no-plugins',
      '--agent',
      'claude-code',
    ]);
    const before = readProjectFile(projectRoot, 'AGENTS.md');
    const claude = readProjectFile(projectRoot, 'CLAUDE.md');
    const extraDir = path.join(projectRoot, 'node_modules/fake-module-with-skills/skills/extra');
    await fs.promises.mkdir(extraDir);
    await fs.promises.writeFile(path.join(extraDir, 'SKILL.md'), '# Extra guidance');
    await executeAgentCliAsync(projectRoot, [
      'agents:setup',
      '--yes',
      '--no-plugins',
      '--agent',
      'claude-code',
      '--no-agents-md',
    ]);
    expect(readProjectFile(projectRoot, 'AGENTS.md')).toBe(before);
    expect(readProjectFile(projectRoot, 'CLAUDE.md')).toBe(claude);
    expect(fs.existsSync(path.join(projectRoot, '.claude/skills/extra'))).toBe(true);
  });

  it('should omit a user-owned skill that occupies the package link name', async () => {
    await fs.promises.mkdir(path.join(projectRoot, '.agents/skills/usage'), { recursive: true });
    await fs.promises.writeFile(
      path.join(projectRoot, '.agents/skills/usage/SKILL.md'),
      '# User guidance'
    );
    await executeAgentCliAsync(projectRoot, [
      'agents:setup',
      '--yes',
      '--no-plugins',
      '--agent',
      'codex',
    ]);
    expect(readProjectFile(projectRoot, 'AGENTS.md')).toContain(
      'No linked package skills are available.'
    );
    expect(readProjectFile(projectRoot, 'AGENTS.md')).not.toContain('| fake-module-with-skills |');
  });
  it.skipIf(process.platform === 'win32')(
    'should reuse a root CLAUDE.md target through setup and skill cleanup',
    async () => {
      await fs.promises.writeFile(path.join(projectRoot, 'CLAUDE.md'), '# Shared user rules\n');
      await fs.promises.symlink('CLAUDE.md', path.join(projectRoot, 'AGENTS.md'));
      await executeAgentCliAsync(projectRoot, [
        'agents:setup',
        '--yes',
        '--no-plugins',
        '--agent',
        'claude-code',
      ]);
      const contents = readProjectFile(projectRoot, 'CLAUDE.md')!;
      expect(contents).toContain(BLOCK_START);
      expect(contents).toContain('.claude/skills/usage/SKILL.md');
      expect(contents).not.toContain('@AGENTS.md');
      await executeAgentCliAsync(projectRoot, ['skills:clean', '--json']);
      expect(readProjectFile(projectRoot, 'CLAUDE.md')).toContain(
        'No linked package skills are available.'
      );
      expect((await fs.promises.lstat(path.join(projectRoot, 'AGENTS.md'))).isSymbolicLink()).toBe(
        true
      );
    }
  );
});
