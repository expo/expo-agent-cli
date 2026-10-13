// @ref llp/0035-one-device-per-worktree.rfc.md §--device on dev
import { PROGRAM_PREFIX } from '../programName';
import { quoteArgument } from '../utils/consent';
import { isPlatformFlag } from './platformFlags';
import type { PlanPlatform } from './types';

/**
 * The caller's `dev` command again: the platform first, `--device <device>` added, `--plan`
 * dropped, and `--detach --wait-ready` added to a foreground command, which would block an agent.
 */
export function rerunDevCommand(
  platform: PlanPlatform,
  callerArgv: readonly string[],
  device?: string
): string {
  const separator = callerArgv.indexOf('--') < 0 ? callerArgv.length : callerArgv.indexOf('--');
  const own = callerArgv.slice(0, separator);
  const args = [
    ...own.filter((arg) => !isPlatformFlag(arg) && arg !== '--plan'),
    ...(device === undefined ? [] : ['--device', device]),
    ...(own.includes('--detach') ? [] : ['--detach', '--wait-ready']),
    ...callerArgv.slice(separator),
  ];
  return `${PROGRAM_PREFIX} dev --${platform}${args.map((arg) => ` ${quoteArgument(arg)}`).join('')}`;
}
