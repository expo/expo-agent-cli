// @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
import { readDevServerLockAsync } from '../devLock';
import { readLastDevRequest } from '../dev/lastRequest';
import { childStartsSessionSync } from '../dev/detachEasProgress';
import { CloudBindingError } from '../deviceBinding/errors';
import { rerunDevCommand } from '../plan/rerun';
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
    const args = [
      '--eas',
      '--port',
      String(server.port),
      ...(request?.runTarget ? [request.runTarget === 'expo-go' ? '--go' : '--dev-client'] : []),
    ];
    const command = childStartsSessionSync(root, server, error.platform)
      ? `${PROGRAM_PREFIX} dev:logs`
      : `${PROGRAM_PREFIX} dev:stop && ${rerunDevCommand(error.platform, args)}`;
    error.suggestedCommand = command;
    error.message = `${error.message.split('\n')[0]}\nHow: run "${command}". Plain stop preserves sessions; the next start binds a usable session.`;
    throw error;
  }
}
