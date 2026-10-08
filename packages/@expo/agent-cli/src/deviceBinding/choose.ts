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
 * The own binding is reused, live or expired, when the inventory lists its simulator as available.
 * An own binding whose simulator is gone or unavailable is for the caller to remove; the choice goes
 * on to a create.
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
  // A simulator whose runtime was removed is still listed, unavailable; reusing it fails every
  // boot, and a failed boot keeps the binding, so it counts as gone.
  const listed = inventory.simulators.find((entry) => entry.udid === ownUdid && entry.isAvailable);
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

export interface AndroidInventory {
  /** The first AVD of `emulator -list-avds`, or null when there is none. */
  avd: string | null;
  /** The serials `adb devices -l` lists as ready. */
  runningSerials: string[];
}

/** A serial on a console port and the worktree bound to it; `root` is null for one that is not ours. */
export interface BoundSerial {
  id: string;
  root: string | null;
}

export type AndroidChoice =
  | { kind: 'reuse'; binding: Binding }
  | { kind: 'android-spawn'; port: number; avd: string }
  | { kind: 'refuse'; reason: 'no-avd' | 'no-free-port' | 'not-reusable'; boundBy?: BoundSerial[] };

/** Console ports of emulator instances: even, 5554 first, 5584 last. */
export const FIRST_CONSOLE_PORT = 5554;
export const LAST_CONSOLE_PORT = 5584;

/** The console port of an `emulator-NNNN` serial, or null for any other device. */
export function consolePortOf(serial: string): number | null {
  const match = /^emulator-(\d+)$/.exec(serial);
  return match ? Number(match[1]) : null;
}

/**
 * Choose the emulator instance of a worktree.
 *
 * The own binding is reused, live or expired, when its instance is present: `ownPresent` is the
 * caller's answer (a `spawned` pid alive, an `explicit` serial listed). Otherwise a read-only
 * instance of the one AVD is spawned on the first free even console port.
 */
export function chooseAndroidDevice({
  own,
  ownPresent,
  inventory,
  reuseOnly,
  busyPorts,
  boundBy,
}: {
  own: Binding | null;
  ownPresent: boolean;
  inventory: AndroidInventory;
  reuseOnly: boolean;
  busyPorts: Set<number>;
  boundBy: BoundSerial[];
}): AndroidChoice {
  if (own != null && ownPresent) {
    return { kind: 'reuse', binding: own };
  }
  if (reuseOnly) {
    return { kind: 'refuse', reason: 'not-reusable' };
  }
  if (inventory.avd == null) {
    return { kind: 'refuse', reason: 'no-avd' };
  }
  for (let port = FIRST_CONSOLE_PORT; port <= LAST_CONSOLE_PORT; port += 2) {
    if (!busyPorts.has(port)) {
      return { kind: 'android-spawn', port, avd: inventory.avd };
    }
  }
  return { kind: 'refuse', reason: 'no-free-port', boundBy };
}
