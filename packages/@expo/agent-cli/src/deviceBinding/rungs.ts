// @ref llp/0030-one-device-per-worktree.rfc.md §Readers
// The rung loop every read verb walks: the local bindings in iOS, Android order, any `up` wins.

import type { CommandError } from '../utils/errors';
import { noBoundDeviceError } from './errors';
import { inspectBindingAsync, useBoundDeviceAsync } from './inspect';
import { defaultTools } from './tools';
import {
  localBackendOf,
  type BoundDevice,
  type DevicePlatform,
  type DeviceTools,
  type Inspection,
} from './types';

export interface FindBoundDeviceOptions {
  platform?: DevicePlatform;
  /** Whether the winner's lease is extended; `status` never writes. */
  extend: boolean;
  tools?: DeviceTools;
  hostPlatform?: NodeJS.Platform;
}

export type BoundDeviceSearch =
  | { device: BoundDevice; refusal: null; toolError: null }
  | {
      device: null;
      /** The refusal of the first state seen that was not `none`, for after the EAS rung. */
      refusal: CommandError;
      /** The first tool error seen, which outranks the refusal after the EAS rung. */
      toolError: CommandError | null;
    };

interface Rung {
  platform: DevicePlatform;
  inspection: Inspection;
}

/**
 * @throws `NO_BOUND_DEVICE` for a state whose row refuses (`unreadable`, a timed-out check,
 * `not-up`), and the tool error at once when a platform flag named the rung it came from.
 */
export async function findBoundDeviceAsync(
  projectRoot: string,
  {
    platform,
    extend,
    tools = defaultTools(),
    hostPlatform = process.platform,
  }: FindBoundDeviceOptions
): Promise<BoundDeviceSearch> {
  const platforms: DevicePlatform[] = platform
    ? [platform]
    : hostPlatform === 'darwin'
      ? ['ios', 'android']
      : ['android'];
  const rungs: Rung[] = [];
  for (const each of platforms) {
    const inspection = await inspectBindingAsync(projectRoot, each, localBackendOf(each), tools);
    rungs.push({ platform: each, inspection });
  }

  const ups = rungs.filter((rung) => rung.inspection.state === 'up');
  if (ups.length > 0) {
    const winner = ups.reduce((best, rung) =>
      rung.inspection.binding!.boundAt > best.inspection.binding!.boundAt ? rung : best
    );
    const device = extend
      ? await useBoundDeviceAsync(winner.inspection, tools)
      : winner.inspection.binding!.device;
    return { device, refusal: null, toolError: null };
  }
  return refuse(rungs, platform, hostPlatform);
}

/** The refusal of the first state that is not `none`; a tool error is thrown only with a flag. */
function refuse(
  rungs: Rung[],
  platform: DevicePlatform | undefined,
  hostPlatform: NodeJS.Platform
): BoundDeviceSearch {
  let toolError: CommandError | null = null;
  let refusal: CommandError | null = null;
  for (const { platform: rungPlatform, inspection } of rungs) {
    if (inspection.state === 'none') {
      continue;
    }
    if (inspection.state === 'unknown' && inspection.cause === 'tool') {
      if (platform) {
        throw inspection.toolError;
      }
      toolError ??= inspection.toolError ?? null;
      continue;
    }
    const error = noBoundDeviceError(
      inspection.state as 'unreadable' | 'unknown' | 'not-up' | 'gone',
      { platform: rungPlatform, cause: inspection.cause, path: inspection.path }
    );
    if (inspection.state === 'gone') {
      refusal ??= error;
      continue;
    }
    throw error;
  }
  refusal ??= noBoundDeviceError('none', {
    platform: platform ?? (hostPlatform === 'darwin' ? 'ios' : 'android'),
  });
  return { device: null, refusal, toolError };
}
