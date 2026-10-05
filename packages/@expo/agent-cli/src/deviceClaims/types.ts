// @ref llp/0030-one-device-per-agent.rfc.md §The registry

export type DeviceBackend = 'local-ios' | 'local-android' | 'eas';

export type DevicePlatform = 'ios' | 'android';

/** One claimed device: the file `<backend>-<id>.json` in the registry holds exactly this. */
export interface DeviceClaim {
  backend: DeviceBackend;
  platform: DevicePlatform;
  /** Simulator UDID, adb serial, or EAS session id. */
  id: string;
  /** Resolved through symlinks, as the dev-server lock resolves it. */
  projectRoot: string;
  /** The process that wrote the claim, for a report that names the owner. Never for liveness. */
  pid: number;
  /** ISO 8601. */
  claimedAt: string;
  /** ISO 8601. Refreshed by every verb that uses the device. */
  touchedAt: string;
  /** This CLI created the device. Only such devices may be deleted. */
  created: boolean;
  /**
   * This CLI booted the device (a simulator boot or an emulator spawn), or created it. `dev:stop`
   * runs later, in another process, so the claim is what remembers it may shut the device down.
   */
  booted: boolean;
}

export type ClaimLiveness = 'live' | 'stale';

export type ClassifiedClaim = DeviceClaim & { liveness: ClaimLiveness };

/** One row of a backend's device inventory. Callers may extend it with their own fields. */
export interface DeviceCandidate {
  id: string;
  state: 'booted' | 'shutdown';
}

export type Allocation<C extends DeviceCandidate> =
  | { kind: 'reuse'; claim: DeviceClaim; liveness: ClaimLiveness }
  | { kind: 'take'; candidate: C; claim: DeviceClaim }
  | { kind: 'boot'; candidate: C; claim: DeviceClaim }
  | { kind: 'created'; candidate: C; claim: DeviceClaim }
  | { kind: 'exhausted'; holders: { id: string; projectRoot: string }[] }
  /** Step 0: the named device matches devices, and another live worktree holds each of them. */
  | { kind: 'claimed'; holders: { id: string; projectRoot: string }[] }
  /** Step 0: the name matches no device of the inventory. */
  | { kind: 'not-found' };

/**
 * What {@link Allocation} is before any IO: step 5 can only say that a device must be created,
 * because the device does not exist until the caller creates it under the registry lock.
 */
export type DeviceChoice<C extends DeviceCandidate> =
  | Exclude<Allocation<C>, { kind: 'created' }>
  | { kind: 'create' };
