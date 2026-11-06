import { getEventLoggerInfo } from '2g';

/**
 * Set on a detached child whose parent recorded debug events, so the child records them too.
 *
 * Not `LOG_DEBUG`: in a session, that also prints every event to stderr, which is the detached
 * child's log file, and failure messages quote that file.
 */
export const DETACHED_EVENT_DEBUG_ENV = '__EXPO_AGENT_CLI_EVENT_DEBUG';

/**
 * `env` for a child that outlives this process, with this process's `2g` event log handed on in a
 * form that outlives it too.
 *
 * `2g` gives children its IPC socket, which closes when this process exits, and the child's later
 * events are lost. So the IPC variables are removed. A `LOG_EVENTS` file is given again (2g removed
 * it from `process.env` and appends to it), and otherwise the child opens its own `2g` session
 * (@ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization).
 *
 * The three names are internal to `2g` 1.0.x (`INTERNAL_IPC_ENV` and its neighbours), which has no
 * public way to detach a child from the parent's log yet.
 */
export function detachedEventLogEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { __eventLogIpc, __eventLogProcessOrigin, __eventLogDebug, ...rest } = env;
  const info = getEventLoggerInfo();
  return {
    ...rest,
    ...(info?.file ? { LOG_EVENTS: info.file } : {}),
    ...(info?.debug ? { [DETACHED_EVENT_DEBUG_ENV]: '1' } : {}),
  };
}
