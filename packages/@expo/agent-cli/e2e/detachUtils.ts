// Helpers for the e2e tests of a detached dev server (`dev --detach`, `dev:logs`).
import path from 'node:path';

import { executeAgentCliAsync, stubExpoEnv } from './utils';

/** Where a detached dev server writes, per `src/dev/logFile.ts`. Spelled out, as a wire contract. */
export const DETACHED_LOG_PATH = path.join('.expo', 'dev', 'logs', 'dev-detached.log');

/** Long enough for a test to do its work against a running dev server, short enough to end. */
export const STUB_ALIVE_MS = '20000';

/** Environment for a detached run whose stub dev server stays up and reports `port`. */
export function detachEnv(projectRoot: string, port: number): Record<string, string> {
  return {
    ...stubExpoEnv(projectRoot),
    STUB_EXPO_DELAY_MS: STUB_ALIVE_MS,
    STUB_EXPO_DEV_SERVER_PORT: String(port),
  };
}

/** Stop whatever a detached test started, so a failed assertion never leaves a process behind. */
export async function cleanUpDetachedAsync(projectRoot: string): Promise<void> {
  await executeAgentCliAsync(projectRoot, ['dev:stop', '--json'], {
    env: stubExpoEnv(projectRoot),
    reject: false,
  });
}
