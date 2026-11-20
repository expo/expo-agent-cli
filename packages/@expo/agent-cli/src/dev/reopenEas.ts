// @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions — an existing Metro can get a fresh session.
import { resolveStartPlanAsync } from '../plan/resolveAsync';
import { readLastBuildRecord } from '../plan/lastBuild';
import { probeProjectStateAsync } from '../project/probe';
import { PROGRAM_PREFIX } from '../programName';
import { CommandError } from '../utils/errors';
import { openAppOnEasAsync } from './openAppEas';
import { easOpenPlatform, type DevOptions } from './resolveOptions';

/** The session a reopen used, and the targets that the open replaces. */
export interface EasReopen {
  sessionId: string | null;
  /**
   * Targets listed right before the open, when the open reloads the app. A development build gets
   * the launcher URL, which loads the app again. Expo Go gets its route link, which only moves an
   * app that is already loaded: its target stays, so none is stale.
   */
  staleTargetIds: string[];
}

/**
 * Open the app on this worktree's EAS session for a running Metro. Null when the run opens
 * nothing. Throws the refusal of the open.
 *
 * @param tunnelUrl the running Metro's current tunnel, or null when it has none.
 */
export async function reopenEasAsync(
  projectRoot: string,
  options: DevOptions,
  devServerUrl: string,
  tunnelUrl: string | null
): Promise<EasReopen | null> {
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
  const expoGo = plan.target === 'expo-go';
  const result = await openAppOnEasAsync(projectRoot, {
    platform,
    expoGo,
    devServerUrl,
    buildId: plan.easBuild?.id ?? null,
    fingerprintCache: options.fingerprintCache,
    keepSession: true,
    readStaleTargets: options.waitReady,
  });
  if (result.refusal) throw result.refusal;
  if (!result.opened) throw reopenFailedError(platform, result.sessionId, result.reason);
  return {
    sessionId: result.sessionId,
    staleTargetIds: expoGo ? [] : (result.targetsBeforeOpen ?? []),
  };
}

function reopenFailedError(
  platform: 'ios' | 'android',
  sessionId: string | null,
  reason: string | null
): CommandError {
  const retry = `${PROGRAM_PREFIX} dev --${platform} --eas --detach`;
  const error = new CommandError(
    'DEVICE_UNAVAILABLE',
    [
      `The app was not opened on EAS Simulator session ${sessionId ?? '(id unknown)'}: ${reason ?? 'no reason was given'}.`,
      `How: run "${retry}" again. If it fails again, read "${PROGRAM_PREFIX} dev:logs".`,
    ].join('\n')
  );
  error.suggestedCommand = retry;
  return error;
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
