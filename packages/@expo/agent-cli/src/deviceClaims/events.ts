// @ref llp/0030-one-device-per-agent.rfc.md §The registry
import { events } from '2g';
import type { SerializedError } from '2g';

import type { DeviceBackend } from './types';

declare module '2g' {
  interface EventRegistry {
    /** A worktree claimed a device: no other worktree allocates it while the claim is live. */
    'cli:device_claim_written': {
      backend: DeviceBackend;
      id: string;
      projectRoot: string;
      created: boolean;
    };
    /** The worktree that held the claim gave the device up. */
    'cli:device_claim_released': { backend: DeviceBackend; id: string; projectRoot: string };
    /**
     * A stale claim of another worktree was removed, because its device is gone or because this
     * worktree takes the device over.
     */
    'cli:device_claim_stale_removed': {
      backend: DeviceBackend;
      id: string;
      projectRoot: string;
      reason: 'device-gone' | 'taken-over' | 'expired';
    };
    /** The registry lock was older than its limit, so its holder was taken to be dead. */
    'cli:device_registry_lock_stale_removed': { lock: string; ageMs: number };
    /** A holder found its registry lock removed or taken over while it still ran. */
    'cli:device_registry_lock_lost': { lock: string; reason: string };
    /** A claim file that did not parse was old enough to be a crash mid-write, so it was removed. */
    'cli:device_claim_unreadable_removed': { file: string; ageMs: number };
    /** A created device whose claim expired could not be deleted. Its claim stays for a retry. */
    'cli:device_delete_failed': { backend: DeviceBackend; id: string; error: SerializedError };
    /** A claim's `touchedAt` could not be refreshed. The verb goes on; the claim ages as before. */
    'cli:device_claim_touch_failed': { backend: DeviceBackend; id: string; reason: string };
    /** A file in the registry is not a claim. It is ignored, so it holds no device. */
    'cli:device_claim_unreadable': { file: string; reason: string };
  }
}

export const event = events('cli');
export const debugEvent = events.debug('cli');
