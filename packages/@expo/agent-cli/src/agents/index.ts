import { printCommandHelp } from '../help/format';
import type { CommandHelp } from '../help/types';
import { PROGRAM_PREFIX } from '../programName';
import type { Command } from '../types';
import { assertWithOptionsArgs } from '../utils/args';

export const agentsSetupHelp: CommandHelp = {
  command: 'agents:setup',
  usage: `${PROGRAM_PREFIX} agents:setup`,
  options: [
    `--yes               Accept the setup plan without prompting`,
    `--project           Install plugins/skills in the Expo project instead of user home`,
    `--no-plugins        Skip official Expo plugin/skills installation`,
    `--agent <agent>     Set up for specific agents (can be used multiple times)`,
    `--no-agents-md      Do not create or update AGENTS.md or CLAUDE.md`,
    `--no-agent-skills   Do not link the agent skills of the installed packages`,
    `--json              Print the result as JSON`,
    `-h, --help          Usage info`,
  ],
  examples: [
    {
      run: `${PROGRAM_PREFIX} agents:setup`,
      gets: 'choose agents and confirm user-home installation plus any project setup',
    },
    {
      run: `${PROGRAM_PREFIX} agents:setup --yes --agent claude-code --json`,
      gets: 'install the Claude Expo plugin in user home; report project setup when available',
    },
    {
      run: `${PROGRAM_PREFIX} agents:setup --project --agent codex`,
      gets: 'confirm project-local Expo skills installation for Codex',
    },
    {
      run: `${PROGRAM_PREFIX} agents:setup --yes --agent claude-code --no-plugins --json`,
      gets: 'create the Claude project guide and link package skills without installing plugins or prompting',
    },
  ],
  next: ['skills:list', 'status', 'dev'],
  json: {
    stdout: 'one object, and nothing else',
    stderr: 'progress and errors',
    keys: [
      'projectRoot',
      'scope',
      'cancelled',
      'plugins',
      'errors',
      'skills',
      'agentsMd',
      'claudeMd',
      'agents',
      'notes',
    ],
  },
  notes: [
    `Plugins/skills install in user home by default. --project requires an Expo app and installs`,
    `skills for Codex instead of its user-wide plugin. Use --yes for non-interactive setup.`,
    `Inside an Expo app, package skill sync and AGENTS.md generation run with either scope.`,
    `Safe to run again at any time. Everything outside the AGENTS.md block markers is yours and`,
    `is left untouched. For Claude, setup creates or appends an @AGENTS.md import to CLAUDE.md.`,
  ],
};

export const agentCliAgentsSetup: Command = async (argv) => {
  const args = assertWithOptionsArgs(
    {
      // Types
      '--help': Boolean,
      '--json': Boolean,
      '--yes': Boolean,
      '--project': Boolean,
      '--no-plugins': Boolean,
      '--agent': [String],
      '--no-agents-md': Boolean,
      '--no-agent-skills': Boolean,
      // Aliases
      '-h': '--help',
    },
    { argv, command: 'agents:setup', positionalArgs: 'none' }
  );

  if (args['--help']) {
    printCommandHelp(agentsSetupHelp);
  }

  // Load modules after the help prompt so `npx @expo/agent-cli agents:setup -h` shows as fast as possible.
  const { logCmdError } = require('../utils/errors') as typeof import('../utils/errors');
  const { findSetupProjectRoot } = require('./plan') as typeof import('./plan');
  const { printSetupAsync } = require('./setupAsync') as typeof import('./setupAsync');

  return (async () => {
    const projectRoot = findSetupProjectRoot(process.cwd());
    await printSetupAsync(projectRoot, {
      yes: !!args['--yes'],
      project: !!args['--project'],
      plugins: !args['--no-plugins'],
      agents: args['--agent'] ?? [],
      agentsMd: !args['--no-agents-md'],
      agentSkills: !args['--no-agent-skills'],
      json: !!args['--json'],
    });
  })().catch(logCmdError);
};
