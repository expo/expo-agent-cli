// @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
import { readRecoveryFactsAsync } from '../dev/readRecovery';
import { decideRecovery, renderRecovery } from '../dev/recovery';
import { CloudBindingError } from '../deviceBinding/errors';
import type { NativePlatform } from '../plan/types';

export async function readCloudRecoveryAsync(
  root: string,
  platform?: NativePlatform,
  { tunnel = false }: { tunnel?: boolean } = {}
) {
  const facts = await readRecoveryFactsAsync(root, { platform, deviceBackend: 'eas' });
  if (tunnel) facts.request = { ...facts.request, expo: { ...facts.request.expo, host: 'tunnel' } };
  return renderRecovery(decideRecovery({ ...facts, needsStart: true }));
}

/** Preserve the service's refusal; add the command-level server context to its recovery. */
export async function withCloudRecoveryAsync<T>(root: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof CloudBindingError)) throw error;
    error.withRecovery(await readCloudRecoveryAsync(root, error.platform));
    throw error;
  }
}
