// @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions — an existing Metro can get a fresh session.
import { resolveStartPlanAsync } from '../plan/resolveAsync';
import { readLastBuildRecord } from '../plan/lastBuild';
import { probeProjectStateAsync } from '../project/probe';
import { PROGRAM_PREFIX } from '../programName';
import { CommandError } from '../utils/errors';
import { openAppOnEasAsync } from './openAppEas';
import { easOpenPlatform, type DevOptions } from './resolveOptions';

/**
 * Open the app on this worktree's EAS session for a running Metro, and return the session id.
 * Null when the run opens nothing. Throws the refusal of the open.
 *
 * @param tunnelUrl the running Metro's current tunnel, or null when it has none.
 */
export async function reopenEasAsync(
  projectRoot: string,
  options: DevOptions,
  devServerUrl: string,
  tunnelUrl: string | null
): Promise<string | null> {
  const platform = easOpenPlatform(options);
  if (!platform) return null;
  if (!tunnelUrl) throw noTunnelError(platform);
  const state = await probeProjectStateAsync(projectRoot, {
    fingerprintCache: options.fingerprintCache,
  });
  const { plan } = await resolveStartPlanAsync(projectRoot, state, {
    platform,
    requestedPlatform: platform,
    open: true,
    requestedBackend: options.buildBackend,
    requestedTarget: options.runTarget,
    deviceBackend: 'eas',
    lastBuild: readLastBuildRecord(projectRoot),
    fingerprintCache: options.fingerprintCache,
  });
  const result = await openAppOnEasAsync(projectRoot, {
    platform,
    expoGo: plan.target === 'expo-go',
    devServerUrl,
    buildId: plan.easBuild?.id ?? null,
    fingerprintCache: options.fingerprintCache,
    keepSession: true,
  });
  if (result.refusal) throw result.refusal;
  if (!result.opened)
    throw new CommandError(
      'DEVICE_UNAVAILABLE',
      result.reason ?? 'The EAS app could not be opened.'
    );
  return result.sessionId;
}

/** A Metro with no tunnel cannot serve an EAS session, which runs off this machine. */
function noTunnelError(platform: 'ios' | 'android'): CommandError {
  const error = new CommandError(
    'DEVICE_UNAVAILABLE',
    [
      'The running dev server has no tunnel, so no EAS Simulator session was started or opened.',
      'Why: an EAS session runs on a machine in a datacenter, and it reaches the dev server only through a tunnel. This dev server advertises none.',
      `How: run "${PROGRAM_PREFIX} dev:stop", then "${PROGRAM_PREFIX} dev --${platform} --eas --detach".`,
    ].join('\n')
  );
  error.suggestedCommand = `${PROGRAM_PREFIX} dev:stop`;
  return error;
}
