// @ref llp/0027-everything-on-eas.rfc.md §dev:stop
// Ending one EAS Simulator session by id.

import { easCliArgs, easCliLabel, resolveEasCli, type EasCli } from '../utils/easCli';
import { spawnCaptureAsync } from '../utils/spawnCapture';
import { firstLine } from '../utils/text';

/** How long `eas simulator:stop` may take. */
export const EAS_SESSION_STOP_TIMEOUT_MS = 60_000;

/** The argv that ends one session, by id — never the bare form, which stops whatever the dotenv names. */
export function buildSessionStopArgs(sessionId: string): string[] {
  return ['simulator:stop', '--id', sessionId, '--non-interactive'];
}

/**
 * End one session by id. Never throws.
 *
 * By id and never the bare `simulator:stop`, which stops whatever `.env.eas-simulator` names —
 * possibly a session somebody else is driving.
 */
export async function stopEasSessionAsync(
  projectRoot: string,
  sessionId: string,
  easCli: EasCli | null = resolveEasCli(projectRoot)
): Promise<{ ok: boolean; reason: string | null }> {
  if (!easCli) {
    return { ok: false, reason: 'no "eas" or package runner is on PATH to stop the session with' };
  }
  const args = buildSessionStopArgs(sessionId);
  const result = await spawnCaptureAsync(easCli.command, easCliArgs(easCli, args), {
    cwd: projectRoot,
    timeoutMs: EAS_SESSION_STOP_TIMEOUT_MS,
  });
  if (result.spawnError) {
    return {
      ok: false,
      reason: `"${easCliLabel(easCli)} ${args[0]}" could not be run (${result.spawnError})`,
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `"${easCliLabel(easCli)} ${args.join(' ')}" exited ${result.exitCode}: ${
        firstLine(result.stderr) || firstLine(result.stdout) || 'it printed nothing'
      }`,
    };
  }
  return { ok: true, reason: null };
}
