// @ref llp/0011-impact-and-freshness.rfc.md §A fingerprint change is not "OTA-unsafe"
// Whether an update published now would reach builds that can run it.
//
// This is the one part of `impact` that must not be derived from the class. A fingerprint answers
// "does the native binary differ"; OTA safety is a `runtimeVersion` question, and the two coincide
// under exactly one policy. Under `appVersion`, `sdkVersion` or a literal string, adding a native
// module leaves the runtimeVersion where it was — so an update published now reaches installed
// builds that cannot run it, and the app crashes on a module that is not there.

import { readStaticExpoConfigAsync } from '../project/appConfig';
import { readEvaluatedAppConfigAsync } from '../project/evaluatedAppConfig';
import type { OtaSafety, RuntimeVersionInfo } from './types';

export { parseLastJsonObject } from '../project/evaluatedAppConfig';

/** The policies `runtimeVersion` accepts as `{ "policy": "..." }` [observed — expo config schema]. */
const KNOWN_POLICIES = ['fingerprint', 'appVersion', 'sdkVersion', 'nativeVersion'];

/**
 * Resolve the project's `runtimeVersion` from the config the app sees. A static config is read as a
 * file; a dynamic one is evaluated by `expo config` (llp/0001 §Constraints item 5).
 *
 * `source: null` means nothing answered, which is not "no runtimeVersion".
 */
export async function resolveRuntimeVersionAsync(
  projectRoot: string,
  { cache }: { cache?: boolean } = {}
): Promise<RuntimeVersionInfo> {
  const staticConfig = await readStaticExpoConfigAsync(projectRoot);
  if (staticConfig.source && staticConfig.config && !staticConfig.dynamic) {
    return readRuntimeVersion(staticConfig.config.runtimeVersion, staticConfig.source);
  }
  // No app config at all: spawning `expo config` here can mean `npx expo` fetching a package.
  if (!staticConfig.source && !staticConfig.dynamic) {
    return { policy: null, literal: null, source: null };
  }

  const evaluated = await readEvaluatedAppConfigAsync(projectRoot, { cache });
  if (evaluated) {
    return {
      ...readRuntimeVersion(evaluated.config.runtimeVersion, evaluated.source),
      cache: evaluated.cache,
    };
  }

  if (!staticConfig.source || !staticConfig.config) {
    return { policy: null, literal: null, source: null };
  }
  return readRuntimeVersion(staticConfig.config.runtimeVersion, staticConfig.source);
}

/**
 * Read one `runtimeVersion` value, in either spelling.
 *
 * A string is a literal, and `{ policy: "..." }` is a policy. A policy this CLI has never heard of
 * is reported under `policy` verbatim rather than dropped: a new policy is a thing that exists,
 * and the safety verdict for it is `null`, not `false`.
 */
export function readRuntimeVersion(value: unknown, source: string): RuntimeVersionInfo {
  if (typeof value === 'string' && value) {
    return { policy: null, literal: value, source };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const policy = (value as { policy?: unknown }).policy;
    if (typeof policy === 'string' && policy) {
      return { policy, literal: null, source };
    }
  }
  // The config was read and named no runtimeVersion. That is a real answer — the project has no
  // runtime version configured — and it is reported with the source that said so.
  return { policy: null, literal: null, source };
}

/**
 * Whether an update published now is safe, from the policy and nothing else.
 *
 * The four answers, and why each is what it is:
 *
 * - **`fingerprint`** — the runtimeVersion *is* the fingerprint, so a native change moves it and
 *   the update is served only to builds made from the new fingerprint. Safe either way: unchanged
 *   means the installed builds match, changed means they will not be offered it.
 * - **Every other policy, with the fingerprint changed** — `appVersion`, `sdkVersion`,
 *   `nativeVersion` and a literal all keep the same runtimeVersion across a native change, so the
 *   update reaches builds that lack the new native code. Not safe.
 * - **Every other policy, with the fingerprint unchanged** — the native surface is the same, so
 *   the installed builds can run the new bundle. Safe.
 * - **Nothing resolved** — `null`. A report that cannot see the policy has not established that
 *   an update is safe, and saying `false` would be as much of an invention as saying `true`.
 *
 * @param fingerprintChanged the strongest answer across the platforms asked about; `null` when it
 *   could not be decided, which makes the verdict `null` for every policy but `fingerprint`.
 */
export function resolveOtaSafety(
  runtimeVersion: RuntimeVersionInfo,
  fingerprintChanged: boolean | null
): OtaSafety {
  const { policy, literal, source } = runtimeVersion;

  if (policy === 'fingerprint') {
    return {
      safe: true,
      runtimeVersion,
      why: `The runtimeVersion policy is "fingerprint", so the runtime version moves with the native surface: an update published now is only offered to builds made from the same fingerprint. EAS Update will not serve it to a build that cannot run it.`,
    };
  }

  if (!source || (policy == null && literal == null)) {
    return {
      safe: null,
      runtimeVersion,
      why: source
        ? `${source} names no runtimeVersion, so which builds an update would reach cannot be decided here. Configure runtimeVersion before publishing an update, or check the channel on expo.dev.`
        : `The runtimeVersion could not be resolved — neither "expo config --type public" nor a static app config answered — so whether an update published now is safe is unknown. It is not reported as safe on a guess.`,
    };
  }

  const name = policy ? `"${policy}"` : `the literal "${literal}"`;
  const unknownPolicy = policy != null && !KNOWN_POLICIES.includes(policy);

  if (fingerprintChanged == null) {
    return {
      safe: null,
      runtimeVersion,
      why: `The runtimeVersion policy is ${name}, which does not track the native surface, and whether the native surface changed could not be decided — so whether an update published now would reach builds that cannot run it is unknown.`,
    };
  }

  if (unknownPolicy) {
    return {
      safe: null,
      runtimeVersion,
      why: `The runtimeVersion policy is ${name}, which this CLI does not know. Whether it tracks the native surface decides the answer, so nothing is claimed about it.`,
    };
  }

  if (fingerprintChanged) {
    return {
      safe: false,
      runtimeVersion,
      why: `The native surface changed, but the runtimeVersion policy is ${name}, which does not move with it. An update published now would keep the same runtime version and reach installed builds that do not have the new native code, where it would crash. Ship a new build first, or switch the policy to "fingerprint".`,
    };
  }

  return {
    safe: true,
    runtimeVersion,
    why: `The native surface is unchanged, so the installed builds can run this bundle. The runtimeVersion policy is ${name}, which is unaffected either way.`,
  };
}
