import { events, type SerializedError } from '2g';

declare module '2g' {
  interface EventRegistry {
    'project:fingerprint_failed': { command?: string; error: string };
    'project:config_plugins_unknown': { reason: string };
    /** A computed fingerprint was not cached, because the project moved while it was computed. */
    'project:fingerprint_cache_skipped': { reason: string };
    'project:fingerprint_cache_write_failed': { error: SerializedError };
    /** An evaluated app config was not cached, because the project moved while it was evaluated. */
    'project:app_config_cache_skipped': { reason: string };
    'project:app_config_cache_write_failed': { error: SerializedError };
  }
}

export const event = events('project');
export const debugEvent = events.debug('project');
