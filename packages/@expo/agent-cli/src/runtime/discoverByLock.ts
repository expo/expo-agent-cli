// @ref llp/0004-smart-start-and-project-state.rfc.md §Discovery ladder
// Step 0 of the discovery ladder: the project's dev-server lock.

import { readDevServerLockAsync } from '../devLock';
import { normalizeDevServerUrl, type DevServerDiscovery, type DevServerProbe } from './devServer';

/**
 * The dev server this project's lock names, or why a lock that answered was not used.
 *
 * The lock (`src/devLock/`) is a socket an `@expo/agent-cli`-started dev server holds open for as
 * long as it runs, and it answers with the URL it listens on. Nothing answers unless a process is
 * alive, so this step has no stale case to guard against. The URL is still probed, never trusted:
 * the lock proves that the wrapper is alive, and the probe proves that the dev server behind it is.
 * The lock names its port at the spawn, before Metro binds it, so the server there is this
 * project's only when `/status` names no other project's root (`matchProjectRoot`, the rule every
 * `/status` reader applies). Another root falls through.
 *
 * `miss` is null when no lock answered. Otherwise it names the lock's URL, so a failure later on
 * the ladder does not name only the default port it ended on.
 */
export async function discoverByLockAsync(
  projectRoot: string,
  probeAsync: (url: string) => Promise<DevServerProbe>,
  timeoutMs: number
): Promise<{ found: DevServerDiscovery; miss?: never } | { found?: never; miss: string | null }> {
  const lock = await readDevServerLockAsync(projectRoot);
  if (lock == null) {
    return { miss: null };
  }
  const lockUrl = normalizeDevServerUrl(lock.url);
  const lockProbe = await probeAsync(lockUrl);
  if (!lockProbe.reachable) {
    return {
      miss: `the project's dev-server lock named ${lockUrl}, which did not answer (${lockProbe.reason ?? 'no answer'})`,
    };
  }
  // Lazy: `./bundlerStatus` reaches `./discoverDevServer` through `./waitReady`.
  const { probeBundlerAsync } = require('./bundlerStatus') as typeof import('./bundlerStatus');
  const status = await probeBundlerAsync(lockUrl, { timeoutMs, projectRoot });
  if (status.projectRootMatched === false) {
    return {
      miss: `the project's dev-server lock named ${lockUrl}, which serves another project (${status.reportedProjectRoot})`,
    };
  }
  return { found: { ...lockProbe, devServerUrl: lockUrl, source: 'lock', discovered: true } };
}
