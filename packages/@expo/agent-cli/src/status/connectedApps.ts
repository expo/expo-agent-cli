// @ref llp/0004-smart-start-and-project-state.rfc.md §Reported by status
// Who the apps connected to the dev server belong to, for the dev-server line of `status`.

import { liveIosBindings } from '../deviceBinding/records';
import type { BindingSummary } from '../deviceBinding/summary';
import type { CdpTarget } from '../runtime/cdpClient';
import {
  classifyTargets,
  readDeviceInventoryAsync,
  READ_EVERY_TARGET,
  skippedAppsOf,
  type DeviceInventory,
  type TargetSelection,
} from '../runtime/targetSelection';

export interface ConnectedAppOwners {
  /** Device names of apps on the simulator this worktree bound. */
  simulatorApps: string[];
  /** Device names of apps on a booted local simulator this worktree did not bind. */
  localApps: string[];
  /** Device names of apps on a simulator another worktree bound. */
  otherWorktreeApps: string[];
  /** How many apps run on this worktree's recorded EAS session. */
  sessionApps: number;
}

/** The scope `runtime:eval` would read with: the device this worktree binds, if any. */
function scopeOf(inventory: DeviceInventory, bindings: readonly BindingSummary[]): TargetSelection {
  const own = inventory.iosBindings.find((binding) => binding.own);
  if (own) {
    return {
      platform: { value: 'ios', by: 'bound-device' },
      device: { backend: 'local-ios', udid: own.udid, name: own.name },
      bound: true,
    };
  }
  const session = bindings.find((entry) => entry.backend === 'cloud' && entry.state === 'recorded');
  return session
    ? {
        platform: { value: session.platform, by: 'bound-device' },
        device: { backend: 'cloud', deviceId: session.id },
        bound: true,
      }
    : READ_EVERY_TARGET;
}

/**
 * Split the live targets by owner, with the placement rules of `runtime:eval` (`classifyTargets`).
 *
 * A target is on this worktree's EAS session only when it is the one app the session's scope reads:
 * a physical device and another session's app look the same, so two or more stay unnamed.
 */
export function classifyConnectedApps(
  liveTargets: readonly CdpTarget[],
  inventory: DeviceInventory,
  bindings: readonly BindingSummary[]
): ConnectedAppOwners {
  const scope = scopeOf(inventory, bindings);
  const { read, otherPlatform, skipped } = classifyTargets([...liveTargets], scope, inventory);
  const bootedNames = new Set(inventory.booted.map((simulator) => simulator.name));
  const onBootedSimulator = (target: Pick<CdpTarget, 'deviceName'>) =>
    bootedNames.has(target.deviceName);
  const names = (targets: readonly Pick<CdpTarget, 'deviceName'>[]) =>
    targets.map((target) => target.deviceName);

  const owners: ConnectedAppOwners = {
    simulatorApps: [],
    localApps: [],
    otherWorktreeApps: skippedAppsOf({ skipped })
      .filter((app) => app.group === 'other-worktree')
      .map((app) => app.deviceName),
    sessionApps: 0,
  };
  // Another device, or another platform than the session's (an Android session beside a simulator).
  const notBoundHere = [
    ...skipped
      .filter(({ classification }) => classification.group === 'other-device')
      .map(({ target }) => target),
    ...otherPlatform.map(({ target }) => target),
  ].filter(onBootedSimulator);
  switch (scope.device?.backend) {
    case 'local-ios':
      owners.simulatorApps = names(read);
      owners.localApps = names(notBoundHere);
      break;
    case 'cloud':
      owners.sessionApps = read.length === 1 ? 1 : 0;
      owners.localApps = names(notBoundHere);
      break;
    default:
      owners.localApps = names(read.filter(onBootedSimulator));
  }
  return owners;
}

/** Ask the device tools once, within `timeoutMs`, and classify. Null when nothing needs saying. */
export async function readConnectedAppsAsync(
  projectRoot: string,
  liveTargets: readonly CdpTarget[],
  bindings: readonly BindingSummary[],
  timeoutMs: number
): Promise<ConnectedAppOwners | null> {
  const inventory = {
    ...(await readDeviceInventoryAsync(timeoutMs)),
    iosBindings: liveIosBindings(projectRoot),
  };
  const owners = classifyConnectedApps(liveTargets, inventory, bindings);
  return owners.localApps.length > 0 || owners.otherWorktreeApps.length > 0 ? owners : null;
}
