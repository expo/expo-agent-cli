import { confirm, isCancel, multiselect, select, type CommonOptions } from '@clack/prompts';

import type { SkillsAgent } from '../skills/types';
import type { SetupScope } from './types';

export interface SetupPrompt {
  selectAgents(agents: SkillsAgent[], defaults: string[]): Promise<string[] | null>;
  selectScope(
    projectRoot: string,
    homeDir: string,
    includesCodex: boolean
  ): Promise<SetupScope | null>;
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
    selectScope(projectRoot, homeDir, includesCodex) {
      return askAsync((io) =>
        select<SetupScope>({
          ...io,
          message: 'Where should Expo plugins/skills be installed?',
          options: [
            {
              value: 'project',
              label: 'Project',
              hint: `${projectRoot}${includesCodex ? ' · Expo skills for Codex' : ''}`,
            },
            {
              value: 'user',
              label: 'User home',
              hint: `${homeDir}${includesCodex ? ' · Expo plugin and marketplace for Codex' : ''}`,
            },
          ],
          initialValue: 'project',
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

/** Clack handles Escape and Ctrl-C, but stdin EOF and Ctrl-D also need to cancel setup. */
async function askAsync<T>(prompt: (io: CommonOptions) => Promise<T | symbol>): Promise<T | null> {
  const input = process.stdin;
  if (input.readableEnded || input.destroyed) return null;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const onKeypress = (_value: string, key: { ctrl?: boolean; name?: string }) => {
    if (key.ctrl && key.name === 'd') cancel();
  };
  input.once('end', cancel);
  input.once('close', cancel);
  input.on('keypress', onKeypress);
  try {
    const result = await prompt({ input, output: process.stderr, signal: controller.signal });
    return isCancel(result) ? null : (result as T);
  } finally {
    input.off('end', cancel);
    input.off('close', cancel);
    input.off('keypress', onKeypress);
    input.pause();
  }
}
