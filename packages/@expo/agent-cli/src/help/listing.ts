import {
  actionNames,
  authCommands,
  commandGroups,
  commandSummary,
  forwardedCommands,
  topLevelCommands,
} from '../commandRegistry';
import { PROGRAM_NAME, PROGRAM_PREFIX } from '../programName';
import { color } from '../utils/color';
import { ON_RAMP_FOOTER } from './onRamp';

/** One section of the top-level listing: a job an agent has, and the commands that do it. */
export interface HelpSection {
  title: string;
  commands: string[];
  /**
   * Print the commands as one wrapped comma list instead of one line each.
   *
   * For the sections whose commands belong to another CLI: this registry has no summary to print
   * beside them, and eleven names each followed by nothing is a third of the screen saying nothing.
   */
  wrapped?: boolean;
  /** One line under the commands, for a section that needs it. */
  note?: string;
}

/**
 * The advertised surface, grouped by the job at hand rather than alphabetically: a flat list of
 * thirty names says nothing about which one to reach for. A unit test pins that every command in
 * the registry appears here, so a new command cannot ship undiscoverable.
 */
export const helpSections: HelpSection[] = [
  {
    title: 'Develop',
    commands: ['dev', 'dev:logs', 'dev:stop', 'start', 'stop', 'install', 'typecheck'],
    note: 'dev blocks this terminal; dev --detach does not, and dev:logs reads what it printed. dev --plan --ios (or --android, --web) prints a plan without running it; add --json for JSON.',
  },
  {
    title: 'Understand the project',
    commands: ['status', 'doctor', ...actionNames('inspect')],
    note: 'status compares native changes with the last build: JS-only changes can reload; native changes need a rebuild. Nothing here runs the project.',
  },
  { title: 'Debug a running app', commands: ['smoke', 'navigate', ...actionNames('runtime')] },
  { title: 'Create a project', commands: ['new'] },
  { title: 'Deployment', commands: ['deploy'] },
  {
    title: 'Agent setup',
    commands: [...actionNames('agents'), ...actionNames('skills')],
    note: 'agents:setup --yes --agent <agent> --json runs without prompting; --no-plugins skips plugin installation.',
  },
  { title: 'Learn', commands: ['help', ...actionNames('docs')] },
  { title: 'Feedback', commands: ['feedback'] },
  {
    title: 'Account',
    commands: authCommands,
    wrapped: true,
    // The long version of this — which of the two CLIs runs where, and that `whoami --json` is
    // answered here rather than forwarded — is in `src/passthrough/auth.ts`, next to the code that
    // decides it. A listing is for finding the command, not for its edge cases.
    note: 'No project needed: they act on the ~/.expo session the expo and eas CLIs share.',
  },
  {
    title: 'Expo CLI (fallback to npx expo <command>)',
    commands: forwardedCommands.filter((command) => !authCommands.includes(command)),
    wrapped: true,
  },
];

/** Width the help wraps a long command list at, so the Expo CLI section stays readable. */
const HELP_WIDTH = 80;

/** Column the one-line summaries start at, measured from the start of the command name. */
const SUMMARY_COLUMN = 24;

/** What an unstable command's line carries, and the sentence a section carrying one ends with. */
const EXPERIMENTAL_TAG = '[experimental]';
const EXPERIMENTAL_NOTE = 'experimental commands may change or vanish';

/**
 * Whether one runnable name is marked unstable.
 *
 * Reads the same two maps `resolveCommand` reads, so a command cannot be tagged in the help and
 * untagged in the registry. A bare group name answers for its default action, which is the command
 * that name runs; a group name with no default action runs nothing and is never tagged.
 */
export function isUnstableCommand(name: string): boolean {
  const [group, action] = name.split(':');
  if (action != null) {
    return commandGroups[group!]?.actions[action]?.unstable === true;
  }
  const entry = commandGroups[name];
  if (entry?.defaultAction) {
    return entry.actions[entry.defaultAction]?.unstable === true;
  }
  return topLevelCommands[name]?.unstable === true;
}

/** One command as a wrapped list prints it: the name, plus the tag when it has one. */
function helpName(command: string): string {
  return isUnstableCommand(command) ? `${command} ${EXPERIMENTAL_TAG}` : command;
}

/**
 * One line per command: the name in a column, then what it is for.
 *
 * The prose that used to sit under a section — three sentences about what `dev` blocks, five about
 * which CLI answers `whoami` — is gone from here. A listing answers "which command", and every
 * command's own `--help` answers the rest in the same shape (`src/help/format.ts`). A wall of prose
 * inside a list is the thing that made this screen unreadable [confirmed, 2026-08-28].
 */
function commandLines(commands: string[], indent: string): string {
  return commands
    .flatMap((command) => {
      const tag = isUnstableCommand(command) ? ` ${EXPERIMENTAL_TAG}` : '';
      const head = `${indent}${color.command(command.padEnd(SUMMARY_COLUMN))}`;
      const width = HELP_WIDTH - indent.length - SUMMARY_COLUMN;
      const wrapped = wrapText(`${commandSummary(command)}${tag}`, width);
      return wrapped.map((line, index) =>
        index === 0 ? `${head}${line}` : `${indent}${' '.repeat(SUMMARY_COLUMN)}${line}`
      );
    })
    .join('\n');
}

/** Break one sentence onto lines no longer than `width`, on spaces. */
function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(' ')) {
    const last = lines.length - 1;
    if (lines.length && `${lines[last]} ${word}`.length <= width) {
      lines[last] = `${lines[last]} ${word}`;
    } else {
      lines.push(word);
    }
  }
  return lines.length ? lines : [''];
}

/**
 * The rung column, sized to the longest rung anywhere in the workflow.
 *
 * One width across the numbered steps and the setup block, so the "what it gets you" column starts
 * in one place and the whole map reads as one table.
 */
/** One comma-separated list of commands, wrapped onto as many indented lines as it needs. */
function wrapCommands(commands: string[], indent: string): string {
  const lines: string[] = [];
  for (const command of commands) {
    const last = lines.length - 1;
    const candidate = lines.length ? `${lines[last]}, ${command}` : `${indent}${command}`;
    if (lines.length && candidate.length <= HELP_WIDTH) {
      lines[last] = candidate;
    } else {
      // The comma stays on the line that is full, so a wrapped list still reads as one list.
      if (lines.length) {
        lines[last] += ',';
      }
      lines.push(`${indent}${command}`);
    }
  }
  return lines.join('\n');
}

/** What this CLI is for, in one line, at the head of the top-level help. */
export const CLI_SUMMARY = 'get an Expo app running on a device, change it, check it, and ship it';

/**
 * The `@expo/agent-cli --help` screen: the loop first, then every command by the job it does.
 *
 * @ref llp/0024-cli-ui.rfc.md §The workflow map
 * The order is the argument. A caller who does not know this CLI cannot use a listing — they do not
 * know which of thirty names comes first — so the loop is above it, and the on-ramp that teaches
 * the whole protocol is named twice: once under the map, and once at the foot of every command's
 * own help.
 */
export function formatTopLevelHelp(): string {
  const sections = helpSections
    .map(({ title, commands, note, wrapped }) =>
      [
        `    ${color.heading(title)}`,
        wrapped ? wrapCommands(commands.map(helpName), '      ') : commandLines(commands, '      '),
        note ? `      ${color.muted(note)}` : null,
        // One footnote per section that has any, rather than one at the bottom of the listing: a
        // reader who took in the Inspect block and stopped reading has still been told.
        commands.some(isUnstableCommand) ? `      ${color.muted(EXPERIMENTAL_NOTE)}` : null,
      ]
        .filter((line) => line != null)
        .join('\n')
    )
    .join('\n');

  return `
  ${color.command(`${PROGRAM_NAME}`)} — ${CLI_SUMMARY}

  ${color.heading('Usage')}
    ${color.muted('$')} ${PROGRAM_PREFIX} <command> [options]

  ${ON_RAMP_FOOTER}
    ${color.muted('what to run in order, the exit codes, and the --json contract')}

  ${color.heading('Commands')}
${sections}

  ${color.heading('Options')}
    --version, -v   Version number
    --help, -h      Usage info

  The options, examples and JSON keys of one command
    ${color.muted('$')} ${PROGRAM_PREFIX} status --help
`;
}

/** The `@expo/agent-cli <group>` listing: what the group is for, and the actions it has. */
export function formatGroupHelp(name: string): string {
  const group = commandGroups[name]!;
  // One column for the names, so the summaries line up whatever the longest action is called.
  const width = Math.max(...actionNames(name).map((action) => action.length)) + 3;
  const actions = actionNames(name)
    .map((action, index) => {
      const summary = Object.values(group.actions)[index]!.summary;
      const tag = isUnstableCommand(action) ? ` ${color.muted(EXPERIMENTAL_TAG)}` : '';
      return `    ${color.command(action.padEnd(width))}${summary}${tag}`;
    })
    .join('\n');
  const experimental = actionNames(name).some(isUnstableCommand)
    ? `\n\n    ${color.muted(EXPERIMENTAL_NOTE)}`
    : '';
  const bare = group.defaultAction
    ? `\n\n    ${color.command(`${PROGRAM_PREFIX} ${name}`)} runs ${color.command(`${name}:${group.defaultAction}`)}, whose options are below.`
    : '';
  // The example names an action the reader has *not* just been shown the options of: for a group
  // with a default action, `cli.ts` prints that action's own help right under this listing.
  const example =
    actionNames(name).find((action) => action !== `${name}:${group.defaultAction}`) ??
    actionNames(name)[0];

  return `
  ${color.command(name)} — ${group.summary}

  ${color.heading('Usage')}
    ${color.muted('$')} ${PROGRAM_PREFIX} ${name}:${color.muted('<action> [options]')}

  ${color.heading('Actions')}
${actions}${experimental}${bare}

  For the options of one action, run it with the ${color.heading('--help')} flag
    ${color.muted('$')} ${PROGRAM_PREFIX} ${example} --help

  ${ON_RAMP_FOOTER}
`;
}
