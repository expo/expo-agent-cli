import { printCommandHelp } from '../help/format';
import type { CommandHelp } from '../help/types';
import { PROGRAM_PREFIX } from '../programName';
import type { Command } from '../types';
import { assertWithOptionsArgs } from '../utils/args';

export const statusHelp: CommandHelp = {
  command: 'status',
  usage: `${PROGRAM_PREFIX} status`,
  options: [
    `--json                    Print the whole report as JSON, raw project probe included`,
    `--assert <class>          Exit 20 when the change costs more than this class, and 22\n` +
      `                          when no class could be established. Without it, always 0`,
    `--build <id>              Compare against an EAS build instead of the last build this CLI\n` +
      `                          recorded. Asks EAS for that build's fingerprint`,
    `--device <name>           Read the installed app on this simulator, emulator or device\n` +
      `                          only, by name, UDID or adb serial. For a physical iPhone this\n` +
      `                          is the consent to launch the app on it`,
    `--device-timeout <secs>   Seconds a phone gets to answer (default: 15)`,
    `--dev-server-url <url>    Dev server to probe (default: the project's own, then 8081-8085)`,
    `--no-followups            Leave the suggested follow-up commands out of the report`,
    `--no-fingerprint-cache    Ask everything again — hash the project, evaluate the app config,\n` +
      `                          ask EAS — instead of trusting the records under .expo`,
    `-h, --help                Usage info`,
  ],
  examples: [
    {
      run: `${PROGRAM_PREFIX} status`,
      gets: 'the brief: what this project is, what is running, and the command to run next',
    },
    {
      run: `${PROGRAM_PREFIX} status --json`,
      gets: 'the same as one object, with the raw project probe under probe',
    },
    {
      run: `${PROGRAM_PREFIX} status --assert js-only`,
      gets: 'exit 20 when the change needs more than a reload; a gate for a script',
    },
    {
      run: `${PROGRAM_PREFIX} status --build <id>`,
      gets: 'this working tree against the fingerprint EAS computed for one build',
    },
  ],
  next: ['dev', 'smoke', 'doctor'],
  json: {
    stdout: 'one object, and nothing else',
    stderr: 'progress and errors',
    keys: [
      'project',
      'expoGo',
      'freshness',
      'installed',
      'builds',
      'devServer',
      'device',
      'skills',
      'auth',
      'next',
      'assertion',
      'probe',
      'errors',
      'followups',
    ],
  },
  notes: [
    `Read-only, like git status; the only writes are this command's own caches under .expo. The`,
    `one exception is --explain --device <phone>, which launches the app on that phone to ask it`,
    `for its fingerprint. It exits 0 unless --assert turned it into a gate.`,
    `The impact line says what has changed since the last build this CLI made, and what that`,
    `costs: js-only, dev-client-compatible, or needs-native-build. The sources that moved, whether`,
    `an update can ship over the air, and whether EAS already has a finished build of this`,
    `fingerprint are on every run — there is no deeper mode to ask for.`,
    `--assert exit codes: 20 the change costs more than the class named · 22 no class could be`,
    `established · 1 the command itself was wrong.`,
    `What a run learns is remembered under .expo and revalidated against the files that can move`,
    `it: fingerprints and an evaluated app.config.js for ten minutes, an EAS answer of "none" for`,
    `five, a finished EAS build until the fingerprint changes. A remembered answer says so, with`,
    `its age. Nothing here looks inside ios/ or android/, so the expiry is what covers a native edit.`,
    `The installed line compares the project with what the app on a device was built from, read`,
    `out of the app itself: expo-constants embeds it in debug builds from SDK 58. Right about a`,
    `build somebody else made, which freshness cannot be. A release build embeds none.`,
  ],
};

export const agentCliStatus: Command = async (argv) => {
  const args = assertWithOptionsArgs(
    {
      // Types
      '--help': Boolean,
      '--json': Boolean,
      '--assert': String,
      '--build': String,
      '--device': String,
      '--device-timeout': String,
      '--dev-server-url': String,
      '--no-followups': Boolean,
      '--no-fingerprint-cache': Boolean,
      // Aliases
      '-h': '--help',
    },
    { argv, command: 'status', positionalArgs: 'none' }
  );

  if (args['--help']) {
    printCommandHelp(statusHelp);
  }

  // Load modules after the help prompt so `npx @expo/agent-cli status -h` shows as fast as possible.
  const { logCmdError } = require('../utils/errors') as typeof import('../utils/errors');
  const { findUpProjectRootOrAssert } =
    require('../utils/findUp') as typeof import('../utils/findUp');
  const { resolveDevServerUrlFlag } =
    require('../runtime/devServer') as typeof import('../runtime/devServer');
  const { resolveAssertClass, resolveBuildId, resolveDeviceFlag, resolveDeviceTimeoutFlag } =
    require('./resolveOptions') as typeof import('./resolveOptions');
  const { printStatusAsync } = require('./statusAsync') as typeof import('./statusAsync');

  return (async () => {
    // Resolved before the project is found, so a bad flag fails on the flag rather than on the
    // directory somebody happened to run it in.
    const assertClass = resolveAssertClass(args['--assert']);
    const buildId = resolveBuildId(args['--build']);
    const device = resolveDeviceFlag(args['--device']);
    const installedTimeoutMs = resolveDeviceTimeoutFlag(args['--device-timeout']);

    const projectRoot = findUpProjectRootOrAssert(process.cwd());
    const explicitDevServerUrl =
      args['--dev-server-url'] != null ? resolveDevServerUrlFlag(args['--dev-server-url']) : null;
    await printStatusAsync(projectRoot, {
      devServerUrl: explicitDevServerUrl,
      json: !!args['--json'],
      assert: assertClass,
      buildId,
      device,
      installedTimeoutMs,
      followups: !args['--no-followups'],
      // Undefined rather than `true` when the flag is absent, so `AGENT_CLI_NO_FINGERPRINT_CACHE`
      // still decides: a flag that was not passed states nothing.
      fingerprintCache: args['--no-fingerprint-cache'] ? false : undefined,
    });
  })().catch(logCmdError);
};
