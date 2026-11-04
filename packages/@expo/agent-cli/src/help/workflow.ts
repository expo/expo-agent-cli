// @ref llp/0024-cli-ui.rfc.md §The on-ramp
// `npx @expo/agent-cli help workflow` — the one screen that teaches this CLI to an agent that has never
// seen it.
//
// The listing in `@expo/agent-cli -h` says which commands exist. It cannot say the four things an agent has
// to know before the first command is worth running: what order they go in, what the exit code
// means, what `--json` guarantees, and what to do with a failure. Those are the protocol, they are
// the same for every command, and repeating them in twenty help blocks would be twenty places to
// get them wrong. So they are here, once, and every help block ends with the line that points here.
//
// The steps themselves are `workflow` and `oneTimeSetup`, defined below. This file owns them and
// `help workflow` is the only screen that prints them; `@expo/agent-cli -h` only points at that
// topic. Two screens that both claim to say what to run first are two screens that will one day
// disagree.
//
// The acceptance test for this file is a walk: an agent that has read `@expo/agent-cli -h` and this text,
// and nothing else, gets a project from nothing to a checked, running app. Every place such an
// agent had to guess is a defect in this text, not in the agent.

import { PROGRAM_PREFIX } from '../programName';
import { color } from '../utils/color';
import { ON_RAMP_POINTER } from './onRamp';

/** One rung of the workflow map: a command line, and what running it gets you. */
export interface WorkflowRung {
  /** The command as a caller types it after `npx @expo/agent-cli`, e.g. `dev --detach`. */
  run: string;
  /** What it gets you, in the present tense. Short enough to sit in a column. */
  gets: string;
}

/** One step of the workflow, and the commands that do it. */
export interface WorkflowStep {
  /**
   * What the step **is**, as a plain phrase: `Check the project`, `Edit and reload`.
   *
   * @ref llp/0024-cli-ui.rfc.md §The workflow map
   * Not a label: a vocabulary such as `orient · run · iterate` has to be taught before the map
   * means anything. The rule the wording is held to: **if a title needs a legend, it is the wrong
   * title.**
   */
  title: string;
  rungs: WorkflowRung[];
}

/**
 * What to run, in order, as the `workflow` topic prints it. `-h` only points at that topic.
 *
 * @ref llp/0024-cli-ui.rfc.md §The workflow map
 * A listing of commands cannot say which one to run first, and that is the question an agent
 * handed this CLI actually has. It is five numbered steps because five is how many there are
 * between an unopened project and a released one.
 *
 * Every rung resolves against the registry — a unit test checks it — so the map cannot come to name
 * a command that has been renamed out from under it.
 */
export const workflow: WorkflowStep[] = [
  {
    title: 'Check the project',
    rungs: [{ run: 'status', gets: 'what this project is, and what to run next' }],
  },
  {
    title: 'Start the app',
    rungs: [
      { run: 'dev --detach', gets: 'start the dev server, keep this terminal' },
      { run: 'navigate /', gets: 'open a route in the app on a device' },
    ],
  },
  {
    title: 'Edit and reload',
    rungs: [
      { run: 'runtime:reload', gets: 'after your edit, run the code on disk' },
      { run: 'runtime:errors', gets: 'what the app threw, over a time window' },
      // `runtime:tree` earns its rung: the walk needed a testID before it could tap one, and a map
      // that names `runtime:tap <testID>` without saying where a testID comes from is a map that
      // sends the reader off to guess [found by the wave-34 naive-agent walk].
      { run: 'runtime:tree', gets: 'what is on screen, and its testIDs' },
      { run: 'runtime:tap <testID>', gets: 'tap it; --verify says what changed' },
    ],
  },
  {
    title: "Verify before you're done",
    rungs: [
      // The platform is in the rung rather than left to a default, because there is no default:
      // every question this command answers is about one device, so it has to be told which
      // (@ref src/smoke/resolveOptions §resolveSmokePlatform).
      { run: 'smoke --ios|--android', gets: 'bundle, boot and error window, one exit code' },
      { run: 'typecheck', gets: 'the type errors neither of those can see' },
      { run: 'doctor', gets: 'what expo-doctor finds wrong with the setup' },
    ],
  },
  {
    // `Deploy` rather than `Release`: the step, the help group (`Deployment`) and the command
    // itself then share one word [confirmed, 2026-08-28].
    title: 'Deploy',
    rungs: [{ run: 'deploy', gets: 'publish the web app to EAS Hosting' }],
  },
];

/**
 * The commands run once per project rather than once per change.
 *
 * Kept out of {@link workflow} rather than added as a sixth step, because it is not one: a reader
 * following the numbers is following a sequence, and "create a project" does not come after
 * "release". It prints under the numbered steps, unnumbered.
 */
export const oneTimeSetup: WorkflowStep = {
  title: 'One-time setup',
  rungs: [
    { run: 'new <directory>', gets: 'create a project' },
    { run: 'install <package>', gets: 'add it at the version this SDK wants' },
    { run: 'agents:setup', gets: 'confirm agent setup for a project or user home' },
  ],
};

/** Width of the command column, sized to the longest command anywhere in the steps. */
function commandWidth(): number {
  const runs = [...workflow, oneTimeSetup].flatMap(({ rungs }) =>
    rungs.map(({ run }) => `${PROGRAM_PREFIX} ${run}`.length)
  );
  return Math.max(...runs) + 2;
}

/** One step: the title, then its commands in full, one per line. */
function stepLines(step: WorkflowStep, number: number | null): string {
  // The unnumbered block's title sits in the same column as the numbered ones, so the titles
  // read as one list and the numbers as an aside on it.
  const head = `    ${number == null ? '   ' : `${number}  `}${step.title}`;
  return [
    color.heading(head),
    ...step.rungs.map(
      ({ run, gets }) =>
        `         ${color.command(`${PROGRAM_PREFIX} ${run}`.padEnd(commandWidth()))}${color.muted(gets)}`
    ),
  ].join('\n');
}

/** The on-ramp, in one screen. */
export function formatWorkflowTopic(): string {
  return `
  ${color.command(ON_RAMP_POINTER)} — what to run, and what the answers mean

  ${color.heading('What this is')}
    One CLI over the Expo toolchain. It works out what has to run, runs it, and reports what
    happened in a shape you can branch on: an exit code, plain text, and --json.

  ${color.heading('What to run, in order')}
${workflow.map((step, index) => stepLines(step, index + 1)).join('\n')}

${stepLines(oneTimeSetup, null)}

  ${color.heading('Which commands change something')}
    read only   status · typecheck · doctor · runtime:errors · runtime:tree · dev:logs
    they act    dev · navigate · runtime:reload · install · deploy
    ${color.muted('smoke is both: it runs the app in order to report whether the app boots.')}

  ${color.heading('Exit codes — read the code before you read the output')}
     0   the tool worked and the outcome was success
     1   the tool did not work: a bad flag, no project here, a crash.
         Running the same line again changes nothing. Change the line.
     7   the tool worked and a person has to finish the step — signing in, approving.
         Hand the printed instruction to your human; no command of yours completes it.
    20   the tool worked and the outcome failed: the app threw, the bundle does not compile.
         The report says what failed. Retrying is worth it once you have changed something.
    22   the tool worked and could not conclude: a wait expired, or the runtime is unreadable.
         Retrying, or a longer --timeout, may still answer.

  ${color.heading('--json')}
    Every command that produces a report takes --json, and its help block names the top-level
    keys. One JSON object on stdout and nothing else. Progress, warnings and the recovery
    lines below go to stderr, so never parse stderr.
    A failure under --json is still one object on stdout, and always this shape:
      { "error": { "code", "message", "suggestedCommand", "needsHuman", "data" } }

  ${color.heading('Nothing here asks you a question')}
    No command opens a prompt, so nothing can block waiting for a keystroke. A command that
    costs minutes prints the plan it decided on, then runs it. To see that plan without running
    anything, ask for it: dev --plan.

  ${color.heading('Errors are prompts — the recovery is on the last lines, under one of three names')}
    Try: <command>        the tool did not work (1, and any failure it raised itself)
    Ask the user <...>    a person has to finish it (7), under "Needs a human <scenario>"
    Suggested next:       the tool worked and the outcome did not (20, 22) — under the report
    ${color.muted('One of these is always there. It is the recovery, already worked out — run it')}
    ${color.muted('instead of searching for one. Under --json all three are also in the object.')}

  ${color.heading('When you need an answer about EAS')}
    ${color.command(`${PROGRAM_PREFIX} status`)} already asked: which sources changed, whether an update
    published now would reach the installed builds, and whether EAS already has a build for
    this exact fingerprint. ${color.command(`${PROGRAM_PREFIX} status --build <id>`)} compares against one build.

  ${color.heading('Where the rest is')}
    ${color.command(`${PROGRAM_PREFIX} -h`)}                every command, grouped by the job it does
    ${color.command(`${PROGRAM_PREFIX} help <command>`)}    its options, two to four examples, and its JSON keys
    ${color.muted('Every help block ends with the commands typically run after it.')}
`;
}
