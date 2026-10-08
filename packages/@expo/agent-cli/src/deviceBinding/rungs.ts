// @ref llp/0030-one-device-per-worktree.rfc.md §Readers
// The rung loop every read verb walks: the local bindings in iOS, Android order, any `up` wins.

import type { CommandError } from '../utils/errors';
import { noBoundDeviceError } from './errors';
import { inspectBindingAsync, useBoundDeviceAsync } from './inspect';
import { defaultTools } from './tools';
import type { BoundDevice, DevicePlatform, DeviceTools, Inspection } from './types';

/**
 * Main's first-`adb`-device rung, injected by the caller until llp/0032 binds Android. A device
 * found counts as `up` with no lease; nothing found is `none`; an `adb` that cannot run is the
 * `unknown` row with its tool error.
 */
export type AndroidRung = () => Promise<{ device: BoundDevice | null; toolError?: CommandError }>;

export interface FindBoundDeviceOptions {
  platform?: DevicePlatform;
  /** Whether the winner's lease is extended; `status` never writes. */
  extend: boolean;
  tools?: DeviceTools;
  android?: AndroidRung;
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
  inspection: Inspection | null;
  state: Inspection['state'];
  cause?: Inspection['cause'];
  toolError?: CommandError;
  device: BoundDevice | null;
  boundAt: string;
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
    android,
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
    rungs.push(each === 'ios' ? await iosRung(projectRoot, tools) : await androidRung(android));
  }

  const ups = rungs.filter((rung) => rung.state === 'up');
  if (ups.length > 0) {
    const winner = ups.reduce((best, rung) => (rung.boundAt > best.boundAt ? rung : best));
    const device =
      extend && winner.inspection
        ? await useBoundDeviceAsync(winner.inspection, tools)
        : winner.device!;
    return { device, refusal: null, toolError: null };
  }

  let toolError: CommandError | null = null;
  let refusal: CommandError | null = null;
  for (const rung of rungs) {
    if (rung.state === 'none') {
      continue;
    }
    if (rung.state === 'unknown' && rung.cause === 'tool') {
      if (platform) {
        throw rung.toolError;
      }
      toolError ??= rung.toolError ?? null;
      continue;
    }
    const error = noBoundDeviceError(rung.state as 'unreadable' | 'unknown' | 'not-up' | 'gone', {
      platform: rung.platform,
      cause: rung.cause,
      path: rung.inspection?.path,
    });
    if (rung.state === 'gone') {
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

async function iosRung(projectRoot: string, tools: DeviceTools): Promise<Rung> {
  const inspection = await inspectBindingAsync(projectRoot, 'ios', 'local-ios', tools);
  return {
    platform: 'ios',
    inspection,
    state: inspection.state,
    cause: inspection.cause,
    toolError: inspection.toolError,
    device: inspection.state === 'up' ? inspection.binding!.device : null,
    boundAt: inspection.binding?.boundAt ?? '',
  };
}

async function androidRung(android: AndroidRung | undefined): Promise<Rung> {
  const none: Rung = {
    platform: 'android',
    inspection: null,
    state: 'none',
    device: null,
    boundAt: '',
  };
  if (!android) {
    return none;
  }
  const probe = await android();
  if (probe.toolError) {
    return { ...none, state: 'unknown', cause: 'tool', toolError: probe.toolError };
  }
  return probe.device ? { ...none, state: 'up', device: probe.device } : none;
}
