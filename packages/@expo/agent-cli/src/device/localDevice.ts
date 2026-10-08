// @ref llp/0009-smart-followups.rfc.md §Device-aware ladders
// @ref llp/0030-one-device-per-worktree.rfc.md §Readers
// Does this worktree have a device to open an app on?
//
// Every rung of the CLI's ladders that reaches a screen — `@expo/agent-cli navigate /`, the screenshot
// follow-up, `status`'s own `next` line — needs a *local* device: the iOS simulator or the Android
// emulator instance this worktree bound with `dev`. A dogfood session drove Expo Go on a **cloud**
// simulator through a tunnel, from a machine with neither, and every one of those suggestions was
// an instruction to run something that could not work [observed — 2026-08-24]. The CLI had no way
// to know, because it had never asked.
//
// So it asks, once per process and root, and the answer has three values rather than two. `absent`
// is the one that changes what is suggested, and it may only be given by a binding that was read
// and a platform tool that **ran**. A tool that is not installed establishes nothing — a Linux
// machine with no `adb` is not a machine with no device — and that case answers `unknown`, which
// leaves every ladder exactly as it was.

import { inspectBindingCachedAsync, type Inspection } from '../deviceBinding';
import { navigateDeviceOf, type NavigateDevice, type NavigatePlatform } from '../navigate/device';

/** What this machine has to open an app on. */
export type LocalDeviceState =
  /** A bound device is up. */
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
  /** The Android rung, injected for tests. Defaults to the cached inspection of the own binding. */
  inspectAndroidAsync?: (projectRoot: string) => Promise<Inspection>;
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
 * callers of one command — the status sections and its follow-ups, say — share one inspection per
 * platform. Never rejects: a suggestion ladder must not be the thing that fails a command, so a
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
  inspectAndroidAsync = (root) => inspectBindingCachedAsync(root, 'android', 'local-android'),
  hostPlatform = process.platform,
}: ProbeLocalDeviceOptions): Promise<LocalDeviceProbe> {
  try {
    const [ios, android] = await Promise.all([
      hostPlatform === 'darwin' ? inspectIosAsync(projectRoot) : null,
      inspectAndroidAsync(projectRoot),
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
 * Pure, so the rule that decides `absent` from `unknown` is testable without a device: any `up`
 * binding is `present`; else any `unreadable` or `unknown` binding is `unknown`; else `absent`,
 * with the state of each rung as the reason.
 */
export function readLocalDeviceProbe(
  ios: Inspection | null,
  android: Inspection
): LocalDeviceProbe {
  const rungs: [NavigatePlatform, Inspection][] = [
    ...(ios ? ([['ios', ios]] as [NavigatePlatform, Inspection][]) : []),
    ['android', android],
  ];
  const devices = rungs
    .filter(([, inspection]) => inspection.state === 'up' && inspection.binding)
    .map(([, inspection]) => navigateDeviceOf(inspection.binding!.device));
  if (devices.length > 0) {
    return { state: 'present', device: devices[0]!, devices, reason: null };
  }
  const unknown = rungs.some(
    ([, inspection]) => inspection.state === 'unreadable' || inspection.state === 'unknown'
  );
  return {
    state: unknown ? 'unknown' : 'absent',
    device: null,
    devices: [],
    reason: rungs
      .map(
        ([platform, inspection]) =>
          `${platformLabel(platform)}: ${inspectionReason(inspection, platform)}`
      )
      .join('; '),
  };
}

function platformLabel(platform: NavigatePlatform): string {
  return platform === 'ios' ? 'iOS' : 'Android';
}

function inspectionReason(inspection: Inspection, platform: NavigatePlatform): string {
  const noun = platform === 'ios' ? 'simulator' : 'emulator instance';
  switch (inspection.state) {
    case 'none':
      return `no ${noun} is bound to this worktree`;
    case 'unreadable':
      return `the binding file ${inspection.path} does not parse`;
    case 'unknown':
      return inspection.cause === 'timeout'
        ? `the ${noun} check timed out`
        : (inspection.toolError?.message.split('\n')[0] ?? 'the device tool could not run');
    case 'gone':
      return inspection.cause === 'expired'
        ? `the lease on the bound ${noun} expired`
        : `the bound ${noun} is gone`;
    case 'not-up':
      return `the bound ${noun} is not up`;
    default:
      return inspection.state;
  }
}
