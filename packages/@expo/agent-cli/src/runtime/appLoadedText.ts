// @ref llp/0005-runtime-loop-tools.rfc.md §A loaded app
// One text for each command that reports an attached app that ran no bundle.

import type { NavigatePlatform } from '../navigate/device';
import { PROGRAM_PREFIX } from '../programName';

/** The two states that the answer "no bundle ran" covers. */
export const NO_BUNDLE_STATES = 'the app is still loading the bundle, or the load failed';

/** The end of a `Why:` line for an attached app that ran no bundle. */
export const NO_BUNDLE_WHY = `Either ${NO_BUNDLE_STATES}. The debugger cannot tell which; the screen can: a loading banner, or a red error screen.`;

/** The flags that keep a suggested command on the device of this run. */
export function deviceFlags({
  platform,
  cloud,
}: {
  platform?: NavigatePlatform;
  cloud: boolean;
}): string {
  return `${platform == null ? '' : ` --${platform}`}${cloud ? ' --eas' : ''}`;
}

/** The end of a `How:` line for an attached app that ran no bundle. `flags` is {@link deviceFlags}. */
export function noBundleRemedy(flags: string): string {
  return `If the screen is red, "${PROGRAM_PREFIX} runtime:reload${flags}" makes the app request the bundle again. "${PROGRAM_PREFIX} dev:logs" shows what the dev server built.`;
}

/** The stderr line of a command that reads a runtime in which no bundle ran. */
export function emptyRuntimeWarning(devServerUrl: string): string {
  return `The app connected to ${devServerUrl} ran no JavaScript bundle, so this runtime has none of the app's code or globals. ${NO_BUNDLE_WHY}`;
}
