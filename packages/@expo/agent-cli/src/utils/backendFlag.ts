// @ref llp/0015-backend-selection-and-config.rfc.md §The device backend
// A run that passed `--local` keeps it on every device command it prints.
//
// With `deviceBackend: "eas"` in the config, a printed `dev`, `smoke` or `navigate` without the flag
// runs on a billed session. So, like `renderForInvoker`, this is a substitution on the way out
// rather than a rule every builder has to remember. Unlike it, it also rewrites the JSON and the
// events, because the flag changes what the command does, not how it is spelled.

import { PROGRAM_NAME } from '../programName';

/** The commands that read `deviceBackend` and take `--local`. */
export const LOCAL_FLAG_COMMANDS = [
  'dev',
  'dev:stop',
  'smoke',
  'navigate',
  'runtime:reload',
  'runtime:stop',
] as const;

let runFlag: '--local' | null = null;

/** Decided once per process, from the command line, before anything is printed. */
export function setRunBackendFlag(flag: '--local' | null): void {
  runFlag = flag;
}

/** Whether a command line passed `--local`, ignoring what follows `--`. */
export function argvPassesLocal(argv: readonly string[]): boolean {
  const separator = argv.indexOf('--');
  return (separator < 0 ? argv : argv.slice(0, separator)).includes('--local');
}

// `bunx` too, since `renderForInvoker` may have respelled the runner, and the bare name, which
// the plan's reasons use.
const ESCAPED_PREFIX = `(?<![\\w/@-])(?:(?:npx|bunx)[ \\t]+)?${PROGRAM_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
const COMMAND = `(?:${LOCAL_FLAG_COMMANDS.map((name) => name.replace(':', '\\:')).join('|')})`;
// Arguments run to a double quote, a backslash (a JSON-escaped quote), `&&`, a lone `--` or a dash.
// A single-quoted shell word is one argument, with the `'\''` escape `quoteArgument` writes for a
// quote inside it (`'John'\''s iPhone'`), also as JSON escapes it.
const ARGUMENT = `[ \\t]+(?!&&|--(?:\\s|$)|—)(?:[^\\s"'\`”)\\\\]|'[^'\\n]*'|\\\\{1,2}')+`;
const DEVICE_COMMAND = new RegExp(
  `(${ESCAPED_PREFIX}[ \\t]+${COMMAND}(?![\\w:-]))((?:${ARGUMENT})*)`,
  'g'
);

/** Append the run's backend flag to each device command in `text` that names no backend. */
export function withRunBackendFlag(text: string, flag: string | null = runFlag): string {
  if (flag == null || !text.includes(PROGRAM_NAME)) {
    return text;
  }
  return text.replace(DEVICE_COMMAND, (_match, command: string, args: string) => {
    // A second pass may meet the flag glued to a colour reset or a full stop.
    if (/(^|\s)--(local|eas)(?![\w-])/.test(args)) {
      return command + args;
    }
    // A sentence may end right after the command, and a colour may close on it: the flag goes
    // before the full stop and the reset.
    const trailing = /(?:[.,;:]|\x1b\[[0-9;]*m)+$/.exec(args)?.[0] ?? '';
    return `${command}${args.slice(0, args.length - trailing.length)} ${flag}${trailing}`;
  });
}

/** {@link withRunBackendFlag} over every string in a JSON-shaped value, for the event stream. */
export function withRunBackendFlagDeep<T>(value: T, flag: string | null = runFlag): T {
  if (flag == null) {
    return value;
  }
  if (typeof value === 'string') {
    return withRunBackendFlag(value, flag) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => withRunBackendFlagDeep(item, flag)) as T;
  }
  if (
    value != null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withRunBackendFlagDeep(item, flag)])
    ) as T;
  }
  return value;
}
