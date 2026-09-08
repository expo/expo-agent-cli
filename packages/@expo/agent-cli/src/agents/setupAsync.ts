// @ref llp/0006-agent-native-cli-surface.rfc.md §The `@expo/agent-cli` launcher, §Errors are prompts
// Plugin installation and project setup run independently so a failure in one can be reported
// without discarding useful work in the other.
import chalk from 'chalk';

import { EXIT_OUTCOME_FAILED, exitWithCodeAsync } from '../exitCodes';
import * as Log from '../log';
import { PROGRAM_PREFIX } from '../programName';
import {
  detectInstalledAgentsAsync,
  getAllAgents,
  getPersistedAgentIdsAsync,
  resolveAgentsAsync,
} from '../skills/agents';
import { discoverSkillsAsync } from '../skills/discovery';
import { syncSkillsAsync } from '../skills/skillsAsync';
import type { DiscoveredSkill, SkillsAgent } from '../skills/types';
import { ensureClaudeMdReferenceAsync } from './agentsMd';
import { event } from './events';
import { installAgentAsync } from './installers';
import { prepareSetupAsync } from './plan';
import { writeProjectInstructionsAsync } from './projectInstructions';
import { withStdoutRedirectedAsync } from './stdout';
import type { SetupOptions, SetupReport } from './types';

/** Width of the label column of the text summary, matching `@expo/agent-cli status`. */
const LABEL_WIDTH = 12;

/** Run the setup, emit the summary event, and print the report. */
export async function printSetupAsync(
  projectRoot: string | null,
  options: SetupOptions
): Promise<void> {
  const report = await runSetupAsync(projectRoot, options);

  event('setup_completed', {
    agents: report.agents,
    skillsSynced: report.skills?.synced ?? false,
    skillsDiscovered: report.skills?.discovered ?? 0,
    agentsMdAction: report.agentsMd?.action ?? null,
    claudeMdAction: report.claudeMd?.action ?? null,
    noteCount: report.notes.length,
    scope: report.scope,
    cancelled: report.cancelled,
    plugins: report.plugins,
    errors: report.errors,
  });

  if (options.json) {
    Log.log(JSON.stringify(report, null, 2));
  } else {
    for (const line of summaryLines(report)) {
      Log.log(line);
    }
    for (const note of report.notes) {
      Log.warn(note);
    }
    for (const error of report.errors) Log.warn(error);
  }
  if (report.errors.length) await exitWithCodeAsync(EXIT_OUTCOME_FAILED);
}

/** Confirm the complete plan before any installer, project probe, or file writer runs. */
export async function runSetupAsync(
  projectRoot: string | null,
  options: SetupOptions
): Promise<SetupReport> {
  const plan = await prepareSetupAsync(projectRoot, options);
  const report: SetupReport = {
    projectRoot,
    scope: plan.scope,
    cancelled: !plan.confirmed,
    plugins: [],
    errors: [],
    skills: null,
    agentsMd: null,
    claudeMd: null,
    agents: plan.agents.map((agent) => agent.id),
    notes: [],
  };
  if (!plan.confirmed) return report;

  for (const installer of plan.installers) {
    const result = await installAgentAsync(installer);
    report.plugins.push(result);
    if (result.status === 'failed') report.errors.push(`${installer.name}: ${result.reason}`);
  }
  if (projectRoot) {
    await setupProjectAsync(projectRoot, { ...options, agents: report.agents }, report);
  } else {
    report.notes.push('No Expo project: package skill sync and AGENTS.md generation were skipped.');
  }
  return report;
}

async function setupProjectAsync(
  projectRoot: string,
  options: SetupOptions,
  report: SetupReport
): Promise<void> {
  let agents: SkillsAgent[] = [];
  let discovered: DiscoveredSkill[] | null = null;
  if (options.agentSkills) {
    try {
      const resolved = await resolveAgentsAsync(projectRoot, { agents: options.agents });
      agents = resolved.agents;
      discovered = await discoverSkillsAsync(projectRoot);
      const syncAsync = () =>
        syncSkillsAsync(projectRoot, {
          agents: agents.map((agent) => agent.id),
          dryRun: false,
          updateAgentsMd: false,
        });
      await (options.json ? withStdoutRedirectedAsync(syncAsync) : syncAsync());
      report.skills = {
        synced: true,
        discovered: discovered.length,
        packages: new Set(discovered.map((skill) => skill.packageName)).size,
        agents: agents.map((agent) => agent.id),
        skillsDirs: uniqueSkillsDirs(agents),
      };
    } catch (error) {
      const detail =
        (error as NodeJS.ErrnoException)?.code === 'MODULE_NOT_FOUND'
          ? 'Expo autolinking is unavailable. Install the project dependencies and rerun setup.'
          : errorMessage(error);
      report.errors.push(`Package skills: ${detail}`);
      agents = await readConfiguredAgentsAsync(projectRoot);
    }
  } else {
    agents = await readConfiguredAgentsAsync(projectRoot);
  }
  if (options.plugins === false) report.agents = agents.map((agent) => agent.id);

  if (options.agentsMd) {
    try {
      report.agentsMd = await writeProjectInstructionsAsync(projectRoot, discovered);
    } catch (error) {
      report.errors.push(`AGENTS.md: ${errorMessage(error)}`);
    }
    if (report.agentsMd && options.agents.includes('claude-code')) {
      try {
        report.claudeMd = await ensureClaudeMdReferenceAsync(projectRoot);
      } catch (error) {
        report.errors.push(`CLAUDE.md: ${errorMessage(error)}`);
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The agents already configured for this project: the cached selection, or the detected ones.
 *
 * Read-only by contract — it never prompts and never fails — because it runs on the path where
 * nothing is linked and the answer only fills in one line of the generated block.
 */
async function readConfiguredAgentsAsync(projectRoot: string): Promise<SkillsAgent[]> {
  const persistedIds = await getPersistedAgentIdsAsync(projectRoot);
  if (persistedIds != null) {
    return getAllAgents().filter((agent) => persistedIds.includes(agent.id));
  }
  return await detectInstalledAgentsAsync(projectRoot);
}

function uniqueSkillsDirs(agents: SkillsAgent[]): string[] {
  return [...new Set(agents.map((agent) => agent.skillsDir))];
}

function summaryLines(report: SetupReport): string[] {
  const lines: string[] = [];
  const row = (label: string, value: string) =>
    lines.push(`${chalk.dim(label.padEnd(LABEL_WIDTH))}${value}`);

  if (report.cancelled) return ['Setup cancelled; nothing was changed.'];
  row('Scope', report.scope);
  for (const plugin of report.plugins) {
    row(plugin.agent, `${plugin.provider}: ${plugin.status}`);
    if (plugin.reason && plugin.status !== 'failed') lines.push(plugin.reason);
  }

  // A completed sync already printed its own summary line, so it is not repeated here.
  if (!report.skills) {
    row(
      'Skills',
      chalk.dim(
        !report.projectRoot
          ? 'skipped (no project)'
          : report.errors.some((error) => error.startsWith('Package skills:'))
            ? 'failed (see errors)'
            : 'skipped (--no-agent-skills)'
      )
    );
  }

  if (report.agentsMd) {
    row('AGENTS.md', `${report.agentsMd.action} (managed block)`);
  } else {
    row(
      'AGENTS.md',
      chalk.dim(
        !report.projectRoot
          ? 'skipped (no project)'
          : report.errors.some((error) => error.startsWith('AGENTS.md:'))
            ? 'failed (see errors)'
            : 'skipped (--no-agents-md)'
      )
    );
  }

  if (report.claudeMd) row('CLAUDE.md', `${report.claudeMd.action} (shared instructions)`);

  if (report.projectRoot) row('Next', chalk.bold(`${PROGRAM_PREFIX} status`));

  return lines;
}
