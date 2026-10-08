// @ref llp/0030-one-device-per-worktree.rfc.md §Readers
// The rung loop every read verb walks: the local bindings in iOS, Android order, any `up` wins.

import type { CommandError } from '../utils/errors';
import { noBoundDeviceError } from './errors';
import { inspectBindingAsync, useBoundDeviceAsync } from './inspect';
import { bindingPathFor } from './registry';
import { defaultTools } from './tools';
import {
  localBackendOf,
  type Binding,
  type BoundDevice,
  type DevicePlatform,
  type DeviceTools,
  type Inspection,
} from './types';

/** Main's first-`adb`-device rung, injected by `navigate` until its caller moves to the binding. */
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
    const inspection =
      each === 'android' && android
        ? await injectedRung(projectRoot, android)
        : await inspectBindingAsync(projectRoot, each, localBackendOf(each), tools);
    rungs.push({ platform: each, inspection });
  }

  const ups = rungs.filter((rung) => rung.inspection.state === 'up');
  if (ups.length > 0) {
    const winner = ups.reduce((best, rung) =>
      rung.inspection.binding!.boundAt > best.inspection.binding!.boundAt ? rung : best
    );
    // An injected rung's device has no lease to extend.
    const device =
      extend && winner.inspection.binding!.expiresAt !== ''
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

/** The injected rung as an inspection: a device found is `up` with no lease, none is `none`. */
async function injectedRung(projectRoot: string, android: AndroidRung): Promise<Inspection> {
  const path = bindingPathFor(projectRoot, 'android', 'local-android');
  const probe = await android();
  if (probe.toolError) {
    return { binding: null, path, state: 'unknown', cause: 'tool', toolError: probe.toolError };
  }
  if (!probe.device) {
    return { binding: null, path, state: 'none' };
  }
  const binding: Binding = {
    version: 1,
    device: probe.device,
    projectRoot,
    boundAt: '',
    expiresAt: '',
  };
  return { binding, path, state: 'up' };
}
