/**
 * A CLI subcommand. `argv` holds the arguments after the subcommand name.
 *
 * It settles only on success, and `cli.ts` then exits 0. Any other exit is a throw or an exit call
 * that never settles (llp/0010 §Exit codes), so a command cannot return a code that is dropped.
 */
export type Command = (argv?: string[]) => Promise<void>;
