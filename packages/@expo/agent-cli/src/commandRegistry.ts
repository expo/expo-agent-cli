// @ref llp/0006-agent-native-cli-surface.rfc.md §The `@expo/agent-cli` launcher
// The whole command surface as data: which names exist, what loads them, and how one argv resolves
// to one of them. `cli.ts` reads the answer and does the I/O; nothing here prints or exits, so the
// resolution rules are unit-testable without spawning the CLI.
//
// Three kinds of name, and one rule each:
//
// - **Top-level** (`dev`, `status`) — a flat lazy map, one module per name.
// - **Groups** (`runtime:eval`, `skills:sync`) — a nested lazy map. `<group>:<action>` is the
//   canonical spelling; `<group> <action>` resolves to the same command, so an agent that types
//   the space form is never wrong. A group with a `defaultAction` runs it for the bare name.
// - **Forwarded** (`prebuild`, `login`) — a fixed list of the `expo` commands this CLI does not
//   wrap, run as a subprocess verbatim (`src/passthrough/`).
//
// Plus `commandAliases`, which is another name for one of the above rather than a fourth kind.
//
// The three lists are the whole surface: a name in none of them is a command neither CLI has, and
// it fails saying so. There is no open-ended fallback, so a typo is answered here instead of
// becoming an `expo` invocation that could not have meant anything.

import type { CommandHelp } from './help/types';
import type { Command } from './types';

/** Loads one command module on demand, so `@expo/agent-cli --help` never pays for the whole CLI. */
export type CommandLoader = () => Promise<Command>;

/**
 * Loads one command's help spec on demand.
 *
 * Separate from {@link CommandLoader} and pointing at the same module: the spec is data
 * (`src/help/types.ts`), so the template test can load every one of them and check the sections
 * without running a command or spawning a process. Required on every entry, so a new command
 * cannot ship with a `--help` that is whatever its author felt like writing.
 */
export type HelpLoader = () => Promise<CommandHelp>;

/**
 * Whether a command may change or vanish, which is a property of the **command** and not of the
 * group it is in.
 *
 * Per action on purpose: `inspect` is a group a stable action can join, and marking the group would
 * say the opposite of what is meant about the ones that follow. The help prints an `[experimental]`
 * tag on the line and one footnote per section that has any, so a reader learns it where they learn
 * the command rather than in a release note.
 *
 * `true` or absent — never `false`. A command that is not marked is the ordinary case, and a
 * `unstable: false` beside twenty entries with nothing would read as a claim somebody made rather
 * than as the default.
 *
 * **The mark comes off against a record, not against a feeling** (llp/0016-v1-scope.rfc.md §Experimental is per command).
 * One command carries it: `inspect:config-plugins`.
 */
export type Unstable = true;

/** One action of a group, e.g. the `eval` of `runtime:eval`. */
export interface CommandAction {
  /** One line, printed by the group help and by the top-level listing. */
  summary: string;
  load: CommandLoader;
  /** @see HelpLoader */
  help: HelpLoader;
  /** @see Unstable */
  unstable?: Unstable;
}

/** One command with a name of its own, e.g. `smoke`. */
export interface TopLevelCommand {
  /**
   * One line, printed by the top-level listing.
   *
   * Here rather than in the command's own {@link CommandHelp}, so the listing can print it without
   * loading twenty command modules — and so the sentence a caller reads in the listing is the same
   * sentence they read at the head of that command's help.
   */
  summary: string;
  load: CommandLoader;
  /** @see HelpLoader */
  help: HelpLoader;
  /** @see Unstable */
  unstable?: Unstable;
}

/** One colon group, e.g. the `runtime` of `runtime:eval`. */
export interface CommandGroup {
  /** What the group is for, printed as the `Info` line of the group help. */
  summary: string;
  /**
   * Action the bare group name runs, e.g. `@expo/agent-cli doctor` runs `doctor:check`.
   * A group without one prints its help instead, because there is nothing obvious to do.
   */
  defaultAction?: string;
  /**
   * The command another CLI owns the bare group name for, e.g. `npx eas build` for `build`.
   *
   * Set it when the group name is also a verb someone will type on its own. `@expo/agent-cli build
   * --platform ios` is not a typo — it is a real command of a real CLI, aimed at the wrong one —
   * and the answer that helps is that command, with the caller's own flags on it, rather than a
   * listing of two actions that do something else (llp/0010 §Registry rules).
   */
  bareNameCommand?: string;
  actions: { [action: string]: CommandAction };
}

/**
 * Hand the action back to a command that reads it as its first argument.
 *
 * The commands of a group are one module with one `--help` block when the actions share their
 * options (`runtime`, `skills`); such a module parses its action out of `argv[0]`, exactly as the
 * space form always gave it. The registry strips the action while resolving, so this puts it back
 * and every command receives the same argv whichever spelling the caller used.
 */
export function withAction(action: string, load: CommandLoader): CommandLoader {
  return () => load().then((command) => (argv?: string[]) => command([action, ...(argv ?? [])]));
}

/** Commands with a name of their own. Add a new top-level command here. */
export const topLevelCommands: { [command: string]: TopLevelCommand } = {
  deploy: {
    summary: 'Ship the web app, or launch the native one',
    load: () => import('./deploy').then((i) => i.agentCliDeploy),
    help: () => import('./deploy').then((i) => i.deployHelp),
  },
  feedback: {
    summary: 'Send feedback to the Expo team',
    load: () => import('./feedback').then((i) => i.agentCliFeedback),
    help: () => import('./feedback').then((i) => i.feedbackHelp),
  },
  // The on-ramp, as a command rather than only as a flag. An agent that has been handed this CLI
  // and nothing else types the word it knows — `help` — and the answer has to be the loop, not a
  // suggestion to read something else (llp/0024 §The on-ramp).
  help: {
    summary: `Learn the workflow, or one command's help`,
    load: () => import('./help').then((i) => i.agentCliHelp),
    help: () => import('./help').then((i) => i.helpHelp),
  },
  install: {
    summary: 'Install packages, and link the skills they ship',
    load: () => import('./install').then((i) => i.agentCliInstall),
    help: () => import('./install').then((i) => i.installHelp),
  },
  navigate: {
    summary: 'Open a route in the app on a booted device',
    load: () => import('./navigate').then((i) => i.agentCliNavigate),
    help: () => import('./navigate').then((i) => i.navigateHelp),
  },
  new: {
    summary: 'Create a new Expo project without a terminal',
    load: () => import('./new').then((i) => i.agentCliNew),
    help: () => import('./new').then((i) => i.newHelp),
  },
  // A capability only this CLI has, so it gets a verb of its own (llp/0006 naming rule).
  smoke: {
    summary: 'Prove the app boots, on a device',
    load: () => import('./smoke').then((i) => i.agentCliSmoke),
    help: () => import('./smoke').then((i) => i.smokeHelp),
  },
  start: {
    summary: 'expo start, plus a sync of the agent skills',
    load: () => import('./start').then((i) => i.agentCliStart),
    help: () => import('./start').then((i) => i.startHelp),
  },
  status: {
    summary: 'Check Expo Go support and whether to rebuild',
    load: () => import('./status').then((i) => i.agentCliStatus),
    help: () => import('./status').then((i) => i.statusHelp),
  },
  // A capability only this CLI has gets a verb of its own (llp/0006 naming rule): `expo` has no
  // `typecheck` in its command map [observed — `packages/@expo/cli/src/index.ts`, 2026-08-23], so
  // there is no `expo` behaviour for this name to have to match.
  typecheck: {
    summary: `Type-check with the project's own compiler`,
    load: () => import('./typecheck').then((i) => i.agentCliTypecheck),
    help: () => import('./typecheck').then((i) => i.typecheckHelp),
  },
};

/** Commands that belong to a group. Add a new action, or a new group, here. */
export const commandGroups: { [group: string]: CommandGroup } = {
  agents: {
    summary: 'Set this project up for coding agents',
    actions: {
      setup: {
        summary: 'Set up Expo agents in a project or user home',
        load: () => import('./agents').then((i) => i.agentCliAgentsSetup),
        help: () => import('./agents').then((i) => i.agentsSetupHelp),
      },
    },
  },
  // @ref llp/0030-local-docs.rfc.md §Commands — no default action: bare `docs` lists the two.
  docs: {
    summary: 'The Expo docs as local Markdown files, for the SDK in use',
    actions: {
      sync: {
        summary: 'Download the Expo docs as .md files to grep',
        load: () => import('./docs').then((i) => i.agentCliDocsSync),
        help: () => import('./docs').then((i) => i.docsSyncHelp),
      },
      search: {
        summary: 'Search the local Expo docs, with file and line',
        load: () => import('./docs').then((i) => i.agentCliDocsSearch),
        help: () => import('./docs').then((i) => i.docsSearchHelp),
      },
    },
  },
  // Read-only questions about a project that is not running. The two actions were `inspect:build-log`
  // and `inspect:config-plugins`, under two groups named after other CLIs' verbs; one group named after
  // what the caller is doing holds them and every read-only answer that follows.
  //
  // The group is not marked unstable — one of its actions is, individually. A group-level mark
  // would say something about the stable actions that join it later, which is the opposite of what
  // is meant (see {@link Unstable}), and this group is now the case that shows it: two actions,
  // one graduated and one not, on one listing (llp/0016-v1-scope.rfc.md §Experimental is per command).
  inspect: {
    summary: 'Read what this project produced, without running it',
    actions: {
      'build-log': {
        summary: 'Say what failed in a build log',
        load: () => import('./builds').then((i) => i.agentCliInspectBuildLog),
        help: () => import('./builds').then((i) => i.inspectBuildLogHelp),
      },
      // The only `[experimental]` command (llp/0016 §Experimental is per command).
      'config-plugins': {
        summary: 'What the config plugins produced',
        load: () => import('./config').then((i) => i.agentCliInspectConfigPlugins),
        help: () => import('./config').then((i) => i.inspectConfigPluginsHelp),
        unstable: true,
      },
    },
  },
  // `dev` is a group with a default action rather than a top-level command, so `@expo/agent-cli dev` runs
  // the plan engine exactly as before while `dev:stop` and `dev:logs` join it as entries. Promoting
  // a name this way costs nothing at the call site: a group with a `defaultAction` gives it every
  // option.
  dev: {
    summary: 'Get this app onto a device, and manage the dev server it runs against',
    defaultAction: 'run',
    actions: {
      run: {
        summary: 'Get this app onto a device: plan it, then run it',
        load: () => import('./dev').then((i) => i.agentCliDev),
        help: () => import('./dev').then((i) => i.devRunHelp),
      },
      stop: {
        summary: `Stop this project's dev server`,
        load: () => import('./dev/stop').then((i) => i.agentCliDevStop),
        help: () => import('./dev/stop').then((i) => i.devStopHelp),
      },
      logs: {
        summary: 'Read what the detached dev server printed',
        load: () => import('./dev/logs').then((i) => i.agentCliDevLogs),
        help: () => import('./dev/logs').then((i) => i.devLogsHelp),
      },
    },
  },
  doctor: {
    summary: 'Diagnose the project with expo-doctor',
    defaultAction: 'check',
    actions: {
      check: {
        summary: 'Run expo-doctor and normalize its report',
        load: () => import('./doctor').then((i) => i.agentCliDoctorCheck),
        help: () => import('./doctor').then((i) => i.doctorCheckHelp),
      },
    },
  },
  runtime: {
    summary: `Read and drive the running app over the dev server's debugger connection`,
    actions: {
      eval: {
        summary: 'Evaluate JavaScript in the running app',
        load: withAction('eval', () => import('./runtime').then((i) => i.agentCliRuntime)),
        help: () => import('./runtime').then((i) => i.runtimeEvalHelp),
      },
      errors: {
        summary: 'Collect runtime errors over a time window',
        load: withAction('errors', () => import('./runtime').then((i) => i.agentCliRuntime)),
        help: () => import('./runtime').then((i) => i.runtimeErrorsHelp),
      },
      // Interaction commands (llp/0018). Each takes different options and has its own `--help`.
      tree: {
        summary: 'What is on screen, ready for a tap',
        load: () => import('./runtime/interact/tree').then((i) => i.agentCliRuntimeTree),
        help: () => import('./runtime/interact/tree').then((i) => i.runtimeTreeHelp),
      },
      tap: {
        summary: 'Tap the element carrying a testID',
        load: () => import('./runtime/interact/tap').then((i) => i.agentCliRuntimeTap),
        help: () => import('./runtime/interact/tap').then((i) => i.runtimeTapHelp),
      },
      type: {
        summary: 'Type into the input with a testID',
        load: () => import('./runtime/interact/type').then((i) => i.agentCliRuntimeType),
        help: () => import('./runtime/interact/type').then((i) => i.runtimeTypeHelp),
      },
      // Two actions with modules of their own, like `dev:stop`: they drive the app rather than
      // read it, so they take different options and print different reports, and folding them
      // into the shared `runtime` module would give one `--help` block three subjects.
      reload: {
        summary: 'Reload the app onto the code on disk now',
        load: () => import('./runtime/reload').then((i) => i.agentCliReload),
        help: () => import('./runtime/reload').then((i) => i.runtimeReloadHelp),
      },
      stop: {
        summary: 'Stop the app on the device it runs on',
        load: () => import('./runtime/stop').then((i) => i.agentCliRuntimeStop),
        help: () => import('./runtime/stop').then((i) => i.runtimeStopHelp),
      },
    },
  },
  skills: {
    summary: 'Link agent skills from installed npm packages',
    defaultAction: 'sync',
    actions: {
      sync: {
        summary: `Link the installed packages' skills`,
        load: withAction('sync', () => import('./skills').then((i) => i.agentCliSkills)),
        help: () => import('./skills').then((i) => i.skillsSyncHelp),
      },
      list: {
        summary: 'List the skills the installed packages ship',
        load: withAction('list', () => import('./skills').then((i) => i.agentCliSkills)),
        help: () => import('./skills').then((i) => i.skillsListHelp),
      },
      show: {
        summary: `Print the SKILL.md of a package`,
        load: withAction('show', () => import('./skills').then((i) => i.agentCliSkills)),
        help: () => import('./skills').then((i) => i.skillsShowHelp),
      },
      clean: {
        summary: 'Remove the managed skill links',
        load: withAction('clean', () => import('./skills').then((i) => i.agentCliSkills)),
        help: () => import('./skills').then((i) => i.skillsCleanHelp),
      },
    },
  },
};

/**
 * Other names for a command above, as `alias -> command`.
 *
 * These exist for parity: `expo add` is `expo install` under another name, so `@expo/agent-cli add` has to
 * be `@expo/agent-cli install` — the wrapper with the skill sync and the impact report — and not a bare
 * forward that quietly does less than the command it looks like. An alias resolves to its target's
 * name, so the event stream and the follow-ups only ever name the command that ran.
 *
 * An alias is documented in its target's `--help`, and it may also be listed in the top-level
 * sections where its absence would be a hole a reader trips on — `stop` sits under `start`
 * [confirmed, 2026-08-30] — with a summary that names whose name the work happens under.
 */
export const commandAliases: { [alias: string]: string } = {
  add: 'install',
  // `start` has a top-level name, so its counterpart answers to one too [confirmed,
  // 2026-08-30]. It stops the DEV SERVER: the ambiguity worth a sentence is `runtime:stop`,
  // which stops the app on the device, and `dev:stop`'s help says which is which.
  stop: 'dev:stop',
};

/**
 * The `expo` commands this CLI forwards, and the whole of what it forwards.
 *
 * A fixed set, not a fallback: an unrecognized command is a typo far more often than it is a new
 * `expo` command, and forwarding it made the typo the `expo` CLI's problem to report. The cost is
 * that this list has to be kept in step by hand.
 *
 * Source of truth: the `commands` map of `packages/@expo/cli/src/index.ts` [observed —
 * 2026-08-22], in its own order, minus `start` and `install`, which this CLI wraps.
 */
/**
 * The forwarded commands that act on the machine's session rather than on the project.
 *
 * A partition of {@link forwardedCommands}, not a separate surface. They read and write
 * `~/.expo/state.json`, which exists whether or not the current directory has an Expo app in it —
 * so unlike `prebuild` or `export`, "there is no project CLI here" is not a reason for them to
 * fail. `src/passthrough/auth.ts` is what they do instead.
 */
export const authCommands: string[] = ['login', 'logout', 'register', 'whoami'];

export const forwardedCommands: string[] = [
  // Project commands
  'run',
  'run:ios',
  'run:android',
  'prebuild',
  'config',
  'export',
  'export:web',
  'export:embed',
  'serve',
  // Auxiliary commands. `add` is missing on purpose: it is `expo install` under another name, so
  // it is an alias of this CLI's `install` wrapper (see `commandAliases`).
  'customize',
  'lint',
  // Auth. Forwarded like the rest, but what they act on is the machine rather than the project,
  // so they have a second CLI to fall back to — see `authCommands`.
  ...authCommands,
];

/** What one argv resolved to. Every case is something `cli.ts` can act on without deciding again. */
export type CommandResolution =
  /** A command of this CLI, with the arguments it owns. */
  | { kind: 'command'; name: string; argv: string[]; load: CommandLoader }
  /** A bare group, or a group asked for help: print its actions and exit 0. */
  | { kind: 'group-help'; group: string }
  /** A known group with an action it does not have: the listing, plus an error. */
  | { kind: 'unknown-action'; group: string; action: string }
  /** A group with options but no action, and no default action to give them to: an error. */
  | { kind: 'flags-without-action'; group: string; flags: string[] }
  /** One of the `expo` commands above, forwarded verbatim. */
  | { kind: 'passthrough'; command: string; argv: string[] }
  /** In none of the three maps, so neither CLI has it. */
  | { kind: 'unknown-command'; command: string };

// @ref llp/0010-agent-conventions.rfc.md §Registry rules — rules 1 and 2 below.
/**
 * Resolve the command an invocation names.
 *
 * Our own names win, then the forwarded `expo` set, and anything left is an error. Membership in a
 * map decides — never the shape of the name — because `expo export:web` has a colon too.
 *
 * Two rules of the resolution order are worth naming:
 *
 * 1. **Options without an action are an error, not help.** `@expo/agent-cli <group> --json` used to print
 *    the group listing and exit 0, which an agent reads as "that worked" — a silent no-op is the
 *    one answer a driving agent cannot recover from. A group that declares a `defaultAction` is
 *    unaffected: there the options belong to that action, and it runs with them.
 * 2. **A group cannot capture the bare form of a forwarded `expo` command.** A group named after
 *    one — `config`, say — owns its colon forms (`config:doctor`) and nothing else: `@expo/agent-cli
 *    config` stays `expo config`, because the bare name means what the `expo` command means
 *    (llp/0006 naming rule). The space form is unavailable for such a group, so
 *    `@expo/agent-cli config doctor` forwards two arguments to `expo config` rather than resolving here.
 *
 * @param command The first positional argument, e.g. `runtime:eval` or `runtime`.
 * @param argv Everything after it, with the help flag already normalized into it by `cli.ts`.
 */
export function resolveCommand(command: string, argv: string[]): CommandResolution {
  // A colon spells one of our groups, unless the whole name is a command `expo` owns.
  if (command.includes(':') && !forwardedCommands.includes(command)) {
    const separator = command.indexOf(':');
    const groupName = command.slice(0, separator);
    const action = command.slice(separator + 1);
    const entry = commandGroups[groupName];
    if (entry) {
      const target = entry.actions[action];
      // An action of a group we own is never forwarded, whether or not the group has it.
      return target
        ? {
            kind: 'command',
            name: `${groupName}:${action}`,
            argv,
            load: target.load,
          }
        : { kind: 'unknown-action', group: groupName, action };
    }
  }

  // Rule 2: the bare name of a forwarded `expo` command is that command, whatever this CLI groups
  // under the same name. Its colon forms were resolved above, where the forwarded set is checked
  // against the whole name and so never matches `<group>:<action>`.
  const group = forwardedCommands.includes(command) ? undefined : commandGroups[command];
  if (group) {
    // The action of the space form is the argument right after the group name: `skills list`, the
    // way `skills:list` puts it. A flag there is the bare form with options, not a bad action.
    const next = argv[0];
    if (next != null && !next.startsWith('-')) {
      const target = group.actions[next];
      if (!target) {
        return { kind: 'unknown-action', group: command, action: next };
      }
      return {
        kind: 'command',
        name: `${command}:${next}`,
        argv: argv.slice(1),
        load: target.load,
      };
    }
    // `@expo/agent-cli <group> --help` is about the group, so it lists the actions instead of running one.
    if (argv.includes('--help') || argv.includes('-h')) {
      return { kind: 'group-help', group: command };
    }
    if (!group.defaultAction) {
      // Rule 1: a bare group is answerable and prints its actions; the same group with options is
      // an invocation that named no action, and there is nothing to give the options to.
      return next == null
        ? { kind: 'group-help', group: command }
        : { kind: 'flags-without-action', group: command, flags: argv };
    }
    return {
      kind: 'command',
      name: `${command}:${group.defaultAction}`,
      argv,
      load: group.actions[group.defaultAction]!.load,
    };
  }

  const entry = topLevelCommands[command];
  if (entry) {
    return { kind: 'command', name: command, argv, load: entry.load };
  }

  const aliased = commandAliases[command];
  if (aliased) {
    // Re-resolve under the target's own name, so an alias may point at a group action
    // (`stop` -> `dev:stop`) as well as at a top-level command, and every downstream rule —
    // events, follow-ups, help — sees only the name that ran.
    return resolveCommand(aliased, argv);
  }

  if (forwardedCommands.includes(command)) {
    return { kind: 'passthrough', command, argv };
  }

  return { kind: 'unknown-command', command };
}

/** The canonical names of every action of a group, e.g. `['runtime:eval', ...]`. */
export function actionNames(group: string): string[] {
  return Object.keys(commandGroups[group]!.actions).map((action) => `${group}:${action}`);
}

/**
 * The one-line summary of one runnable name.
 *
 * The registry is the only place a summary is written. The top-level listing prints it without
 * loading a command module, and `src/help/format.ts` prints the same string at the head of that
 * command's `--help` — so the sentence that made a caller pick the command is the sentence they
 * read when they get there.
 */
export function commandSummary(name: string): string {
  // An alias listed in the help says whose name the work happens under, so a reader who later
  // sees `dev:stop` in a report knows it was this command [confirmed, 2026-08-30].
  const aliased = commandAliases[name];
  if (aliased) {
    return `${commandSummary(aliased)} (alias of ${aliased})`;
  }
  const [group, action] = name.split(':');
  if (action != null) {
    return commandGroups[group!]!.actions[action]!.summary;
  }
  const bare = commandGroups[name];
  if (bare?.defaultAction) {
    return bare.actions[bare.defaultAction]!.summary;
  }
  return topLevelCommands[name]!.summary;
}
