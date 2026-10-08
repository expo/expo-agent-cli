// @ref llp/0030-one-device-per-worktree.rfc.md §Choice
// Which device a worktree gets. Pure: the inventory and the bindings come in, a choice comes out.

import type { SimulatorEntry } from '../device/simulators';
import type { Binding } from './types';

export interface IosInventory {
  simulators: SimulatorEntry[];
  /** The highest available iOS runtime that lists an iPhone, and its first iPhone device type. */
  newestIosRuntime: { identifier: string; deviceType: string } | null;
}

export type IosChoice =
  | { kind: 'reuse'; binding: Binding; listed: SimulatorEntry }
  | { kind: 'ios-create'; runtime: string; deviceType: string; name: string }
  | { kind: 'refuse'; reason: 'no-ios-runtime' | 'not-reusable' };

/** The name of a created simulator, so a leaked one shows whose it was. Never identity. */
export function createdSimulatorName(digest: string): string {
  return `agent-cli ${digest.slice(0, 8)}`;
}

/**
 * Choose the simulator of a worktree.
 *
 * The own binding is reused, live or expired, when the inventory lists its simulator. An own
 * binding whose simulator is gone is for the caller to remove; the choice goes on to a create.
 */
export function chooseIosDevice({
  own,
  inventory,
  reuseOnly,
  digest,
}: {
  own: Binding | null;
  inventory: IosInventory;
  reuseOnly: boolean;
  digest: string;
}): IosChoice {
  const ownUdid = own?.device.backend === 'local-ios' ? own.device.udid : null;
  const listed = inventory.simulators.find((entry) => entry.udid === ownUdid);
  if (own != null && listed != null) {
    return { kind: 'reuse', binding: own, listed };
  }
  if (reuseOnly) {
    return { kind: 'refuse', reason: 'not-reusable' };
  }
  const runtime = inventory.newestIosRuntime;
  if (runtime == null) {
    return { kind: 'refuse', reason: 'no-ios-runtime' };
  }
  return {
    kind: 'ios-create',
    runtime: runtime.identifier,
    deviceType: runtime.deviceType,
    name: createdSimulatorName(digest),
  };
}
