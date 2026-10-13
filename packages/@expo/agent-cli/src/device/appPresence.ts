// @ref llp/0004-smart-start-and-project-state.rfc.md §A current build is not an installed app
// Whether this project's development build is already on the device the run would open it on.
//
// The gap this closes: a fingerprint that matches the recorded build proves the *build* is current
// and says nothing about where it is. `dev` read the match as "there is nothing to do but serve",
// so a project whose build was recorded on this machine — and then wiped with the simulator, or
// never installed because the build came from EAS — got a dev server and no app to answer it. The
// plan was right about the build and wrong about the run.
//
// **`unknown` keeps the old plan, and that is the whole of the safety story here.** The two wrong
// answers do not cost the same. A false `missing` spends a minute on an install nobody needed; a
// false `present` leaves a dev server serving nothing, which is the bug above. But `unknown` is not
// a third cost — it is the state this CLI was already in on every run before this module existed,
// so falling back to it can only ever plan what it planned yesterday. That makes every probe below
// free to give up: no device, no app id, a tool that would not run, a deadline that expired, a
// platform this host cannot ask about. None of them are failures.

import {
  deviceIdOf,
  devicesDisabled,
  type AcquireAction,
  type BoundDevice,
} from '../deviceBinding';
import type { NativePlatform } from '../plan/types';
import { readConfiguredAppId } from '../runtime/appId';
import { hasAppOnDeviceAsync } from './hasApp';

/** Whether the development build is on the device, as far as this machine can be asked. */
export type AppPresence =
  /** The device was asked and has it. */
  | 'present'
  /** The device was asked and has not got it. The one answer that changes a plan. */
  | 'missing'
  /** Nothing was established, so the plan is the one that was made before this was asked. */
  | 'unknown';

/** The probe's answer. `dev` pins every `run` and `install` step to the bound device itself. */
export interface AppPresenceProbe {
  presence: AppPresence;
}

/**
 * The device `dev` bound for this run, and how. Null when the run bound none: `--eas`, a host
 * that cannot run the platform's device, or a harness with devices off.
 *
 * @ref llp/0031-ios-binding.plan.md §How `dev` uses it
 */
export interface AppPresenceDevice {
  device: BoundDevice | null;
  action: AcquireAction | null;
}

/**
 * How long the whole question may take before the answer is `unknown`.
 *
 * The same discipline the other two callers of the device probe apply (`status` at 2500 ms, the
 * start banner at 1500 ms), with a budget sized to this question rather than copied from theirs:
 * this one reads the installed apps off the simulator disk one `plutil` at a time, or asks `adb`
 * for the package, and the whole of that measured 2.6 s cold on a machine with one booted
 * simulator [observed — 2026-09-06]. A 2500 ms copy expired on exactly the machine the feature is
 * for, which turned it off silently — the plan was still right, and nobody would ever know why the
 * install step stopped appearing.
 *
 * So the number is for pathology, not pacing: an `adb` whose server hangs on start, a CoreSimulator
 * read that never returns. The expiry answers `unknown`.
 */
export const APP_PRESENCE_BUDGET_MS = 8000;

const UNPROBED: AppPresenceProbe = { presence: 'unknown' };

export interface ProbeAppPresenceOptions {
  /** Injected for tests. */
  readAppId?: typeof readConfiguredAppId;
  /** Injected for tests. */
  hasAppOnDevice?: typeof hasAppOnDeviceAsync;
  /** Overrides {@link APP_PRESENCE_BUDGET_MS}, for tests. */
  budgetMs?: number;
}

/**
 * Whether the development build of this project is installed on the device this run bound.
 *
 * With a bound device the question is asked of that device, and a device this run `created` or
 * `spawned` is `missing` without asking, because a fresh simulator and a read-only emulator
 * instance never have the app. With none nothing is asked.
 *
 * `AGENT_CLI_NO_DEVICE` answers `unknown` without spawning anything, the same way it turns off the
 * open (`src/dev/devAsync.ts`): a stubbed harness has no device this could be true about, and a
 * probe that ran anyway would make its runs depend on the host machine's simulators.
 *
 * Never throws. Every failure below is an `unknown`.
 */
export async function probeAppPresenceAsync(
  projectRoot: string,
  platform: NativePlatform,
  bound: AppPresenceDevice,
  options: ProbeAppPresenceOptions = {}
): Promise<AppPresenceProbe> {
  if (devicesDisabled() || bound.device == null) {
    return UNPROBED;
  }
  if (bound.action === 'created' || bound.action === 'spawned') {
    return { presence: 'missing' };
  }
  const budgetMs = options.budgetMs ?? APP_PRESENCE_BUDGET_MS;

  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<AppPresenceProbe>((resolve) => {
    timer = setTimeout(() => resolve(UNPROBED), budgetMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      askDeviceAsync(projectRoot, platform, bound.device, options),
      expired,
    ]);
  } catch {
    // A probe is not allowed to be the thing that fails `dev`.
    return UNPROBED;
  } finally {
    clearTimeout(timer);
  }
}

/** The question itself, with the deadline and the crash guard handled by the caller above. */
async function askDeviceAsync(
  projectRoot: string,
  platform: NativePlatform,
  bound: BoundDevice,
  { readAppId = readConfiguredAppId, hasAppOnDevice = hasAppOnDeviceAsync }: ProbeAppPresenceOptions
): Promise<AppPresenceProbe> {
  // The app id first, because it is a file read and the device question is a subprocess. A
  // project whose config names no `bundleIdentifier` cannot be looked for under any name, and
  // asking a device about the Expo Go id instead would answer about a different app entirely.
  const appId = readAppId(projectRoot, platform);
  if (appId == null) {
    return UNPROBED;
  }
  // Three-valued through and through (@ref ./hasApp): `null` is "could not look" — an adb that
  // would not run, a cloud device this machine cannot see — and it must never read as `missing`,
  // whose cost is an install.
  const installed = await hasAppOnDevice(deviceIdOf(bound), bound.backend, appId);
  return installed == null ? UNPROBED : { presence: installed ? 'present' : 'missing' };
}
