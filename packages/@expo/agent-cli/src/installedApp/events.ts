import { events } from '2g';
import type { SerializedError } from '2g';

declare module '2g' {
  interface EventRegistry {
    'installed_app:platform_check_failed': { platform: string; error: SerializedError };
    'installed_app:device_read_failed': { device: string; error: SerializedError };
    'installed_app:ranged_read_failed': { device: string; error: SerializedError };
  }
}

export const debugEvent = events.debug('installed_app');
