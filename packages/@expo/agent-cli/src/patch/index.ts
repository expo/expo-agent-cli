// @ref llp/0037-patch-command.rfc.md §Command surface

import { EXIT_OK, type OutcomeExitCode } from '../exitCodes';
import { printCommandHelp } from '../help/format';
import type { CommandHelp } from '../help/types';
import { PROGRAM_PREFIX } from '../programName';
import type { Command } from '../types';
import { assertWithOptionsArgs } from '../utils/args';

export const patchHelp: CommandHelp = {
  command: 'patch',
  usage: `${PROGRAM_PREFIX} patch <package> [options]`,
  options: [
    `--upstream-plan   Print a plan for a pull request to expo/expo; opens nothing`,
    `--repro <url>     With --upstream-plan: the GitHub repository with the minimal repro`,
    `-y, --yes         Consent to the patch-package setup in package.json (npm, yarn classic)`,
    `--json            Print the report as JSON`,
    `--no-followups    Leave the suggested follow-up commands out of the report`,
    `-h, --help        Usage info`,
  ],
  examples: [
    {
      run: `${PROGRAM_PREFIX} patch expo-image`,
      gets: `the edits in node_modules/expo-image saved as a patch, with the project's package manager`,
    },
    {
      run: `${PROGRAM_PREFIX} patch expo-image --json`,
      gets: 'the same, as one JSON object: the patch file, buildFromSource and the follow-ups',
    },
    {
      run: `${PROGRAM_PREFIX} patch expo-image --upstream-plan --repro https://github.com/<user>/<repo>`,
      gets: 'the facts and the steps for a pull request to expo/expo; nothing is opened',
    },
  ],
  next: ['dev', 'runtime:reload'],
  json: {
    stdout: 'one object, and nothing else',
    stderr: 'progress and errors',
    keys: [
      'projectRoot',
      'packageManager',
      'package',
      'version',
      'patchFile',
      'files',
      'native',
      'buildFromSource',
      'upstream',
      'followups',
    ],
  },
  notes: [
    `Edit the files in node_modules/<package> first, then run this once. The patch is saved with`,
    `bun patch, pnpm patch, yarn patch or npm patch (npm 12) when the project has one, and in`,
    `patch-package's format otherwise (that one exits 1 until --yes allows the postinstall script).`,
    `A native change to a precompiled module also adds it to expo.autolinking.<platform>.buildFromSource.`,
    `--upstream-plan exits 0 and opens nothing: the agent asks the user, then does the steps with git and gh.`,
  ],
};

export const agentCliPatch: Command = async (argv) => {
  const args = assertWithOptionsArgs(
    {
      // Types
      '--help': Boolean,
      '--json': Boolean,
      '--yes': Boolean,
      '--upstream-plan': Boolean,
      '--repro': String,
      '--no-followups': Boolean,
      // Aliases
      '-h': '--help',
      '-y': '--yes',
    },
    { argv, command: 'patch', positionalArgs: 'own' }
  );

  if (args['--help']) {
    printCommandHelp(patchHelp);
  }

  const { CommandError } = require('../utils/errors') as typeof import('../utils/errors');
  const { findUpProjectRootOrAssert } =
    require('../utils/findUp') as typeof import('../utils/findUp');

  return (async (): Promise<OutcomeExitCode> => {
    if (args._.length !== 1) {
      const error = new CommandError(
        'BAD_ARGS',
        `patch takes exactly one package name, e.g. "${PROGRAM_PREFIX} patch expo-image".`
      );
      error.suggestedCommand = `${PROGRAM_PREFIX} patch --help`;
      throw error;
    }
    if (args['--repro'] && !args['--upstream-plan']) {
      throw new CommandError('BAD_ARGS', '--repro is only read with --upstream-plan.');
    }
    if (args['--yes'] && args['--upstream-plan']) {
      throw new CommandError(
        'BAD_ARGS',
        '--upstream-plan opens nothing, so there is nothing to consent to: ask the user, then follow its steps.'
      );
    }
    const packageName = args._[0]!;
    if (!isPackageName(packageName)) {
      const error = new CommandError(
        'BAD_ARGS',
        `"${packageName}" is not an npm package name. patch takes the name as it is in package.json, e.g. "expo-image" or "@expo/ui".`
      );
      error.suggestedCommand = `${PROGRAM_PREFIX} patch --help`;
      throw error;
    }
    const projectRoot = findUpProjectRootOrAssert(process.cwd());
    const json = !!args['--json'];

    if (args['--upstream-plan']) {
      const { planUpstream, printUpstreamPlan } =
        require('./upstream') as typeof import('./upstream');
      const plan = planUpstream(projectRoot, packageName, { repro: args['--repro'] ?? null });
      printUpstreamPlan(plan, { json });
      return EXIT_OK;
    }

    const { patchAsync } = require('./patchAsync') as typeof import('./patchAsync');
    await patchAsync(projectRoot, packageName, {
      json,
      yes: !!args['--yes'],
      followups: !args['--no-followups'],
    });
    return EXIT_OK;
  })();
};

/**
 * npm's rules for a package name, with upper case allowed for old packages. The name becomes a path
 * under `node_modules`, so `..`, a leading `.` and a stray `/` are refused here.
 */
export function isPackageName(name: string): boolean {
  return /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i.test(name);
}
