// @ref llp/0006.000-local-expo-ui-docs.plan.md §Setup flow
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stripVTControlCharacters } from 'util';

import * as Log from '../log';
import type { SkillsAgent } from '../skills/types';
import { findExecutableOnPath, spawnSubprocessAsync } from '../utils/subprocess';
import type { AgentInstallPlan, InstallCommand, PluginSetupResult, SetupScope } from './types';

const CLAUDE_PLUGIN = 'expo@claude-plugins-official';
const CODEX_PLUGIN = 'expo@expo-plugins';

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

/** Inspection failures stop this target; they never mean that nothing is installed. */
export async function installAgentAsync(plan: AgentInstallPlan): Promise<PluginSetupResult> {
  const result = (
    status: PluginSetupResult['status'],
    reason: string | null = null
  ): PluginSetupResult => ({
    agent: plan.agent,
    provider: plan.provider,
    scope: plan.scope,
    destination: plan.destination,
    status,
    reason,
  });
  const run = async (command: InstallCommand, inspect = false): Promise<string> => {
    if (!findExecutableOnPath(command.command)) {
      throw new Error(
        `${command.command} is not on PATH. Install it or use --no-plugins to run project setup only.`
      );
    }
    if (!inspect) Log.progress(`Running ${displayInstallCommand(command)}`);
    const answer = await spawnSubprocessAsync(command.command, command.args, {
      cwd: plan.destination,
      output: inspect ? 'capture' : 'capture-stdout',
      timeoutMs: inspect ? 30_000 : 300_000,
      promptGuard: true,
    });
    if (answer.spawnError || answer.timedOut || answer.promptHang || answer.exitCode !== 0) {
      const detail =
        answer.spawnError?.message ??
        (answer.timedOut ? 'timed out' : answer.promptHang) ??
        stripVTControlCharacters(answer.stderr || answer.stdout).trim();
      throw new Error(
        `${displayInstallCommand(command)} failed: ${detail || `exit ${answer.exitCode}`}`
      );
    }
    return answer.stdout;
  };
  const inspect = async (command: InstallCommand): Promise<unknown> => {
    const output = await run(command, true);
    try {
      return JSON.parse(output);
    } catch {
      throw new Error(`Could not inspect ${plan.name}: installer returned invalid JSON.`);
    }
  };
  try {
    if (plan.provider === 'skills') {
      const command = plan.commands[0]!;
      const prefix = command.command === 'npx' ? ['--yes', 'skills'] : ['skills'];
      const listed = rows(
        await inspect({
          command: command.command,
          args: [
            ...prefix,
            'list',
            '--json',
            '--agent',
            plan.agent,
            ...(plan.scope === 'user' ? ['--global'] : []),
          ],
        })
      );
      const existing = listed.filter((entry) => entry.source === 'expo/skills');
      if (existing.length)
        return result(
          'already-present',
          `Keeping ${existing.length} existing Expo skill(s). Use the skills CLI to update or change the selection.`
        );
      if (
        listed.some((entry) => typeof entry.name === 'string' && /^(expo-|eas-)/.test(entry.name))
      ) {
        throw new Error(
          'Expo-named skills from another or unknown source already exist. Resolve their ownership before installing expo/skills.'
        );
      }
      await run(command);
      const installed = rows(
        await inspect({
          command: command.command,
          args: [
            ...prefix,
            'list',
            '--json',
            '--agent',
            plan.agent,
            ...(plan.scope === 'user' ? ['--global'] : []),
          ],
        })
      );
      if (!installed.some((entry) => entry.source === 'expo/skills')) {
        throw new Error(
          'The skills installer exited successfully but no Expo skills were found for this agent.'
        );
      }
    } else {
      const command = plan.provider === 'claude' ? 'claude' : 'codex';
      const listed = await inspect({ command, args: ['plugin', 'list', '--json'] });
      const plugins =
        plan.provider === 'claude'
          ? rows(listed, 'id')
          : rows(object(listed).installed, 'pluginId');
      const pluginId = plan.provider === 'claude' ? CLAUDE_PLUGIN : CODEX_PLUGIN;
      const inScope = plugins.filter(
        (entry) =>
          plan.provider === 'codex' ||
          (entry.scope === plan.scope &&
            (plan.scope === 'user' || samePath(entry.projectPath, plan.destination)))
      );
      const installed = inScope.find((entry) => (entry.id ?? entry.pluginId) === pluginId);
      if (installed) {
        if (
          plan.provider === 'codex' &&
          installed.marketplaceSource &&
          !isExpoSource(object(installed.marketplaceSource).source)
        )
          throw new Error(
            'The installed Expo plugin has a different marketplace source. Resolve it in Codex before continuing.'
          );
        if (installed.enabled !== true)
          throw new Error(
            `${pluginId} is installed but not enabled. Enable it in ${plan.name}, then rerun setup.`
          );
        return result('already-present');
      }
      if (
        inScope.some(
          (entry) =>
            entry.name === 'expo' || String(entry.id ?? entry.pluginId ?? '').startsWith('expo@')
        )
      ) {
        throw new Error(
          `An Expo plugin from a different source is already installed. Keep or remove it in ${plan.name} before installing ${pluginId}.`
        );
      }
      const standalone = await findStandaloneSkillsAsync(plan);
      if (standalone)
        throw new Error(
          `Standalone Expo skills already exist at ${standalone}. Keep them or remove them with their installer before adding a second copy through a plugin.`
        );

      let commands = plan.commands;
      if (plan.provider === 'codex') {
        const marketplaces = rows(
          object(
            await inspect({ command: 'codex', args: ['plugin', 'marketplace', 'list', '--json'] })
          ).marketplaces
        );
        const existing = marketplaces.find((entry) => entry.name === 'expo-plugins');
        if (existing) {
          const source = object(existing.marketplaceSource).source;
          if (!isExpoSource(source))
            throw new Error(
              'The expo-plugins marketplace has a different or unknown source. Resolve it in Codex before continuing.'
            );
          commands = commands.slice(1);
        }
      }
      for (const command of commands) await run(command);
      const verified = await inspect({ command, args: ['plugin', 'list', '--json'] });
      const verifiedPlugins =
        plan.provider === 'claude'
          ? rows(verified, 'id')
          : rows(object(verified).installed, 'pluginId');
      if (
        !verifiedPlugins.some(
          (entry) =>
            (entry.id ?? entry.pluginId) === pluginId &&
            entry.enabled === true &&
            (plan.provider === 'codex' ||
              (entry.scope === plan.scope &&
                (plan.scope === 'user' || samePath(entry.projectPath, plan.destination))))
        )
      ) {
        throw new Error(
          `${pluginId} was not found enabled in the requested scope after installation. Check ${plan.name}'s plugin settings.`
        );
      }
    }
    return result(
      'installed',
      plan.provider === 'skills'
        ? 'Start a new agent session to load Expo skills.'
        : 'Start a new agent session to load Expo. Plugin MCP tools may still require sign-in.'
    );
  } catch (error) {
    return result('failed', error instanceof Error ? error.message : String(error));
  }
}

function rows(value: unknown, key = 'name'): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))
  ) {
    throw new Error('Could not inspect existing installations: unexpected JSON shape.');
  }
  if (value.some((entry) => typeof entry[key] !== 'string'))
    throw new Error('Could not inspect existing installations: missing identity field.');
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Could not inspect existing installations: unexpected JSON shape.');
  }
  return value as Record<string, unknown>;
}

function samePath(value: unknown, target: string): boolean {
  if (typeof value !== 'string') return false;
  const resolve = (value: string) => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  return resolve(value) === resolve(target);
}

function isExpoSource(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    [
      'expo/skills',
      'https://github.com/expo/skills',
      'https://github.com/expo/skills.git',
      'git@github.com:expo/skills.git',
      'ssh://git@github.com/expo/skills.git',
    ].includes(value)
  );
}

async function findStandaloneSkillsAsync(plan: AgentInstallPlan): Promise<string | null> {
  const root = plan.scope === 'user' ? os.homedir() : plan.destination;
  const agentRoot =
    plan.provider === 'claude'
      ? plan.scope === 'user'
        ? (process.env.CLAUDE_CONFIG_DIR ?? path.join(root, '.claude'))
        : path.join(root, '.claude')
      : (process.env.CODEX_HOME ?? path.join(root, '.codex'));
  const directories =
    plan.provider === 'claude'
      ? [path.join(agentRoot, 'skills')]
      : [path.join(root, '.agents', 'skills'), path.join(agentRoot, 'skills')];
  for (const directory of directories) {
    const names = await fs.promises.readdir(directory).catch(() => [] as string[]);
    if (names.some((name) => /^(expo-|eas-)/.test(name))) return directory;
  }
  return null;
}
