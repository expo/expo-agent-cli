// @ref llp/0030-local-docs.rfc.md §Commands
import { printCommandHelp } from '../help/format';
import type { CommandHelp } from '../help/types';
import { PROGRAM_PREFIX } from '../programName';
import type { Command } from '../types';
import { assertWithOptionsArgs } from '../utils/args';

export const docsSyncHelp: CommandHelp = {
  command: 'docs:sync',
  usage: `${PROGRAM_PREFIX} docs:sync`,
  options: [
    `--sdk <N>                Sync the docs of SDK N instead of the project's SDK`,
    `--force                  Download the bundles even when they are unchanged`,
    `--json                   Print the result as one JSON object`,
    `--no-followups           Skip the "Suggested next:" section of suggested follow-up commands`,
    `-h, --help               Usage info`,
  ],
  examples: [
    {
      run: `${PROGRAM_PREFIX} docs:sync`,
      gets: `the docs as .md files for the project's SDK, and the two directories to grep`,
    },
    {
      run: `${PROGRAM_PREFIX} docs:sync --sdk 55 --json`,
      gets: 'the SDK 55 docs, with the directories under dir and sdkDir',
    },
  ],
  next: ['docs:search'],
  json: {
    stdout: 'one object, and nothing else',
    stderr: 'progress and errors',
    keys: ['dir', 'sdkDir', 'sdk', 'latest', 'baseUrl', 'bundles', 'followups'],
  },
  notes: [
    `Agents: grep the two printed directories, and read the matching files. A file path is the page's`,
    `path on docs.expo.dev plus .md. Only changed bundles are downloaded. Outside a project, and for an`,
    `SDK without docs, the latest SDK is synced. AGENT_CLI_DOCS_DIR moves the cache from`,
    `~/.expo/agent-cli/docs; AGENT_CLI_DOCS_URL changes where the bundles come from.`,
  ],
};

export const docsSearchHelp: CommandHelp = {
  command: 'docs:search',
  usage: `${PROGRAM_PREFIX} docs:search <query>`,
  options: [
    `--regex                  Read the query as a regular expression, and match single lines`,
    `--sdk <N>                Search the docs of SDK N instead of the project's SDK`,
    `--limit <n>              Print at most n hits (default 20)`,
    `--json                   Print the result as one JSON object`,
    `--no-followups           Skip the "Suggested next:" section of suggested follow-up commands`,
    `-h, --help               Usage info`,
  ],
  examples: [
    {
      run: `${PROGRAM_PREFIX} docs:search barcode scanning`,
      gets: 'the pages with both words, best first, each with a file and a line',
    },
    {
      run: `${PROGRAM_PREFIX} docs:search --regex "launchScanner\\(" --sdk 55`,
      gets: 'every line that matches, in the SDK 55 docs',
    },
    {
      run: `${PROGRAM_PREFIX} docs:search expo-camera --json`,
      gets: 'the same as one object, hits under hits',
    },
  ],
  next: ['docs:sync'],
  json: {
    stdout: 'one object, and nothing else',
    stderr: 'progress, the sync it ran, and errors',
    keys: ['dir', 'sdk', 'query', 'hits', 'followups'],
  },
  notes: [
    `Terms are case-insensitive and must all be on a page. Title matches rank first, then the path,`,
    `then headings, then the text. The scope is the shared docs plus one SDK version. The docs are`,
    `synced first when they are missing, unless EXPO_OFFLINE is set.`,
  ],
};

export const agentCliDocsSync: Command = async (argv) => {
  const args = assertWithOptionsArgs(
    {
      '--help': Boolean,
      '--json': Boolean,
      '--sdk': String,
      '--force': Boolean,
      '--no-followups': Boolean,
      '-h': '--help',
    },
    {
      argv,
      command: 'docs:sync',
      positionalArgs: 'none',
      strayHint: `to search the docs for it, run "${PROGRAM_PREFIX} docs:search <query>".`,
    }
  );
  if (args['--help']) {
    printCommandHelp(docsSyncHelp);
  }

  const { logCmdError } = require('../utils/errors') as typeof import('../utils/errors');
  const { runDocsSyncAsync } = require('./docsAsync') as typeof import('./docsAsync');
  try {
    await runDocsSyncAsync({
      sdkFlag: args['--sdk'],
      force: !!args['--force'],
      json: !!args['--json'],
      followups: !args['--no-followups'],
    });
  } catch (error: any) {
    logCmdError(error);
  }
};

export const agentCliDocsSearch: Command = async (argv) => {
  const args = assertWithOptionsArgs(
    {
      '--help': Boolean,
      '--json': Boolean,
      '--sdk': String,
      '--regex': Boolean,
      '--limit': String,
      '--no-followups': Boolean,
      '-h': '--help',
    },
    { argv, command: 'docs:search', positionalArgs: 'own' }
  );
  if (args['--help']) {
    printCommandHelp(docsSearchHelp);
  }

  const { logCmdError } = require('../utils/errors') as typeof import('../utils/errors');
  const { runDocsSearchAsync } = require('./docsAsync') as typeof import('./docsAsync');
  try {
    await runDocsSearchAsync({
      query: args._.join(' '),
      regex: !!args['--regex'],
      sdkFlag: args['--sdk'],
      limit: args['--limit'],
      json: !!args['--json'],
      followups: !args['--no-followups'],
    });
  } catch (error: any) {
    logCmdError(error);
  }
};
