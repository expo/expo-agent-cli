// @ref llp/0009-smart-followups.rfc.md §Device-aware ladders
// @ref llp/0030-one-device-per-worktree.rfc.md §Readers
// Does this worktree have a device to open an app on?
//
// Every rung of the CLI's ladders that reaches a screen — `@expo/agent-cli navigate /`, the screenshot
// follow-up, `status`'s own `next` line — needs a *local* device: the iOS simulator this worktree
// bound with `dev`, or an Android device `adb` can see. A dogfood session drove Expo Go on a
// **cloud** simulator through a tunnel, from a machine with neither, and every one of those
// suggestions was an instruction to run something that could not work [observed — 2026-08-24]. The
// CLI had no way to know, because it had never asked.
//
// So it asks, once per process and root, and the answer has three values rather than two. `absent`
// is the one that changes what is suggested, and it may only be given by a platform tool that
// **ran** and reported nothing. A tool that is not installed establishes nothing — a Linux machine
// with no `adb` is not a machine with no device — and that case answers `unknown`, which leaves
// every ladder exactly as it was.

import { inspectBindingCachedAsync, type Inspection } from '../deviceBinding';
import {
  navigateDeviceOf,
  probeAndroidDeviceAsync,
  type DeviceProbe,
  type NavigateDevice,
} from '../navigate/device';

/** What this machine has to open an app on. */
export type LocalDeviceState =
  /** A bound simulator is up, or an attached device was found. */
  | 'present'
  /** Every rung ran and reported none. */
  | 'absent'
  /** Nothing could be established, so nothing may be concluded. */
  | 'unknown';

export interface LocalDeviceProbe {
  state: LocalDeviceState;
  /** The device that was found, when one was. The first, in the order the probes ran. */
  device: NavigateDevice | null;
  /**
   * **Every** device that was found, in the order the probes ran.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §navigate — F106.
   * `device` is one device because every ladder that reads this only needs to know that a device
   * exists. A *report* needs more than that: iOS is probed first on macOS, so a machine with a
   * booted simulator and an attached emulator answered `ios iPhone 17 Pro` and never mentioned the
   * emulator — on a run whose only connected app was Expo Go on that emulator [observed —
   * 2026-08-27]. Empty exactly when {@link device} is null.
   */
  devices: NavigateDevice[];
  /** Why the state is what it is, for a report that has to explain itself. Null when `present`. */
  reason: string | null;
}

export interface ProbeLocalDeviceOptions {
  /** The worktree whose bindings are read. */
  projectRoot: string;
  /** The iOS rung, injected for tests. Defaults to the cached inspection of the own binding. */
  inspectIosAsync?: (projectRoot: string) => Promise<Inspection>;
  /** The Android rung, injected for tests. Defaults to main's first-`adb`-device probe. */
  probeAndroidAsync?: () => Promise<DeviceProbe>;
  hostPlatform?: NodeJS.Platform;
}

const cached = new Map<string, Promise<LocalDeviceProbe>>();

/** Forget what this process probed. For tests, and for nothing else. */
export function resetLocalDeviceCache(): void {
  cached.clear();
}

/**
 * Whether this worktree has a device to open an app on.
 *
 * One probe per process and root: the promise is cached rather than the result, so the several
 * callers of one command — the status sections and its follow-ups, say — share one inspection and
 * one `adb`. Never rejects: a suggestion ladder must not be the thing that fails a command, so a
 * probe that throws answers `unknown`.
 */
export function probeLocalDeviceAsync(options: ProbeLocalDeviceOptions): Promise<LocalDeviceProbe> {
  let pending = cached.get(options.projectRoot);
  if (!pending) {
    pending = runProbesAsync(options);
    cached.set(options.projectRoot, pending);
  }
  return pending;
}

async function runProbesAsync({
  projectRoot,
  inspectIosAsync = (root) => inspectBindingCachedAsync(root, 'ios', 'local-ios'),
  probeAndroidAsync = probeAndroidDeviceAsync,
  hostPlatform = process.platform,
}: ProbeLocalDeviceOptions): Promise<LocalDeviceProbe> {
  try {
    const [ios, android] = await Promise.all([
      hostPlatform === 'darwin' ? inspectIosAsync(projectRoot) : null,
      probeAndroidAsync(),
    ]);
    return readLocalDeviceProbe(ios, android);
  } catch (error: unknown) {
    return {
      state: 'unknown',
      device: null,
      devices: [],
      reason: `the device probe could not run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Fold the two rungs into one answer.
 *
 * Pure, so the rule that decides `absent` from `unknown` is testable without a simulator: any `up`
 * binding or attached device is `present`; else an `unreadable` or `unknown` binding, or an `adb`
 * that could not run, is `unknown`; else `absent`, with the first state seen as the reason.
 */
export function readLocalDeviceProbe(
  ios: Inspection | null,
  android: DeviceProbe
): LocalDeviceProbe {
  const devices: NavigateDevice[] = [];
  if (ios?.state === 'up' && ios.binding) {
    devices.push(navigateDeviceOf(ios.binding.device));
  }
  if (android.device) {
    devices.push(android.device);
  }
  if (devices.length > 0) {
    return { state: 'present', device: devices[0]!, devices, reason: null };
  }

  const reasons = [
    ios ? `iOS: ${iosReason(ios)}` : null,
    android.reason ? `Android: ${android.reason}` : null,
  ].filter((reason): reason is string => reason != null);
  const unknown =
    ios?.state === 'unreadable' || ios?.state === 'unknown' || android.toolError != null;
  return {
    state: unknown ? 'unknown' : 'absent',
    device: null,
    devices: [],
    reason:
      reasons.join('; ') ||
      (unknown ? 'nothing is known about this machine' : 'no device was found'),
  };
}

function iosReason(inspection: Inspection): string {
  switch (inspection.state) {
    case 'none':
      return 'no simulator is bound to this worktree';
    case 'unreadable':
      return `the binding file ${inspection.path} does not parse`;
    case 'unknown':
      return inspection.cause === 'timeout'
        ? 'the simulator check timed out'
        : (inspection.toolError?.message.split('\n')[0] ?? 'the device tool could not run');
    case 'gone':
      return inspection.cause === 'expired'
        ? 'the lease on the bound simulator expired'
        : 'the bound simulator is gone';
    case 'not-up':
      return 'the bound simulator is not up';
    default:
      return inspection.state;
  }
}
