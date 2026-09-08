// @ref llp/0027-everything-on-eas.rfc.md §Reuse
// Whether EAS already has the build a `dev --eas` plan would make.
//
// A session installs a build by id, so a finished simulator build of this exact fingerprint is a
// build the run does not have to make — and a native build is the fifteen minutes everything else in
// this command is measured against. `eas build:dev` asks the same question the same way
// [observed — eas-cli 23.2 `commands/build/dev.ts`]: the per-platform fingerprint, the profile,
// `status: finished`.
//
// Never throws, and every way of not getting an answer is `null`: a lookup that could not run is a
// plan that builds, which is the plan it would have been before anyone asked.

import { lookUpCachedBuildAsync } from '../impact/buildCache';
import { generateFingerprintAsync } from '../project/fingerprint';
import { EAS_SIMULATOR_PROFILE } from '../toolchain/runsOn';
import { resolveEasCli } from '../utils/easCli';
import type { NativePlatform, PlanEasBuild } from './types';

export interface EasBuildLookupOptions {
  /** Whether the per-platform fingerprint may come out of the project's `.expo` record. */
  fingerprintCache?: boolean;
  timeoutMs?: number;
}

/**
 * A finished `development-simulator` build of this platform's current fingerprint, or null.
 *
 * Two subprocesses, in this order because the second needs the first's answer: the fingerprint of
 * this one platform (an EAS build carries a per-platform hash, so the project hash the probe already
 * has cannot be handed to the lookup), then `eas build:list` filtered to it.
 */
export async function lookUpEasSimulatorBuildAsync(
  projectRoot: string,
  platform: NativePlatform,
  { fingerprintCache, timeoutMs }: EasBuildLookupOptions = {}
): Promise<PlanEasBuild | null> {
  const fingerprint = await generateFingerprintAsync(projectRoot, {
    platform,
    cache: fingerprintCache,
  });
  if (!fingerprint.hash) {
    return null;
  }
  const outcome = await lookUpCachedBuildAsync(
    resolveEasCli(projectRoot),
    projectRoot,
    platform,
    fingerprint.hash,
    { profile: EAS_SIMULATOR_PROFILE, ...(timeoutMs == null ? {} : { timeoutMs }) }
  );
  if (outcome.state !== 'found' || !outcome.build.id) {
    return null;
  }
  return { id: outcome.build.id, profile: outcome.build.buildProfile ?? EAS_SIMULATOR_PROFILE };
}
