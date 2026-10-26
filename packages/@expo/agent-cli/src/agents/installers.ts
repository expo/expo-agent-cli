// @ref llp/0006-agent-native-cli-surface.rfc.md §Installation and scope

import type { SkillsAgent } from '../skills/types';
import { findExecutableOnPath } from '../utils/subprocess';
import type { AgentInstallPlan, InstallCommand, SetupScope } from './types';

export const CLAUDE_PLUGIN = 'expo@claude-plugins-official';
export const CODEX_PLUGIN = 'expo@expo-plugins';

export function buildInstallerPlans(
  agents: SkillsAgent[],
  scope: SetupScope,
  destination: string
): AgentInstallPlan[] {
  return agents.map((agent) => {
    const base = { agent: agent.id, name: agent.displayName, scope, destination };
    if (agent.id === 'claude-code') {
      return {
        ...base,
        provider: 'claude',
        commands: [
          { command: 'claude', args: ['plugin', 'install', CLAUDE_PLUGIN, '--scope', scope] },
        ],
      };
    }
    // Codex's plugin CLI writes user configuration; project scope uses the skills installer.
    if (agent.id === 'codex' && scope === 'user') {
      return {
        ...base,
        provider: 'codex',
        commands: [
          {
            command: 'codex',
            args: ['plugin', 'marketplace', 'add', 'expo/skills', '--ref', 'main', '--json'],
          },
          { command: 'codex', args: ['plugin', 'add', CODEX_PLUGIN, '--json'] },
        ],
      };
    }
    const runner = findExecutableOnPath('bunx') ? 'bunx' : 'npx';
    return {
      ...base,
      provider: 'skills',
      commands: [
        {
          command: runner,
          args: [
            ...(runner === 'npx' ? ['--yes'] : []),
            'skills',
            'add',
            'expo/skills',
            '--skill',
            '*',
            '--agent',
            agent.id,
            '--yes',
            ...(scope === 'user' ? ['--global'] : []),
          ],
        },
      ],
    };
  });
}

export function displayInstallCommand(command: InstallCommand): string {
  return [command.command, ...command.args]
    .map((value) => (/^[\w@/.:=-]+$/.test(value) ? value : JSON.stringify(value)))
    .join(' ');
}
