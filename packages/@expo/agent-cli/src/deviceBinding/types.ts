// @ref llp/0030-one-device-per-worktree.rfc.md §Records
// The records of the device registry: one binding per worktree, platform and backend.

import type { CommandError } from '../utils/errors';
import type { Runner } from '../utils/spawnCapture';

export type DevicePlatform = 'ios' | 'android';
export type BindingBackend = 'local-ios' | 'local-android' | 'cloud';

export type BoundDevice =
  | {
      backend: 'local-ios';
      platform: 'ios';
      udid: string;
      name: string;
      origin: 'created' | 'explicit';
    }
  | {
      backend: 'local-android';
      platform: 'android';
      serial: string;
      origin:
        | { kind: 'spawned'; avd: string; port: number; emulatorPid: number }
        | { kind: 'explicit' };
    }
  | {
      backend: 'cloud';
      platform: DevicePlatform;
      id: string;
      origin: 'started' | 'dotenv';
      tag?: string;
    };

export interface Binding {
  version: 1;
  device: BoundDevice;
  projectRoot: string;
  /** ISO; the session-cap clock, so a cloud reuse keeps it. */
  boundAt: string;
  /** ISO, the lease. */
  expiresAt: string;
}

/** A detached emulator this process spawned. `pid` is absent when the spawn itself failed. */
export interface EmulatorHandle {
  pid?: number;
  /** Resolves with the exit code once the process is gone; never while it runs. */
  exited: Promise<number | null>;
  kill(): void;
}

export interface DeviceTools {
  simctl: Runner;
  adb: Runner;
  /** `emulator -list-avds`. */
  emulatorList: Runner;
  spawnEmulator(args: string[]): EmulatorHandle;
  now: () => Date;
  isPidAlive: (pid: number) => boolean;
  /** The command line of a process, '' when `ps` lists none, null where `ps` does not exist. */
  commandOf: (pid: number) => string | null;
  kill: (pid: number) => void;
}

export type AcquireAction = 'reused' | 'created' | 'spawned' | 'explicit';

export interface AcquireResult {
  /** Acquisition identity for cleanup; absent on read-only plan previews. */
  binding?: Binding;
  device: BoundDevice;
  justBooted: boolean;
  action: AcquireAction;
}

export type InspectState =
  | 'none'
  | 'unreadable'
  | 'unknown'
  | 'recorded'
  | 'up'
  | 'not-up'
  | 'gone';

export type InspectCause = 'expired' | 'device-gone' | 'timeout' | 'tool';

export interface Inspection {
  binding: Binding | null;
  path: string;
  state: InspectState;
  cause?: InspectCause;
  toolError?: CommandError;
}

export interface ReleasedDevice {
  backend: BindingBackend;
  platform: DevicePlatform;
  id: string;
  name: string;
  released: boolean;
  shutDown: boolean;
  reason: string | null;
}

export function localBackendOf(platform: DevicePlatform): 'local-ios' | 'local-android' {
  return platform === 'ios' ? 'local-ios' : 'local-android';
}

/** The id a device is known by to its platform tool. */
export function deviceIdOf(device: BoundDevice): string {
  switch (device.backend) {
    case 'local-ios':
      return device.udid;
    case 'local-android':
      return device.serial;
    case 'cloud':
      return device.id;
  }
}

/** The name a person recognises the device by. */
export function deviceNameOf(device: BoundDevice): string {
  return device.backend === 'local-ios' ? device.name : deviceIdOf(device);
}

/** A record as the file holds it, or null when it is not one this CLI wrote. */
export function parseBinding(value: unknown): Binding | null {
  if (value == null || typeof value !== 'object') {
    return null;
  }
  const { version, device, projectRoot, boundAt, expiresAt } = value as Record<string, unknown>;
  if (
    version !== 1 ||
    typeof projectRoot !== 'string' ||
    typeof boundAt !== 'string' ||
    typeof expiresAt !== 'string' ||
    !isBoundDevice(device)
  ) {
    return null;
  }
  return { version: 1, device, projectRoot, boundAt, expiresAt };
}

function isBoundDevice(value: unknown): value is BoundDevice {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const device = value as Record<string, unknown>;
  switch (device.backend) {
    case 'local-ios':
      return (
        device.platform === 'ios' &&
        typeof device.udid === 'string' &&
        typeof device.name === 'string' &&
        (device.origin === 'created' || device.origin === 'explicit')
      );
    case 'local-android': {
      const origin = device.origin as Record<string, unknown> | null;
      return (
        device.platform === 'android' &&
        typeof device.serial === 'string' &&
        origin != null &&
        typeof origin === 'object' &&
        (origin.kind === 'explicit' ||
          (origin.kind === 'spawned' &&
            typeof origin.avd === 'string' &&
            typeof origin.port === 'number' &&
            typeof origin.emulatorPid === 'number'))
      );
    }
    case 'cloud':
      return (
        (device.platform === 'ios' || device.platform === 'android') &&
        typeof device.id === 'string' &&
        (device.origin === 'started' || device.origin === 'dotenv')
      );
    default:
      return false;
  }
}
