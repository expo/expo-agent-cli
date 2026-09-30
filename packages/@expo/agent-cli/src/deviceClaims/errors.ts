// @ref llp/0028-one-device-per-agent.rfc.md §The registry

import { CommandError } from '../utils/errors';
import type { DevicePlatform } from './types';

/**
 * Step 6: every device is held by another live worktree and no new one fits.
 *
 * Exits `1`, like `NO_DEV_SERVER` (llp/0010 §Exit codes): nothing changes within a second, and
 * the fix is a different call — `--device`, a higher `EXPO_AGENT_MAX_DEVICES`, or another
 * worktree's `dev:stop`.
 */
export function devicesAllClaimedError(
  platform: DevicePlatform,
  holders: { id: string; projectRoot: string }[],
  summary = `Every ${platform} device is claimed by another worktree, and no new one fits.`
): CommandError {
  const error = new CommandError(
    'DEVICES_ALL_CLAIMED',
    [
      summary,
      ...holders.map(({ id, projectRoot }) => `  ${id}: ${projectRoot}`),
      `How: name a device with --device <id>, raise EXPO_AGENT_MAX_DEVICES, or run dev:stop in a worktree above.`,
    ].join('\n')
  );
  error.data = { platform, holders };
  return error;
}
