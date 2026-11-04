import {
  actionNames,
  commandAliases,
  commandGroups,
  forwardedCommands,
  topLevelCommands,
} from './commandRegistry';
import { ON_RAMP_POINTER, ON_RAMP_TOPIC } from './help/onRamp';
import { PROGRAM_NAME, PROGRAM_PREFIX } from './programName';
import { easCommandPrefix } from './utils/easCli';

/**
 * The error for a known group asked for an action it does not have. Printed under the group
 * listing, so the reader sees the alternatives and then what to do about it.
 */
export function unknownActionMessage(group: string, action: string): string {
  return (
    `"${action}" is not an action of "${PROGRAM_NAME} ${group}". ` +
    `The actions of the ${group} group are the ones listed above: ${actionNames(group).join(', ')}. ` +
    `Run one of those, or "${PROGRAM_PREFIX} ${group} --help" for what each of them does.`
  );
}

/**
 * The error for a group given options but no action (llp/0010 §Registry rules).
 *
 * What, why, how, in that order: the flags are quoted back so the reader sees their own command,
 * the reason names the missing half, and the way out is the list of actions those flags could
 * have belonged to — or, for a group whose name is another CLI's verb, that CLI's command with
 * these very flags on it, because that is what the caller was reaching for.
 */
export function flagsWithoutActionMessage(group: string, flags: string[]): string {
  const bare = commandGroups[group]?.bareNameCommand;
  return (
    `"${PROGRAM_NAME} ${group} ${flags.join(' ')}" names no action, so nothing ran. ` +
    `The ${group} group has no default action: its options belong to one of its actions, not to the group itself, so there is nothing here for ${flags[0]} to apply to. ` +
    (bare
      ? `"${PROGRAM_NAME} ${group}" is not the command that starts one — that is "${bare}", which takes these options. `
      : '') +
    `Run one of ${actionNames(group).join(', ')} with those options, or "${PROGRAM_PREFIX} ${group} --help" for what each of them does.`
  );
}

/**
 * The command to put on the `Try:` line of a {@link flagsWithoutActionMessage}.
 *
 * The other CLI's command with the caller's own flags when the group has one, so the recovery is a
 * paste rather than a re-read; the group's help otherwise.
 */
export function flagsWithoutActionSuggestion(group: string, flags: string[]): string {
  const bare = commandGroups[group]?.bareNameCommand;
  return bare ? [bare, ...flags].join(' ') : `${PROGRAM_PREFIX} ${group} --help`;
}

/**
 * Every name this CLI resolves: its own commands, the canonical name of every group action, the
 * aliases, and the forwarded `expo` set. The candidate pool for a nearest-match suggestion.
 */
export function allCommandNames(): string[] {
  return [
    ...Object.keys(topLevelCommands),
    // The bare group name too: it is a name that resolves, whether to a default action or to the
    // listing, so it is a name a caller can be one letter away from.
    ...Object.keys(commandGroups).flatMap((group) => [group, ...actionNames(group)]),
    ...Object.keys(commandAliases),
    ...forwardedCommands,
  ];
}

/** How many names an unknown command is answered with. Three is a hint; ten is a second listing. */
const MAX_SUGGESTIONS = 3;

/**
 * Edits above which two names are simply different words rather than one of them mistyped.
 *
 * Scaled by length, because two edits in `dev` is a different command and two edits in
 * `inspect:config-plugins` is a typo.
 */
function maxEditsFor(name: string): number {
  return name.length <= 5 ? 1 : 2;
}

/**
 * The registry names closest to one that does not exist.
 *
 * Two rules, in order, because they answer two different mistakes:
 *
 * 1. **The action name on its own.** `@expo/agent-cli sync` is not a typo — it is a caller that knows what
 *    it wants and does not know which group owns it, and the answer is every group that has an
 *    action by that name: `skills:sync`. Exact, so it never guesses.
 * 2. **A small number of edits.** `@expo/agent-cli stauts` is the other mistake, and Levenshtein is what
 *    recognises it. Ordered by distance, then by the registry's own order, so the answer is stable.
 *
 * Pure and exported for the test table: the value of a suggestion is entirely in which names it
 * picks, and that is only checkable by pinning them.
 *
 * @ref llp/0006-agent-native-cli-surface.rfc.md §Errors are prompts
 */
export function suggestCommandNames(command: string): string[] {
  const query = command.toLowerCase();
  const names = allCommandNames();

  const suffixMatches = names.filter((name) => name.slice(name.indexOf(':') + 1) === query);

  const nearMatches = names
    .filter((name) => !suffixMatches.includes(name))
    .map((name) => ({ name, distance: editDistance(query, name.toLowerCase()) }))
    .filter(({ name, distance }) => distance <= maxEditsFor(name))
    .sort((a, b) => a.distance - b.distance)
    .map(({ name }) => name);

  return [...suffixMatches, ...nearMatches].slice(0, MAX_SUGGESTIONS);
}

function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        previous[j]! + 1,
        row[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = row;
  }
  return previous[b.length]!;
}

/**
 * A capability a caller reaches for that this CLI does not have, and what does the job instead.
 *
 * The nearest-match rules above answer a *typo*; this table answers a *wrong assumption*, which
 * they cannot: `@expo/agent-cli logs` is spelled correctly, is nothing like any name in the registry, and
 * so is answered with "is in none of them" and a link to the full listing — leaving the reader to
 * work out from thirty names whether a log command exists at all. Saying that it does not, and
 * naming the two commands that answer what a log is read for, is one hop instead of three.
 *
 * Only for names whose absence is worth stating. A name nobody reaches for does not belong here.
 *
 * @ref llp/0006-agent-native-cli-surface.rfc.md §Errors are prompts
 */
const absentCapabilities: {
  [name: string]: { absent: string; instead: string; suggestedCommand: string };
} = {
  // `@expo/agent-cli build --platform ios` is a real command of a real CLI aimed at the wrong one.
  build: {
    absent: `starting a build is the EAS CLI's job, not this one's`,
    // Getters, so the runner is resolved when the line is printed and not when this module loads.
    get instead() {
      return `Run "${easCommandPrefix()} build" with the flags you meant to pass here — this CLI wraps no build verb, and never did. What it has is "${PROGRAM_PREFIX} inspect:build-log", which reads the log a finished build left behind and says what failed in it.`;
    },
    get suggestedCommand() {
      return `${easCommandPrefix()} build`;
    },
  },
  // The bare name is one hop from `dev:logs`. The other two commands stay in the answer: a log is
  // read for three different questions, and only one of them is "what did it print".
  logs: {
    absent: `the log this CLI keeps is the dev server's, and it is "${PROGRAM_PREFIX} dev:logs"`,
    instead: `That reads what a dev server started with "${PROGRAM_PREFIX} dev --detach" has printed. For the two questions a log is more often opened for: "${PROGRAM_PREFIX} smoke --ios|--android" says whether the bundler finished, whether this project compiles and whether the app came up, and "${PROGRAM_PREFIX} runtime:errors" collects what the running app threw over a time window.`,
    suggestedCommand: `${PROGRAM_PREFIX} dev:logs`,
  },
};
// The singular is the same mistake, and the same answer.
absentCapabilities.log = absentCapabilities.logs!;

// @ref llp/0024-cli-ui.rfc.md §The on-ramp
// The spellings of the on-ramp that are not the on-ramp, and there are three kinds.
//
// **The colon form** is the first thing an agent that has learned this CLI's naming convention
// types: `help` is a top-level command with a positional
// topic rather than a group, so `help:workflow` is in none of the three maps. **The bare word** is
// a caller who read the topic's name and tried it as a verb. **The old name** is `how-to`, which
// anybody who read it earlier is one hop from the line that works, which is the whole job of this
// table.
//
// Edit distance cannot reach any of them — `workflow` is nine edits from every name in the
// registry — so the table is the only thing that can answer.
const onRampRecovery = {
  absent: `the on-ramp is a topic you ask "help" for by name`,
  instead: `Run "${ON_RAMP_POINTER}". "help" takes a positional topic — not a colon action, and not a flag — and anything that is not a topic is read as a command name, so "${PROGRAM_PREFIX} help <command>" prints that command's own help.`,
  suggestedCommand: ON_RAMP_POINTER,
};
for (const spelling of [
  `help:${ON_RAMP_TOPIC}`,
  ON_RAMP_TOPIC,
  'help:how-to',
  'how-to',
  '--how-to',
]) {
  absentCapabilities[spelling] = onRampRecovery;
}

/** The error for a name in none of the three maps. */
export function unknownCommandMessage(command: string): string {
  const absent = absentCapabilities[command.toLowerCase()];
  if (absent) {
    return (
      `"${PROGRAM_NAME} ${command}" is not a command, and ${absent.absent}. ` +
      `${absent.instead} ` +
      `Run "${PROGRAM_PREFIX} --help" for the whole list.`
    );
  }

  const suggestions = suggestCommandNames(command);
  // The closest names come before the "run --help" fallback: a caller that typed `wait` wants
  // `dev:logs`, not a listing of thirty commands to find it in again.
  const didYouMean = suggestions.length
    ? `The closest ${suggestions.length === 1 ? 'name is' : 'names are'} ${suggestions
        .map((name) => `"${PROGRAM_PREFIX} ${name}"`)
        .join(', ')}. `
    : '';
  return (
    `"${PROGRAM_NAME} ${command}" is not a command. ` +
    `${PROGRAM_NAME} runs its own commands, the actions of its command groups (${Object.keys(
      commandGroups
    ).join(
      ', '
    )}), and a fixed set of ${forwardedCommands.length} expo commands it forwards; "${command}" is in none of them, so neither CLI has it. ` +
    didYouMean +
    `Run "${PROGRAM_PREFIX} --help" for the whole list.`
  );
}

/**
 * The command to put on the `Try:` line of an {@link unknownCommandMessage}.
 *
 * One close name is a recovery an agent can run; several are a choice it has to make, and the
 * message above already lists them, so the last line stays the full listing.
 */
export function unknownCommandSuggestion(command: string): string {
  const absent = absentCapabilities[command.toLowerCase()];
  if (absent) {
    return absent.suggestedCommand;
  }

  const suggestions = suggestCommandNames(command);
  return suggestions.length === 1
    ? `${PROGRAM_PREFIX} ${suggestions[0]} --help`
    : `${PROGRAM_PREFIX} --help`;
}
