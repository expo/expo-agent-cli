// @ref llp/0029-feedback.rfc.md
import { printCommandHelp } from '../help/format';
import type { CommandHelp } from '../help/types';
import { PROGRAM_PREFIX } from '../programName';
import type { Command } from '../types';
import { assertWithOptionsArgs } from '../utils/args';

import { CLI_FEEDBACK_CATEGORIES, type CliFeedbackMetadata } from './types';

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
    `Categories: ${CLI_FEEDBACK_CATEGORIES.join(', ')}.`,
    'Without a message, prompts in a terminal; CI and non-interactive runs require one.',
    'Positional messages remain supported with a deprecation warning.',
    'Includes agent, sandbox, environment, and Expo project metadata.',
    'Authenticated submissions are associated with your Expo account.',
    'DO_NOT_TRACK=1 or EXPO_NO_TELEMETRY=1 prevents feedback submission.',
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
    { argv, command: 'feedback', positionalArgs: 'own', permissive: true }
  );

  if (args['--help']) {
    printCommandHelp(feedbackHelp);
  }
  if (args['--version']) {
    console.log(require('../../package.json').version);
    return;
  }

  const {
    createFeedbackMetadataAsync,
    getSession,
    isTelemetryDisabled,
    resolveFeedbackAsync,
    sendFeedbackAsync,
    TELEMETRY_DISABLED_MESSAGE,
  } = await import('./feedbackAsync');

  if (isTelemetryDisabled()) {
    console.error(TELEMETRY_DISABLED_MESSAGE);
    if (args['--json']) {
      console.log(JSON.stringify({ sent: false, feedbackId: null }));
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
  // Evaluating app.config.js can print through console or write directly to stdout.
  // Keep that diagnostic output off the JSON result, restoring stdout even on failure.
  const originalWrite = process.stdout.write;
  let metadata: CliFeedbackMetadata;
  try {
    if (args['--json']) {
      process.stdout.write = process.stderr.write.bind(process.stderr);
    }
    metadata = await createFeedbackMetadataAsync(
      process.cwd(),
      category,
      args['--subject'],
      args['--resume']
    );
  } finally {
    process.stdout.write = originalWrite;
  }
  if (args['--resume'] !== undefined && metadata.feedbackId !== args['--resume']) {
    console.warn(
      `The provided feedback ID is invalid, so a new one was generated: ${metadata.feedbackId}`
    );
  }

  console.error(
    'Submitting feedback with detected agent, sandbox, environment, and project metadata. Authenticated submissions are associated with your Expo account.'
  );
  const sent = await sendFeedbackAsync({ feedback, metadata, session });

  if (args['--json']) {
    console.log(JSON.stringify({ sent, feedbackId: sent ? metadata.feedbackId : null }));
  } else if (sent) {
    console.log('Thanks for the feedback!');
    console.log(
      `To continue the feedback session use:\n${PROGRAM_PREFIX} feedback --resume ${metadata.feedbackId} --message "<message>"`
    );
  }
};
