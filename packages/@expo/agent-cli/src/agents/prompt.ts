import { confirm, multiselect } from '@clack/prompts';

import type { SkillsAgent } from '../skills/types';
import { askAsync } from '../utils/prompts';

export interface SetupPrompt {
  selectAgents(agents: SkillsAgent[], defaults: string[]): Promise<string[] | null>;
  confirm(): Promise<boolean | null>;
}

export function createSetupPrompt(): SetupPrompt {
  return {
    selectAgents(agents, defaults) {
      return askAsync((io) =>
        multiselect({
          ...io,
          message: 'Which agents should Expo set up?',
          options: agents.map((agent) => ({
            value: agent.id,
            label: agent.displayName,
            hint: defaults.includes(agent.id) ? 'detected/configured' : undefined,
          })),
          initialValues: defaults,
          required: true,
        })
      );
    },
    confirm() {
      return askAsync((io) =>
        confirm({
          ...io,
          message: 'Continue with setup?',
          initialValue: false,
        })
      );
    },
  };
}
