// @ref llp/0035-one-device-per-worktree.rfc.md §--device on dev
import type { ExplicitRequest } from '../deviceBinding/explicit';
import { CommandError } from '../utils/errors';

/** Set by a detached `dev` on its child, whose own argv lacks the parent's `--detach`, `--wait-ready` and `--json`. */
export const CALLER_ARGV_ENV = '__EXPO_AGENT_CLI_CALLER_ARGV';

/** `--device`'s value, and the caller's arguments without it, which a refusal's How repeats. */
export function explicitRequestOf(
  device: string | undefined,
  callerArgv: readonly string[]
): ExplicitRequest | undefined {
  return device === undefined ? undefined : { query: device, rerun: withoutDeviceArgs(callerArgv) };
}

export function resolveDeviceOption(argv: string[]): string | undefined {
  const separator = argv.indexOf('--');
  const own = separator < 0 ? argv : argv.slice(0, separator);
  let value: string | undefined;
  for (const [index, arg] of own.entries()) {
    if (arg === '--device' || arg.startsWith('--device=')) {
      value = arg === '--device' ? own[index + 1] : arg.slice('--device='.length);
      if (!value?.trim() || value.startsWith('-'))
        throw new CommandError(
          'BAD_ARGS',
          '--device needs a simulator name or ID, or an Android serial.'
        );
    }
  }
  return value;
}

export function withoutDeviceArgs(argv: readonly string[]): string[] {
  const separator = argv.indexOf('--');
  const own = separator < 0 ? argv : argv.slice(0, separator);
  const kept: string[] = [];
  for (let index = 0; index < own.length; index++) {
    const arg = own[index]!;
    if (arg === '--device') index++;
    else if (!arg.startsWith('--device=')) kept.push(arg);
  }
  return separator < 0 ? kept : [...kept, ...argv.slice(separator)];
}
