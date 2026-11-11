// @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
import { readDevServerLockAsync } from '../devLock';
import { readLastDevRequest } from '../dev/lastRequest';
import { childStartsSessionSync } from '../dev/detachEasProgress';
import { CloudBindingError } from '../deviceBinding/errors';
import { recoveryRequestFor, recoveryStartCommand } from '../dev/recoveryRequest';
import { PROGRAM_PREFIX } from '../programName';

/** Preserve the service's refusal; add the command-level server context to its recovery. */
export async function withCloudRecoveryAsync<T>(root: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof CloudBindingError)) throw error;
    const server = await readDevServerLockAsync(root);
    // Status handles pre-publication ownership. A pending open is observation only.
    if (!server) throw error;
    const request = readLastDevRequest(root);
    const restart = recoveryStartCommand(
      recoveryRequestFor(error.platform, request, {
        deviceBackend: 'eas',
        port: server.port,
      })
    );
    const command = childStartsSessionSync(root, server, error.platform)
      ? `${PROGRAM_PREFIX} dev:logs`
      : `${PROGRAM_PREFIX} dev:stop && ${restart}`;
    error.suggestedCommand = command;
    error.message = `${error.message.split('\n')[0]}\nHow: run "${command}". Plain stop preserves sessions; the next start binds a usable session.`;
    throw error;
  }
}
