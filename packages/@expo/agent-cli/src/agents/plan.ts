// @ref llp/0006.000-local-expo-ui-docs.plan.md §Setup flow
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
import { createSetupPrompt, type SetupQuestion } from './prompt';
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
  question?: SetupQuestion | null
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
  if (options.scope && !['user', 'project'].includes(options.scope)) {
    throw new CommandError('BAD_ARGS', 'Use --scope user or --scope project.');
  }
  if (options.scope === 'project' && !projectRoot) {
    throw new CommandError(
      'BAD_ARGS',
      'No Expo project was found. Use --scope user, or run setup inside an Expo app.'
    );
  }
  const interactive =
    question !== undefined ? !!question : !!process.stdin.isTTY && isInteractive();
  if (!options.yes && !interactive) {
    throw new CommandError(
      'SETUP_CONFIRMATION_REQUIRED',
      `Setup needs confirmation. Run in a terminal, or pass --yes --scope user|project --agent <agent> to ${PROGRAM_PREFIX} agents:setup.`
    );
  }

  const prompt = !options.yes && question === undefined ? createSetupPrompt() : null;
  const ask = question ?? prompt?.question;
  let scope: SetupScope = options.scope ?? (projectRoot ? 'project' : 'user');
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
  try {
    const cached = projectRoot ? await getPersistedAgentIdsAsync(projectRoot) : null;
    const detected = await detectInstalledAgentsAsync(projectRoot ?? os.homedir());
    const defaults = new Set(cached?.length ? cached : detected.map((agent) => agent.id));
    if (!cached?.length) {
      if (findExecutableOnPath('claude')) defaults.add('claude-code');
      if (findExecutableOnPath('codex')) defaults.add('codex');
    }
    let ids = options.agents.length ? options.agents : [...defaults];
    if (!options.yes && !options.agents.length) {
      const menu = all
        .map(
          (agent, index) =>
            `${index + 1}. ${agent.displayName}${defaults.has(agent.id) ? ' (detected/configured)' : ''}`
        )
        .join('\n');
      for (;;) {
        const answer = await ask!(
          `Choose agents (comma-separated numbers${ids.length ? '; Enter for detected/configured' : ''}):\n${menu}`
        );
        if (answer == null) return makePlan(false);
        const selected = answer.trim()
          ? answer.split(',').map((value) => all[Number(value.trim()) - 1]?.id)
          : ids;
        if (selected.length && selected.every(Boolean)) {
          ids = selected as string[];
          break;
        }
        Log.progress('Select at least one agent from the list.');
      }
    }
    if (!ids.length && (options.plugins !== false || (projectRoot && options.agentSkills))) {
      throw new CommandError(
        'BAD_ARGS',
        `No coding agent was detected. Pass --agent <agent>: ${all.map((agent) => agent.id).join(', ')}.`
      );
    }
    agents = [...new Set(ids)].map((id) => all.find((agent) => agent.id === id)!);
    if (!options.yes && !options.scope && projectRoot) {
      for (;;) {
        const codexNote =
          agents.some((agent) => agent.id === 'codex') && options.plugins !== false
            ? '\nCodex: Project installs skills; User home installs the Expo plugin and marketplace.'
            : '';
        const answer = await ask!(
          `Where should Expo plugins/skills be installed?\n1. Project: ${projectRoot} (default)\n2. User home: ${os.homedir()}${codexNote}`
        );
        if (answer == null) return makePlan(false);
        if (answer === '' || answer === '1' || answer === '2') {
          scope = answer === '2' ? 'user' : 'project';
          break;
        }
        Log.progress('Choose 1 or 2.');
      }
    }
    const plan = makePlan(false);
    const lines = [`Set up Expo agents (${scope}): ${plan.destination}`];
    for (const installer of plan.installers) {
      lines.push(`${installer.name}: ${installer.provider === 'skills' ? 'skills' : 'plugin'}`);
      for (const command of installer.commands) lines.push(`  ${displayInstallCommand(command)}`);
    }
    if (projectRoot) {
      if (options.agentSkills) lines.push(`Sync package skills in ${projectRoot}.`);
      if (options.agentsMd)
        lines.push(`Update the existing AGENTS.md managed block in ${projectRoot}.`);
    } else {
      lines.push(
        'No Expo project: project skill sync and instruction-file generation are skipped.'
      );
    }
    lines.push('Existing installations will be checked before installing.');
    if (options.yes) {
      Log.progress(lines.join('\n'));
      return { ...plan, confirmed: true };
    }
    const answer = await ask!(`${lines.join('\n')}\nContinue? [y/N]`);
    return { ...plan, confirmed: answer != null && /^(y|yes)$/i.test(answer) };
  } finally {
    prompt?.close();
  }
}
