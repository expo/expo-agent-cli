// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// The dev-server lock: a listening socket that answers where this project's dev server is.
//
// Why a socket and not a file: a file records a fact, and a record of a running process outlives
// the process. Every reader then has to guess whether what it read is still true, which is the
// bug the legacy `packager-info.json` had. A socket cannot lie about liveness — a reader that got
// an answer got it from a process that was alive when it answered.

export { DEV_LOCK_PIPE_PREFIX, DEV_LOCK_SOCKET_NAME, lockAddressFor } from './address';
export type { DevLockAddress } from './address';
export {
  DEV_LOCK_CONNECT_TIMEOUT_MS,
  probeDevServerLockAsync,
  readDevServerLockAsync,
} from './client';
export type { DevLockProbe } from './client';
export { publishDevServerPortAsync, publishPlannedPortAsync } from './publishPort';
export { RunLock, withRunLockAsync } from './runLock';
export {
  DEFAULT_DEV_SERVER_PORT,
  PORT_WATCH_INTERVAL_MS,
  PORT_WATCH_TIMEOUT_MS,
  readPortArg,
  resolveDevServerPortAsync,
} from './port';
export type { ResolvedDevServerPort, ResolveDevServerPortOptions } from './port';
export { acquireDevServerLockAsync } from './server';
export type { DevServerLockResult } from './server';
export type { DevServerLockHandle, DevServerLockInfo } from './types';
