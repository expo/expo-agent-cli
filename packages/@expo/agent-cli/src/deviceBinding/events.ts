import { events } from '2g';

declare module '2g' {
  interface EventRegistry {
    // @ref llp/0030-one-device-per-worktree.rfc.md §Output and errors
    /** A registry lock whose holder is dead was removed by a waiter. */
    'cli:device_registry_lock_removed': { lock: string; pid: number };
    /** A stale binding of another worktree was let go of. */
    'cli:device_binding_reaped': { reason: string };
  }
}

export const event = events('cli');
export const debugEvent = events.debug('cli');
