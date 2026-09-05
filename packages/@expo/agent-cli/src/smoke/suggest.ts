// @ref llp/0005-runtime-loop-tools.rfc.md §Which platform is the caller's to say
//
// `smoke` requires `--ios` or `--android` now (`./resolveOptions.ts`), so any next action that
// names a bare `smoke` prints a command that exits 1 when a reader runs it — F151. The first sweep
// caught the report surfaces; it missed the ones that state a platform from the project rather than
// from a device. This is the one place the rule lives, so the next such site imports it instead of
// copying it.

import { readProjectNativeDirsAsync } from '../project/nativeCode';
import type { NativePlatform, PlanPlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';

/** The `smoke` command for a platform, always with the flag it now requires. */
export function smokeCommand(platform: NativePlatform): string {
  return `${PROGRAM_PREFIX} smoke --${platform}`;
}

/** The `dev` command for a platform, always with the flag it requires too. */
export function devCommand(platform: PlanPlatform, flags?: string): string {
  return `${PROGRAM_PREFIX} dev --${platform}${flags ? ` ${flags}` : ''}`;
}

/** A platform another part of the run already settled, or null for `web`/nothing. */
export function statedSmokePlatform(value: PlanPlatform | null | undefined): NativePlatform | null {
  return value === 'ios' || value === 'android' ? value : null;
}

/**
 * The platform to name when nothing else did.
 *
 * A single checked-in native directory is the project's own answer. Otherwise only macOS can build
 * for iOS. This is the rule `status` still defaults to, and the one `dev` used before its platform
 * flag became required — so a stated suggestion and a `status` report agree.
 */
export function defaultSmokePlatform(nativeDirs: {
  ios: boolean;
  android: boolean;
}): NativePlatform {
  if (nativeDirs.ios !== nativeDirs.android) {
    return nativeDirs.ios ? 'ios' : 'android';
  }
  return hostPlatform();
}

/**
 * The platform to state when nothing at hand names one: the host's own.
 *
 * For a suggestion only, never for a run — a stated platform is text the caller reads and can
 * change, where a default inside a command would be an invisible guess.
 */
export function hostPlatform(): NativePlatform {
  return process.platform === 'darwin' ? 'ios' : 'android';
}

/** {@link defaultSmokePlatform}, reading the native dirs off disk — two `stat`s on a CNG project. */
export async function defaultSmokePlatformAsync(projectRoot: string): Promise<NativePlatform> {
  return defaultSmokePlatform(await readProjectNativeDirsAsync(projectRoot));
}
