import type { CommandExit } from './exitCodes';

/**
 * A CLI subcommand. `argv` holds the arguments after the subcommand name.
 *
 * It returns its outcome, or a forwarded child's code, and `cli.ts` exits with it. A tool error is
 * a throw (llp/0010 §Exit codes). Every path returns a code, so a body that awaits an outcome and
 * falls off the end does not compile.
 */
export type Command = (argv?: string[]) => Promise<CommandExit>;
