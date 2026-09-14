// @ref llp/0028-installed-app-check.rfc.md §What the answer is
// What the installed-app check needs to run. `status` owns the flags that fill this in; nothing
// here parses argv, because the check is not a command of its own.

export type InstalledAppPlatform = 'ios' | 'android';

export interface InstalledAppOptions {
  /** The platforms to check, in report order. */
  platforms: InstalledAppPlatform[];
  /**
   * Only the simulator or device matching this name or identifier.
   *
   * Also the consent for the physical-iPhone probe: that probe *launches the app*, which `status`
   * must never do on its own, so a phone is only ever asked when the caller named one here.
   */
  device: string | null;
  /** The application id to look for instead of the project's own. */
  appId: string | null;
  /** `false` for `--no-fingerprint-cache`; undefined leaves the environment variable to decide. */
  fingerprintCache: boolean | undefined;
  /** How long a physical iOS device gets to report its fingerprint. */
  timeoutMs: number;
}

/** The platforms this host can reach a device for. iOS simulators only exist on macOS. */
export function hostPlatforms(hostPlatform: string = process.platform): InstalledAppPlatform[] {
  return hostPlatform === 'darwin' ? ['android', 'ios'] : ['android'];
}
