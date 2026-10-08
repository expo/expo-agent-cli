// @ref llp/0034-eas-session-binding.plan.md §PR 5 — an existing Metro can get a fresh session.
import { resolveStartPlanAsync } from '../plan/resolveAsync';
import { readLastBuildRecord } from '../plan/lastBuild';
import { probeProjectStateAsync } from '../project/probe';
import { CommandError } from '../utils/errors';
import { openAppOnEasAsync } from './openAppEas';
import type { DevOptions } from './resolveOptions';

export async function reopenEasAsync(
  projectRoot: string,
  options: DevOptions,
  devServerUrl: string
) {
  if (!options.open || (options.platform !== 'ios' && options.platform !== 'android')) return;
  const state = await probeProjectStateAsync(projectRoot, {
    fingerprintCache: options.fingerprintCache,
  });
  const { plan } = await resolveStartPlanAsync(projectRoot, state, {
    platform: options.platform,
    requestedPlatform: options.platform,
    open: true,
    requestedBackend: options.buildBackend,
    requestedTarget: options.runTarget,
    deviceBackend: 'eas',
    lastBuild: readLastBuildRecord(projectRoot),
    fingerprintCache: options.fingerprintCache,
  });
  const result = await openAppOnEasAsync(projectRoot, {
    platform: options.platform,
    expoGo: plan.target === 'expo-go',
    devServerUrl,
    buildId: plan.easBuild?.id ?? null,
  });
  if (!result.opened)
    throw new CommandError(
      'DEVICE_UNAVAILABLE',
      result.reason ?? 'The EAS app could not be opened.'
    );
}
