// @ref llp/0006-agent-native-cli-surface.rfc.md §Shared instruction files
import { readProjectPackageJsonAsync } from '../project/nodeModules';
import { probeProjectStateAsync } from '../project/probe';
import { getAllAgents } from '../skills/agents';
import { discoverSkillsAsync } from '../skills/discovery';
import type { DiscoveredSkill } from '../skills/types';
import { writeManagedBlockAsync } from './agentsMd';
import { generateAgentsMdBlock } from './content';
import { collectLinkedSkillsAsync } from './skillIndex';
import type { AgentsMdResult } from './types';

/** Shared by setup and scaffolding, including projects whose dependencies are not installed. */
export async function writeProjectInstructionsAsync(
  projectRoot: string,
  discovered?: DiscoveredSkill[] | null
): Promise<AgentsMdResult> {
  const [state, packageJson] = await Promise.all([
    probeProjectStateAsync(projectRoot),
    readProjectPackageJsonAsync(projectRoot),
  ]);
  discovered ??= await discoverSkillsAsync(projectRoot).catch(() => null);
  const linkedSkills =
    discovered == null
      ? null
      : await collectLinkedSkillsAsync(
          projectRoot,
          discovered,
          getAllAgents().map((agent) => agent.skillsDir)
        );
  return writeManagedBlockAsync(
    projectRoot,
    generateAgentsMdBlock({
      state,
      projectName: packageJson?.name ?? null,
      linkedSkills,
    })
  );
}
