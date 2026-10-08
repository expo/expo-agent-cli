// @ref llp/0012-build-explain.rfc.md
// `@expo/agent-cli inspect:build-log`, which the v1 narrowing renamed from `build:explain` (llp/0016): the
// `build` group it was in held one command that started nothing and one that waited on a build
// somebody else started, and `inspect` is the group named after what the caller is actually doing.
// The bare `build` verb is now a name this CLI does not have, answered by the absent-capability
// table in `src/commandRegistry.ts` with `npx eas build`.
//
// The directory is still `src/builds/` and not `src/inspect/`: it is what llp/0012 and the rule
// fixtures name throughout, and moving it would rewrite a hundred references to say nothing new.
// (`src/build/` was never available — the repository's `.gitignore` has `/packages/**/build/`.)

import { printCommandHelp } from '../help/format';
import type { CommandHelp } from '../help/types';
import { PROGRAM_NAME, PROGRAM_PREFIX } from '../programName';
import type { Command } from '../types';
import { assertWithOptionsArgs } from '../utils/args';

export const inspectBuildLogHelp: CommandHelp = {
  command: 'inspect:build-log',
  usage: `${PROGRAM_PREFIX} inspect:build-log --file <path> | --stdin | --local | --eas [<build-id>]`,
  options: [
    `--file <path>          Read the log from this file`,
    `--stdin                Read the log from stdin. Implied when stdin is not a terminal`,
    `--local                Read the log of the last native build ${PROGRAM_NAME} dev ran here,\n` +
      `                       for the platform named. Needs --ios or --android`,
    `--eas [<build-id>]     Read the log of an EAS build: the id given, or the last errored\n` +
      `                       build of the platform named. Needs --ios or --android`,
    `--ios | --android      Which platform: the log to read under --local and --eas, a hint otherwise`,
    `--context <n[:m]>      Lines of context around the match. Default: 8 before, 20 after`,
    `--all                  Report every match, not only the failing phase's first`,
    `--json                 Print the report as JSON`,
    `--no-followups         Skip the "Suggested next:" section of suggested follow-up commands`,
    `-h, --help             Usage info`,
  ],
  examples: [
    {
      run: `${PROGRAM_PREFIX} inspect:build-log --file ~/Downloads/xcodebuild.log`,
      gets: 'the failing phase, the line it failed on, and the lines around it',
    },
    {
      run: `${PROGRAM_PREFIX} inspect:build-log --local --ios`,
      gets: `what failed in the last iOS build ${PROGRAM_NAME} dev ran in this project`,
    },
    {
      run: `${PROGRAM_PREFIX} inspect:build-log --eas --android`,
      gets: 'what failed in the last errored Android build on EAS, fetched from EAS',
    },
    {
      run: `${PROGRAM_PREFIX} inspect:build-log --stdin --json`,
      gets: 'the same from a piped log, as one object',
    },
  ],
  next: ['doctor', 'status'],
  json: {
    stdout: 'one object, and nothing else',
    stderr: 'progress and errors',
    keys: ['source', 'phases', 'failure', 'otherFailures', 'errorLines', 'logTail', 'followups'],
  },
  notes: [
    `Deterministic extraction, not summarization: a capped rule table, each rule with a fixture`,
    `and a test. Every answer carries the line it came from, and "errorLines" carries what the`,
    `tools themselves marked as errors in the failing phase — rule or no rule.`,
    `Exit codes: 0 a report was produced, "no error located" included · 1 no report could be`,
    `produced · 22 what arrived is not text, most often a log still brotli-compressed.`,
    `${PROGRAM_NAME} dev writes the output of each native build it runs to .expo/dev/logs/build-<platform>.log`,
    `when no terminal is watching it, which is what --local reads. A build watched on a terminal`,
    `writes none: pipe its output in instead.`,
    `--eas asks EAS twice ("build:list" for the last errored build unless an id is given, then`,
    `"build:view" for the build's log files), downloads the files and decodes them. A build id on`,
    `its own means --eas: "${PROGRAM_PREFIX} inspect:build-log --ios <build-id>".`,
  ],
};

export const agentCliInspectBuildLog: Command = async (argv) => {
  const args = assertWithOptionsArgs(
    {
      // Types
      '--help': Boolean,
      // Aliases
      '-h': '--help',
    },
    {
      argv,
      // The rest is resolved by `resolveExplainOptions`, which reports a bad flag as a
      // CommandError.
      permissive: true,
      command: 'inspect:build-log',
      // The build-id positional is reserved rather than rejected here: `resolveExplainOptions`
      // owns the message that says why it does not work yet and what does.
      positionalArgs: 'own',
    }
  );

  if (args['--help']) {
    printCommandHelp(inspectBuildLogHelp);
  }

  // Load modules after the help prompt so `npx @expo/agent-cli inspect:build-log -h` shows as fast as possible.
  const { logCmdError } = require('../utils/errors') as typeof import('../utils/errors');
  const { findUpProjectRootOrAssert } =
    require('../utils/findUp') as typeof import('../utils/findUp');
  const { resolveExplainOptions } =
    require('./explain/resolveOptions') as typeof import('./explain/resolveOptions');
  const { explainAsync } =
    require('./explain/explainAsync') as typeof import('./explain/explainAsync');

  return (async () => {
    const options = resolveExplainOptions(argv ?? [], {
      stdinIsTTY: !!process.stdin.isTTY,
      cwd: process.cwd(),
      // Asked only under `--local`: a saved or piped log explains from anywhere.
      projectRoot: () => findUpProjectRootOrAssert(process.cwd()),
    });
    await explainAsync(options);
  })().catch(logCmdError);
};
