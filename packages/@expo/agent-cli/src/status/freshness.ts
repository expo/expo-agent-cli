import { refineWithChangedFilesAsync } from '../impact/fromRecord';
import type { OtaSafety } from '../impact/types';
import type { NativePlatform } from '../plan/types';
import type { StatusOptions } from './statusAsync';
import type { FreshnessImpact, FreshnessState, FreshnessStatus } from './types';

/**
 * Split "Fast Refresh picks it up" from "restart Metro", for platforms the fingerprint cleared.
 *
 * @ref llp/0011-impact-and-freshness.rfc.md §When the fingerprint did not move
 * Runs at most once, and only when *every* decided platform reported the native surface unchanged
 * — the same rule `impact` follows, and for the same reason: git has no per-platform answer, and a
 * platform whose fingerprint moved already has the stronger class. A `js-only` that this leaves
 * alone is a `js-only` the file list agreed with.
 */
export async function refineFreshnessAsync(
  projectRoot: string,
  freshness: FreshnessStatus,
  options: StatusOptions
): Promise<void> {
  const decided = freshness.platforms.filter((platform) => platform.impact?.class != null);
  if (
    !decided.length ||
    !decided.every((platform) => platform.impact!.fingerprintChanged === false)
  ) {
    return;
  }

  const refinement = await refineWithChangedFilesAsync(projectRoot, {
    timeoutMs: options.changedFilesTimeoutMs,
  });
  if (!refinement) {
    return;
  }

  freshness.changedFiles = refinement.counts;
  for (const platform of decided) {
    if (platform.impact!.class === 'js-only') {
      platform.impact!.class = refinement.class;
      platform.impact!.reason = refinement.reason;
    }
  }
}

/**
 * Compare the working tree against one EAS build, and make that the headline's base.
 *
 * @ref llp/0011-impact-and-freshness.rfc.md §The three comparisons
 * @ref llp/0021-honest-reports.rfc.md §The rules
 * `eas fingerprint:compare --build-id` takes **no platform**, because a build was made for exactly
 * one and which one is a fact about the build rather than a question to ask. That used to mean the
 * one answer was copied onto *every* platform, which reported an iOS simulator build as able to run
 * android code [observed — live run S1, 2026-08-26]. So the build's own platform is asked for,
 * and only that platform's headline is replaced; the others say they were not compared. The
 * `fresh`/`stale` states are left alone on all of them, because they are about the project's own
 * record and that question did not change.
 */
export async function compareAgainstEasBuildAsync(
  projectRoot: string,
  freshness: FreshnessStatus,
  options: StatusOptions
): Promise<void> {
  const { resolveEasCliOrThrow } = require('../utils/easCli') as typeof import('../utils/easCli');
  const { compareWithEasBuildAsync } =
    require('../impact/compare') as typeof import('../impact/compare');
  const { classifyFingerprintDiff } =
    require('../impact/classify') as typeof import('../impact/classify');
  const { lookUpBuildPlatformAsync } =
    require('../impact/buildCache') as typeof import('../impact/buildCache');

  const buildId = options.buildId!;
  // Before the call, so a comparison that fails still echoes the target the caller named. It used
  // to be written afterwards, so a failed `--build abc123` left `buildId: null` behind and the id
  // appeared nowhere in the report [observed — friction run 7, F66].
  freshness.comparison = {
    kind: 'eas-build',
    label: `EAS build ${buildId}`,
    buildId,
    platform: null,
  };

  const easCli = resolveEasCliOrThrow(projectRoot);
  // The caller's own `--platform` wins: they said which platform they mean, and no lookup overrules
  // a fact somebody stated. Otherwise EAS is asked, and a lookup that answers nothing leaves the
  // comparison attributed to no platform rather than to both.
  // `--platform web` is not one of the two an EAS build can be for, so it says nothing here.
  const named =
    options.platform === 'ios' || options.platform === 'android' ? options.platform : null;
  const [comparison, buildPlatform] = await Promise.all([
    compareWithEasBuildAsync(easCli, projectRoot, buildId),
    named ?? lookUpBuildPlatformAsync(easCli, projectRoot, buildId),
  ]);
  if (comparison.error) {
    throw new Error(comparison.error);
  }

  freshness.comparison.platform = buildPlatform;

  const classified = comparison.items ? classifyFingerprintDiff(comparison.items) : null;
  const impact: FreshnessImpact = {
    // The same rule as everywhere else in this report: a comparison that established nothing gets
    // `null`, not the conservative guess a gate would have to make (llp/0011 §The classifier reads reasons).
    class: classified?.class ?? (comparison.fingerprintChanged === false ? 'js-only' : null),
    fingerprintChanged: comparison.fingerprintChanged,
    reason:
      classified?.reasons[0] ??
      (comparison.fingerprintChanged === false
        ? `the native surface matches EAS build ${buildId}, so that build can run this code`
        : comparison.fingerprintChanged
          ? `the native surface differs from EAS build ${buildId}, and what differs could not be listed`
          : `whether the native surface differs from EAS build ${buildId} could not be established`),
    changedCount: classified?.changedSources.length ?? null,
    changedSources: classified ? classified.changedSources : null,
  };

  // The **eas** axis, and only it: "does this differ from that cloud build" is a question about
  // EAS, and the local axis answers "does it differ from what I built here" — which `--build` did
  // not ask and did not change (llp/0021 §The rules).
  for (const entry of freshness.platforms) {
    if (entry.backend !== 'eas') {
      continue;
    }
    const compared = entry.platform === buildPlatform;
    entry.impact = compared ? impact : notComparedImpact(buildId, buildPlatform, entry.platform);
    entry.buildId = compared ? buildId : null;
    entry.state = compared ? easBuildFreshness(comparison.fingerprintChanged) : 'unknown';
    entry.detail = compared
      ? comparison.fingerprintChanged === false
        ? `matches EAS build ${buildId}`
        : comparison.fingerprintChanged
          ? `differs from EAS build ${buildId}`
          : `EAS build ${buildId} could not be compared`
      : `not compared — ${buildId} is ${buildPlatform ?? 'a build of an unestablished platform'}`;
  }
}

/** The freshness state of an `eas` axis a named build was compared against. */
function easBuildFreshness(fingerprintChanged: boolean | null): FreshnessState {
  return fingerprintChanged === false ? 'fresh' : fingerprintChanged ? 'stale' : 'unknown';
}

/**
 * The headline of a platform the `--build` comparison was not about.
 *
 * A stated non-answer rather than a copied one. `class: null` is what the rest of this report uses
 * for "nothing was established", and `--assert` already exits 22 on it instead of gating on a guess
 * (llp/0011 §The classifier reads reasons).
 */
function notComparedImpact(
  buildId: string,
  buildPlatform: 'ios' | 'android' | null,
  platform: NativePlatform
): FreshnessImpact {
  return {
    class: null,
    fingerprintChanged: null,
    reason:
      buildPlatform == null
        ? `not compared — the comparison was against EAS build ${buildId}, and which platform that build was made for could not be established, so nothing here is an answer about ${platform}`
        : `not compared — EAS build ${buildId} is an ${buildPlatform} build, and one build is one platform`,
    changedCount: null,
    changedSources: null,
  };
}

/**
 * Whether an update published now would reach installed builds that can run it.
 *
 * @ref llp/0011-impact-and-freshness.rfc.md §A fingerprint change is not "OTA-unsafe"
 * Deliberately not derived from the impact class: a fingerprint change answers "does the native
 * binary differ", and OTA safety is a `runtimeVersion` question. The two coincide only under
 * `policy: "fingerprint"`.
 */
export async function resolveOtaSafetyAsync(
  projectRoot: string,
  freshness: FreshnessStatus
): Promise<OtaSafety> {
  const { resolveRuntimeVersionAsync, resolveOtaSafety } =
    require('../impact/runtimeVersion') as typeof import('../impact/runtimeVersion');
  const runtimeVersion = await resolveRuntimeVersionAsync(projectRoot);
  // The strongest answer across the platforms, the way `impact` folds them: one platform whose
  // native surface moved is enough to decide the question for an update published now.
  const changed = freshness.platforms.reduce<boolean | null>(
    (strongest, platform) =>
      platform.impact?.fingerprintChanged === true
        ? true
        : strongest === null && platform.impact?.fingerprintChanged === false
          ? false
          : strongest,
    null
  );
  return resolveOtaSafety(runtimeVersion, changed);
}
