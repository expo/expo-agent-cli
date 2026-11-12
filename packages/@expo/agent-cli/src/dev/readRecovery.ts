import { readDevServerLockAsync } from '../devLock';
import type { DeviceBackend, PlanPlatform } from '../plan/types';
import { defaultSmokePlatformAsync } from '../smoke/suggest';
import { observeDetachedRunAsync } from './detachedOwnership';
import { readLastDevRequest } from './lastRequest';
import { recoveryRequestFor } from './recoveryRequest';

/** Read ownership and advisory intent separately; only the owner proves work is in progress. */
export async function readRecoveryFactsAsync(
  root: string,
  options: { platform?: PlanPlatform; deviceBackend?: DeviceBackend } = {}
) {
  const [ownership, lock] = await Promise.all([
    observeDetachedRunAsync(root),
    readDevServerLockAsync(root),
  ]);
  const saved =
    (ownership.kind === 'live' ? ownership.attempt.request : null) ?? readLastDevRequest(root);
  const platform =
    options.platform ??
    lock?.easPlatform ??
    saved?.platform ??
    (await defaultSmokePlatformAsync(root));
  return {
    ownership,
    lock,
    request: recoveryRequestFor(platform, saved, {
      deviceBackend: options.deviceBackend,
      ...(lock ? { port: lock.port } : {}),
    }),
  };
}
