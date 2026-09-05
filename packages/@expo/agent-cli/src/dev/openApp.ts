// @ref llp/0026-dev-owns-the-open.rfc.md
// What `dev` does once its dev server is up: get the app onto a device and open it, through the
// same tools `navigate` and `smoke` use — `simctl` and `adb`, never AppleScript.
//
// `expo start --ios` opens the app too, and this module exists because of how that open fails:
// the Expo CLI checks Simulator.app through an osascript that a Mac without the Automation grant
// refuses, the rejection is uncaught, and the dev server dies with it (llp/0010 §Needs-human
// protocol). Opening from here needs no grant, so the platform flag never reaches `expo start`.

import { spawn } from 'child_process';

import { bootDeviceAsync, BOOT_DEVICE_TIMEOUT_MS } from '../device/bootDevice';
import { checkExpoGoVersionAsync } from '../device/expoGoVersion';
import { installExpoGoAsync } from '../device/installExpoGo';
import { simulatorHasAppAsync } from '../device/installedApps';
import { androidHasAppAsync } from '../device/androidApps';
import * as Log from '../log';
import { probeAndroidDeviceAsync, probeIosSimulatorAsync } from '../navigate/device';
import { openRouteAsync } from '../navigate/openRoute';
import { EXPO_GO_APP_IDS } from '../navigate/target';
import type { NativePlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import { readSdkVersionAsync } from '../project/nodeModules';
import { event } from './events';

/** Expo Go's app id per platform, out of the pair `navigate` recognises. */
const EXPO_GO_APP_ID: Record<NativePlatform, string> = {
  ios: EXPO_GO_APP_IDS[0]!,
  android: EXPO_GO_APP_IDS[1]!,
};

export interface OpenAppOptions {
  platform: NativePlatform;
  /** Whether the plan aims at Expo Go, which is the one app this module may install. */
  expoGo: boolean;
  /** Where the dev server this run started listens. */
  devServerUrl: string;
  /**
   * Whether the open is still worth performing, checked between the slow stages.
   *
   * The dev server can die while a simulator boots; a stage that has started runs to its own end,
   * but no further stage begins for a server that is gone.
   */
  stillWanted?: () => boolean;
  /** Whether a person is watching, which is when the Simulator window is worth surfacing. */
  interactive?: boolean;
}

/** What one open amounted to. Never throws: `dev`'s server outlives a failed open. */
export interface OpenAppReport {
  opened: boolean;
  deviceId: string | null;
  /** Whether this run booted the device, rather than finding one up. */
  booted: boolean;
  /** Whether this run installed (or replaced) Expo Go. */
  installedExpoGo: boolean;
  /** Why the app was not opened. Null exactly when {@link opened} is true. */
  reason: string | null;
}

/**
 * Boot a device if none is up, put Expo Go on it if the plan needs one, and open the app on the
 * dev server — the deep-link door, which works headless and needs no macOS Automation grant.
 *
 * Narrates each act on stderr as it starts, because a simulator boot and an Expo Go download are
 * both waits a caller would otherwise read as a hang.
 */
export async function openAppOnDeviceAsync(
  projectRoot: string,
  options: OpenAppOptions
): Promise<OpenAppReport> {
  const { platform } = options;
  const stillWanted = options.stillWanted ?? (() => true);
  const stopped = (reason: string, partial: Partial<OpenAppReport> = {}): OpenAppReport => ({
    opened: false,
    deviceId: null,
    booted: false,
    installedExpoGo: false,
    reason,
    ...partial,
  });

  // A device: the one that is up, or one this run boots.
  const probe =
    platform === 'ios' ? await probeIosSimulatorAsync() : await probeAndroidDeviceAsync();
  let deviceId = probe.device?.deviceId ?? null;
  let booted = false;
  if (deviceId == null) {
    if (probe.toolError) {
      return stopped(firstLine(probe.toolError.message));
    }
    if (!stillWanted()) {
      return stopped('the dev server stopped before a device was booted');
    }
    Log.progress(`No ${deviceNoun(platform)} is up — booting one.`);
    event('open_app_boot', { platform });
    const boot = await bootDeviceAsync(platform, {
      timeoutMs: BOOT_DEVICE_TIMEOUT_MS[platform],
      mayInstall: options.expoGo,
      appId: options.expoGo ? EXPO_GO_APP_ID[platform] : null,
      appLabel: options.expoGo ? 'Expo Go' : null,
    });
    if (!boot.ok || boot.deviceId == null) {
      return stopped(boot.reason ?? 'no device could be booted');
    }
    deviceId = boot.deviceId;
    booted = true;
  }

  // The window, for a person: `open -a Simulator` is LaunchServices and needs no Automation
  // grant, unlike the osascript check the Expo CLI runs. Fire and forget — a headless simulator
  // answers `simctl openurl` all the same, so nothing below depends on it.
  if (platform === 'ios' && options.interactive) {
    surfaceSimulatorWindow();
  }

  // Expo Go, at the release this project's SDK ships — the same rule `smoke` and `@expo/cli`
  // apply. Only for a plan that aims at Expo Go: a development build is this project's own app,
  // and installing one is a build, which is the plan's business rather than the open's.
  let installedExpoGo = false;
  if (options.expoGo && stillWanted()) {
    const sdkVersion = await readSdkVersionAsync(projectRoot);
    const appId = EXPO_GO_APP_ID[platform];
    const has =
      platform === 'ios'
        ? await simulatorHasAppAsync(deviceId, appId).catch(() => null)
        : await androidHasAppAsync(deviceId, appId);
    const version =
      has === true ? await checkExpoGoVersionAsync(deviceId, platform, sdkVersion) : null;
    if (has !== true || version?.verdict === 'mismatch') {
      Log.progress(
        has === true
          ? `Replacing Expo Go with the release SDK ${sdkVersion ?? '(unknown)'} ships. A download of a few hundred megabytes — nothing is stuck.`
          : `Installing Expo Go for SDK ${sdkVersion ?? '(unknown)'}. A download of a few hundred megabytes — nothing is stuck.`
      );
      event('open_app_install_expo_go', { platform, replaced: has === true });
      const installed = await installExpoGoAsync(deviceId, platform, sdkVersion);
      if (!installed.ok) {
        return stopped(installed.reason ?? 'Expo Go could not be installed', {
          deviceId,
          booted,
        });
      }
      installedExpoGo = true;
    }
  }

  if (!stillWanted()) {
    return stopped('the dev server stopped before the app was opened', {
      deviceId,
      booted,
      installedExpoGo,
    });
  }

  // The open itself is `navigate /`: the deep-link ladder that already knows Expo Go from a
  // development build, runs `adb reverse` for an emulator, and deep-links through the device tool.
  try {
    const result = await openRouteAsync(projectRoot, {
      route: '/',
      platform,
      devServerUrl: options.devServerUrl,
      devServerUrlSource: 'discovered',
      routeCheck: false,
      command: 'navigate',
    });
    if (result.exitCode !== 0) {
      return stopped(
        `the device refused the deep link ("${result.command}" exited ${result.exitCode})`,
        { deviceId, booted, installedExpoGo }
      );
    }
    event('open_app_opened', { platform, deviceId, booted, installedExpoGo });
    return { opened: true, deviceId, booted, installedExpoGo, reason: null };
  } catch (error: unknown) {
    return stopped(error instanceof Error ? firstLine(error.message) : String(error), {
      deviceId,
      booted,
      installedExpoGo,
    });
  }
}

/** The one line `dev` says about an open that did not happen, with the door that still works. */
export function openAppFailureLine(platform: NativePlatform, reason: string): string {
  return `The dev server is running and the app was not opened on ${platform}: ${reason}. Open it with "${PROGRAM_PREFIX} navigate /" once a device is up.`;
}

function deviceNoun(platform: NativePlatform): string {
  return platform === 'ios' ? 'iOS simulator' : 'Android device or emulator';
}

/**
 * Open Simulator.app so the booted simulator has a window.
 *
 * `open -a` goes through LaunchServices and needs no Automation grant. Xcode 27 renames the app
 * to DeviceHub, so that name is tried when the first is refused — the same pair `@expo/cli` opens.
 */
function surfaceSimulatorWindow(): void {
  try {
    const child = spawn('open', ['-a', 'Simulator'], { stdio: 'ignore', detached: true });
    child.once('error', () => {});
    child.once('exit', (code) => {
      if (code !== 0) {
        const fallback = spawn('open', ['-a', 'DeviceHub'], { stdio: 'ignore', detached: true });
        fallback.once('error', () => {});
        fallback.unref();
      }
    });
    child.unref();
  } catch {
    // The window is a courtesy; a headless simulator answers everything below.
  }
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? text;
}
