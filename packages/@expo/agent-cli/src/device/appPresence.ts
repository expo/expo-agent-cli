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

import type { NativePlatform } from '../plan/types';
import { readConfiguredAppId } from '../runtime/appId';
import { hasAppOnDeviceAsync } from './hasApp';
import { androidDeviceNameAsync } from './installDevBuild';
import { probeLocalDeviceAsync, type LocalDeviceProbe } from './localDevice';

/** Whether the development build is on the device, as far as this machine can be asked. */
export type AppPresence =
  /** The device was asked and has it. */
  | 'present'
  /** The device was asked and has not got it. The one answer that changes a plan. */
  | 'missing'
  /** Nothing was established, so the plan is the one that was made before this was asked. */
  | 'unknown';

/** The probe's answer, and the device it is about. */
export interface AppPresenceProbe {
  presence: AppPresence;
  /**
   * What `expo run:<platform> --device` calls the device that answered, or null.
   *
   * Set only for `missing`, which is the one answer that plans an install — the plan pins the
   * install to the device that was actually checked, so a machine with two devices cannot install
   * on one and keep serving nothing to the other. iOS takes the UDID as-is; Android takes a *name*,
   * which `androidDeviceNameAsync` resolves from the serial (@ref ./installDevBuild). A device the
   * platform cannot name stays null, and the install runs unpinned — the Expo CLI then picks the
   * attached device itself, which on a one-device machine is the same device.
   */
  installDevice: string | null;
}

/**
 * How long the whole question may take before the answer is `unknown`.
 *
 * The same discipline the other two callers of the device probe apply (`status` at 2500 ms, the
 * start banner at 1500 ms), with a budget sized to this question rather than copied from theirs:
 * this one runs `xcrun simctl list`, then reads the installed apps off the simulator disk one
 * `plutil` at a time, and the whole of that measured 2.6 s cold on a machine with one booted
 * simulator [observed — 2026-09-06]. A 2500 ms copy expired on exactly the machine the feature is
 * for, which turned it off silently — the plan was still right, and nobody would ever know why the
 * install step stopped appearing.
 *
 * So the number is for pathology, not pacing: an `adb` whose server hangs on start, a CoreSimulator
 * read that never returns. The expiry answers `unknown`, the underlying probe keeps running and
 * lands in its process-wide cache, and the warm re-ask costs ~20 ms.
 */
export const APP_PRESENCE_BUDGET_MS = 8000;

const UNPROBED: AppPresenceProbe = { presence: 'unknown', installDevice: null };

export interface ProbeAppPresenceOptions {
  /** Injected for tests. Defaults to the process-cached probe every other caller shares. */
  probeDeviceAsync?: () => Promise<LocalDeviceProbe>;
  /** Injected for tests. */
  readAppId?: typeof readConfiguredAppId;
  /** Injected for tests. */
  hasAppOnDevice?: typeof hasAppOnDeviceAsync;
  /** Injected for tests. */
  androidDeviceName?: typeof androidDeviceNameAsync;
  /** Overrides {@link APP_PRESENCE_BUDGET_MS}, for tests. */
  budgetMs?: number;
}

/**
 * Whether the development build of this project is installed on a device this machine has.
 *
 * The device is the one the run would open the app on: the first the local probe found for this
 * platform, which is the same choice `navigate` and `smoke` make. A machine with no device for the
 * platform answers `unknown` rather than `missing` — nothing was asked, and `expo start` boots one
 * itself, so a plan is in no position to claim the app is not on a device that does not exist yet.
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
  options: ProbeAppPresenceOptions = {}
): Promise<AppPresenceProbe> {
  if (process.env.AGENT_CLI_NO_DEVICE === '1') {
    return UNPROBED;
  }
  const budgetMs = options.budgetMs ?? APP_PRESENCE_BUDGET_MS;

  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<AppPresenceProbe>((resolve) => {
    timer = setTimeout(() => resolve(UNPROBED), budgetMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([askDeviceAsync(projectRoot, platform, options), expired]);
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
  {
    probeDeviceAsync = probeLocalDeviceAsync,
    readAppId = readConfiguredAppId,
    hasAppOnDevice = hasAppOnDeviceAsync,
    androidDeviceName = androidDeviceNameAsync,
  }: ProbeAppPresenceOptions
): Promise<AppPresenceProbe> {
  // The app id first, because it is a file read and the device probe is two subprocesses. A
  // project whose config names no `bundleIdentifier` cannot be looked for under any name, and
  // asking a device about the Expo Go id instead would answer about a different app entirely.
  const appId = readAppId(projectRoot, platform);
  if (appId == null) {
    return UNPROBED;
  }

  const probe = await probeDeviceAsync();
  const device = probe.devices.find((candidate) => candidate.platform === platform);
  if (device == null) {
    return UNPROBED;
  }

  // Three-valued through and through (@ref ./hasApp): `null` is "could not look" — a simulator
  // whose data directory is unreadable, an adb that would not run, a cloud device this machine
  // cannot see — and it must never read as `missing`, whose cost is an install.
  const installed = await hasAppOnDevice(device.deviceId, device.backend, appId);
  if (installed == null) {
    return UNPROBED;
  }
  if (installed) {
    return { presence: 'present', installDevice: null };
  }
  return {
    presence: 'missing',
    installDevice:
      platform === 'ios' ? device.deviceId : await androidDeviceName(device.deviceId),
  };
}
