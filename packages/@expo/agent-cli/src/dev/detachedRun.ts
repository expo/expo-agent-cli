// @ref llp/0036-detached-run-ownership.rfc.md
import path from 'path';

import { readDevServerLockAsync } from '../devLock';
import { ATTEMPT_ID, ownershipError } from './detachedOwnership';
import { withDevRunAsync, type DevRun } from './devRun';
import { startupRequestFrom, type StartupRequest } from './startupRequest';
import { publishDetachedLog } from './logFile';
import { easOpenPlatform, type DevOptions } from './resolveOptions';
import { devServerRunningStopAsync } from './runningDevServer';

export const DETACHED_ATTEMPT_ENV = '__EXPO_AGENT_CLI_DETACHED_ATTEMPT';

export async function withDetachedRunAsync(
  root: string,
  options: DevOptions,
  work: (run: DevRun) => Promise<number>,
  request: StartupRequest = startupRequestFrom(options)
): Promise<number> {
  const id = process.env[DETACHED_ATTEMPT_ENV];
  delete process.env[DETACHED_ATTEMPT_ENV];
  if (!id || !ATTEMPT_ID.test(id)) throw ownershipError('Missing detached startup identity.');
  const logFile = path.join(root, '.expo', 'dev', 'logs', `dev-detached-${id}.log`);
  return withDevRunAsync(root, { request, detached: { id, logFile } }, async (run) => {
    const running = await readDevServerLockAsync(root);
    if (running)
      throw await devServerRunningStopAsync(root, running, options.platform, {
        eas: easOpenPlatform(options) != null,
      });
    run.signal.throwIfAborted();
    publishDetachedLog(root, logFile);
    return await work(run);
  });
}
