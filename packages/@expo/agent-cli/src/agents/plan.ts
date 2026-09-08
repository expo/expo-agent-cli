// @ref llp/0006-agent-native-cli-surface.rfc.md §Agent setup
import os from 'os';
import path from 'path';

import * as Log from '../log';
import { PROGRAM_PREFIX } from '../programName';
import { declaresExpoSync } from '../project/expoApp';
import {
  detectInstalledAgentsAsync,
  getAllAgents,
  getPersistedAgentIdsAsync,
} from '../skills/agents';
import type { SkillsAgent } from '../skills/types';
import { CommandError } from '../utils/errors';
import { isInteractive } from '../utils/interactive';
import { findExecutableOnPath } from '../utils/subprocess';
import { buildInstallerPlans, displayInstallCommand } from './installers';
import { createSetupPrompt, type SetupPrompt } from './prompt';
import type { AgentInstallPlan, SetupOptions, SetupScope } from './types';

export interface SetupPlan {
  projectRoot: string | null;
  destination: string;
  scope: SetupScope;
  agents: SkillsAgent[];
  installers: AgentInstallPlan[];
  confirmed: boolean;
}

export function findSetupProjectRoot(cwd: string): string | null {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (declaresExpoSync(dir)) return dir;
    if (dir === path.dirname(dir)) return null;
  }
}

export async function prepareSetupAsync(
  projectRoot: string | null,
  options: SetupOptions,
  prompt?: SetupPrompt | null
): Promise<SetupPlan> {
  const all = getAllAgents();
  for (const id of options.agents) {
    if (!all.some((agent) => agent.id === id)) {
      throw new CommandError(
        'BAD_ARGS',
        `Unknown agent: ${id}. Valid agents: ${all.map((agent) => agent.id).join(', ')}.`
      );
    }
  }
  if (options.project && !projectRoot) {
    throw new CommandError(
      'BAD_ARGS',
      'No Expo project was found. Omit --project to install in user home, or run setup inside an Expo app.'
    );
  }
  const interactive = prompt !== undefined ? !!prompt : !!process.stdin.isTTY && isInteractive();
  if (!options.yes && !interactive) {
    throw new CommandError(
      'SETUP_CONFIRMATION_REQUIRED',
      `Setup needs confirmation. Run in a terminal, or pass --yes --agent <agent> to ${PROGRAM_PREFIX} agents:setup.`
    );
  }

  const questions = options.yes ? null : (prompt ?? createSetupPrompt());
  const scope: SetupScope = options.project ? 'project' : 'user';
  let agents: SkillsAgent[] = [];
  const makePlan = (confirmed: boolean): SetupPlan => {
    const destination = scope === 'project' ? projectRoot! : os.homedir();
    return {
      projectRoot,
      destination,
      scope,
      agents,
      confirmed,
      installers: options.plugins === false ? [] : buildInstallerPlans(agents, scope, destination),
    };
  };
  const cached = projectRoot ? await getPersistedAgentIdsAsync(projectRoot) : null;
  const detected = await detectInstalledAgentsAsync(projectRoot ?? os.homedir());
  const defaults = new Set(cached?.length ? cached : detected.map((agent) => agent.id));
  if (!cached?.length) {
    if (findExecutableOnPath('claude')) defaults.add('claude-code');
    if (findExecutableOnPath('codex')) defaults.add('codex');
    if (findExecutableOnPath('grok')) defaults.add('grok');
  }
  let ids = options.agents.length ? options.agents : [...defaults];
  if (!options.yes && !options.agents.length) {
    const selected = await questions!.selectAgents(all, ids);
    if (selected == null) return makePlan(false);
    ids = selected;
  }
  if (!ids.length && (options.plugins !== false || (projectRoot && options.agentSkills))) {
    throw new CommandError(
      'BAD_ARGS',
      `No coding agent was detected. Pass --agent <agent>: ${all
        .map((agent) => agent.id)
        .join(', ')}.`
    );
  }
  agents = [...new Set(ids)].map((id) => all.find((agent) => agent.id === id)!);
  const plan = makePlan(false);
  const lines = [`Set up Expo agents (${scope}): ${plan.destination}`];
  for (const installer of plan.installers) {
    lines.push(`${installer.name}: ${installer.provider === 'skills' ? 'skills' : 'plugin'}`);
    for (const command of installer.commands) lines.push(`  ${displayInstallCommand(command)}`);
  }
  if (projectRoot) {
    if (options.agentSkills) lines.push(`Sync package skills in ${projectRoot}.`);
    if (options.agentsMd) {
      lines.push(
        `Update the AGENTS.md managed block and rewrite Expo install commands to agent-cli in ${projectRoot} (or its regular root CLAUDE.md target).`
      );
      if (agents.some((agent) => agent.id === 'claude-code')) {
        lines.push(
          `Ensure CLAUDE.md imports AGENTS.md in ${projectRoot}, preserving existing instructions and shared-file links.`
        );
      }
    }
  } else {
    lines.push('No Expo project: project skill sync and instruction-file generation are skipped.');
  }
  lines.push('Existing installations will be checked before installing.');
  Log.progress(lines.join('\n'));
  return { ...plan, confirmed: options.yes || (await questions!.confirm()) === true };
}
