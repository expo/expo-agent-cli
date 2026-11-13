// @ref llp/0004-smart-start-and-project-state.rfc.md §Reported by status
// Who the apps connected to the dev server belong to, for the dev-server line of `status`.

import { devicesDisabled, hostBindsPlatform } from '../deviceBinding';
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
  /** How many apps run on this worktree's recorded EAS session: 0, or the one app left unplaced. */
  sessionApps: number;
  /** The apps no rule placed. */
  otherApps: number;
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
 * Null when no app runs on a local simulator that is not this worktree's: nothing needs saying.
 *
 * A target is on this worktree's EAS session only when it is the one app the session's scope reads:
 * a physical device and another session's app look the same, so two or more stay unnamed.
 */
export function classifyConnectedApps(
  liveTargets: readonly CdpTarget[],
  inventory: DeviceInventory,
  bindings: readonly BindingSummary[]
): ConnectedAppOwners | null {
  const scope = scopeOf(inventory, bindings);
  const { read, otherPlatform, skipped } = classifyTargets([...liveTargets], scope, inventory);
  const bootedNames = new Set(inventory.booted.map((simulator) => simulator.name));
  const names = (targets: readonly Pick<CdpTarget, 'deviceName'>[]) =>
    targets.map((target) => target.deviceName);
  const onBootedSimulator = (targets: readonly CdpTarget[]) =>
    targets.filter((target) => bootedNames.has(target.deviceName));

  const otherWorktreeApps = skippedAppsOf({ skipped })
    .filter((app) => app.group === 'other-worktree')
    .map((app) => app.deviceName);
  // Another device, or another platform than the session's (an Android session beside a simulator).
  const notBoundHere = onBootedSimulator([
    ...skipped
      .filter(({ classification }) => classification.group === 'other-device')
      .map(({ target }) => target),
    ...otherPlatform.map(({ target }) => target),
  ]);
  const owned = scope.device?.backend;
  const localApps = names(owned ? notBoundHere : onBootedSimulator(read));
  if (localApps.length === 0 && otherWorktreeApps.length === 0) {
    return null;
  }
  const simulatorApps = owned === 'local-ios' ? names(read) : [];
  const sessionApps = owned === 'cloud' && read.length === 1 ? 1 : 0;
  return {
    simulatorApps,
    localApps,
    otherWorktreeApps,
    sessionApps,
    otherApps:
      liveTargets.length -
      simulatorApps.length -
      sessionApps -
      localApps.length -
      otherWorktreeApps.length,
  };
}

/**
 * Ask the device tools once and classify. Null where no simulator can be asked about, or when
 * nothing needs saying. `timeoutMs` bounds each device tool.
 */
export async function readConnectedAppsAsync(
  projectRoot: string,
  liveTargets: readonly CdpTarget[],
  bindingRead: Promise<BindingSummary[]>,
  timeoutMs: number
): Promise<ConnectedAppOwners | null> {
  if (liveTargets.length === 0 || devicesDisabled() || !hostBindsPlatform('ios')) {
    return null;
  }
  const inventory = {
    ...(await readDeviceInventoryAsync(timeoutMs)),
    iosBindings: liveIosBindings(projectRoot),
  };
  return classifyConnectedApps(liveTargets, inventory, await bindingRead.catch(() => []));
}
