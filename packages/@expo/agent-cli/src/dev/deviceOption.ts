// @ref llp/0033-device-lifecycle.plan.md §--device on dev
import { CommandError } from '../utils/errors';

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
