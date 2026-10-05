// @ref llp/0029-feedback.rfc.md
import { printCommandHelp } from '../help/format';
import type { CommandHelp } from '../help/types';
import * as Log from '../log';
import { PROGRAM_PREFIX } from '../programName';
import { recordCommand } from '../telemetry';
import type { Command } from '../types';
import { assertWithOptionsArgs } from '../utils/args';
import { isTelemetryDisabled } from '../utils/env';
import { withStdoutRedirectedAsync } from '../utils/stdout';

const { version } = require('../../package.json') as { version: string };

export const feedbackHelp: CommandHelp = {
  command: 'feedback',
  usage: `${PROGRAM_PREFIX} feedback --message <message> [options]`,
  options: [
    '--message, -m <message>    Feedback message (40–5,000 characters)',
    '--category, -c <category>  Feedback category; defaults to unknown',
    '--subject, -s <subject>    Exact skill, URL, tool, command, or topic',
    '--resume <feedbackId>      Continue a feedback session using its ID',
    '--json                     Print the submission result as JSON',
    '--version, -v              Version number',
    '-h, --help                 Usage info',
  ],
  examples: [
    {
      run: `${PROGRAM_PREFIX} feedback --message "Please explain how to recover when the dev server disconnects."`,
      gets: 'sends feedback and prints a session ID for follow-up messages',
    },
    {
      run: `${PROGRAM_PREFIX} feedback -c skills -s expo-router -m "Please add an example of nested routes with shared layouts."`,
      gets: 'sends feedback about the expo-router skill',
    },
    {
      run: `${PROGRAM_PREFIX} feedback -c agent-cli -s "${PROGRAM_PREFIX} status" -m "Please explain which project changes require a new development build."`,
      gets: 'sends feedback about the agent CLI status command',
    },
    {
      run: `${PROGRAM_PREFIX} feedback --resume abc123 --message "The issue also happens after restarting the development server." --json`,
      gets: 'continues the same feedback session and prints its ID as JSON',
    },
  ],
  next: ['help'],
  json: {
    stdout: 'one object with the submission result',
    stderr: 'progress, warnings, and errors',
    keys: ['sent', 'feedbackId'],
  },
  notes: [
    'Choose --subject by category:',
    '  skills: exact skill name, such as expo-router.',
    '  docs: full Expo documentation URL.',
    '  mcp: exact MCP tool name.',
    '  expo-cli: full Expo CLI command, such as npx expo install.',
    '  eas-cli: full EAS CLI command, such as eas build.',
    `  agent-cli: full agent CLI command, such as ${PROGRAM_PREFIX} status.`,
    '  evals: Expo package, command, or capability the task involves.',
    '  simulator: EAS Simulator feature or workflow.',
    '  unknown: Expo product, package, feature, or topic, or leave it empty.',
    'Only a terminal can prompt for missing messages. Positional messages work but are deprecated.',
    'Includes agent, sandbox, environment, and project metadata; links your Expo account when signed in.',
    'Setting DO_NOT_TRACK or EXPO_NO_TELEMETRY to anything except 0 or false prevents feedback submission.',
    'Exit codes: 0 sent or opted out · 1 invalid input or submission failed.',
  ],
};

export const agentCliFeedback: Command = async (argv) => {
  const args = assertWithOptionsArgs(
    {
      '--help': Boolean,
      '--version': Boolean,
      '--message': String,
      '--category': String,
      '--subject': String,
      '--resume': String,
      '--json': Boolean,
      '-h': '--help',
      '-v': '--version',
      '-m': '--message',
      '-c': '--category',
      '-s': '--subject',
    },
    { argv, command: 'feedback', positionalArgs: 'own', permissive: false }
  );

  if (args['--help']) {
    printCommandHelp(feedbackHelp);
  }
  if (args['--version']) {
    Log.log(version);
    return;
  }

  const {
    createFeedbackMetadataAsync,
    getSession,
    resolveFeedbackAsync,
    sendFeedbackAsync,
    TELEMETRY_DISABLED_MESSAGE,
  } = await import('./feedbackAsync');

  if (isTelemetryDisabled()) {
    console.error(TELEMETRY_DISABLED_MESSAGE);
    if (args['--json']) {
      Log.log(JSON.stringify({ sent: false, feedbackId: null }));
    }
    return;
  }

  if (args._.length > 0 && args['--message'] === undefined) {
    console.warn(
      'Passing feedback as a positional argument is deprecated. Use --message or -m instead.'
    );
  }

  const { category, feedback } = await resolveFeedbackAsync(
    args._,
    args['--category'],
    args['--message']
  );
  const session = getSession();
  const collectMetadataAsync = () =>
    createFeedbackMetadataAsync(process.cwd(), category, args['--subject'], args['--resume']);
  // Project config can print diagnostics. JSON mode keeps them on stderr.
  const metadata = await (args['--json']
    ? withStdoutRedirectedAsync(collectMetadataAsync)
    : collectMetadataAsync());
  // Project config can enable an opt-out while metadata is collected. Only announce submission
  // and record command telemetry after that config has run and feedback remains enabled.
  if (!isTelemetryDisabled()) {
    if (args['--resume'] !== undefined && metadata.feedbackId !== args['--resume']) {
      console.warn(
        `The provided feedback ID is invalid, so a new one was generated: ${metadata.feedbackId}`
      );
    }
    console.error(
      'Submitting feedback with detected agent, sandbox, environment, and project metadata. Authenticated submissions are associated with your Expo account.'
    );
    recordCommand('feedback', version);
  }
  const sent = await sendFeedbackAsync({ feedback, metadata, session });

  if (args['--json']) {
    Log.log(JSON.stringify({ sent, feedbackId: sent ? metadata.feedbackId : null }));
  } else if (sent) {
    Log.log('Thanks for the feedback!');
    Log.log(
      `To continue the feedback session use:\n${PROGRAM_PREFIX} feedback --resume ${metadata.feedbackId} --message "<message>"`
    );
  }
};
