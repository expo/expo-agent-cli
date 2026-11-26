import { PROGRAM_PREFIX } from '../programName';
import { isMissingPluginError } from '../runtime/bundleCheck';
import type { SmokeFollowUpInput } from './smoke';
import type { FollowUp } from './types';

export function brokenBundleFollowUps(
  { manifestError, bundleFile }: Pick<SmokeFollowUpInput, 'manifestError' | 'bundleFile'>,
  retryCommand: string
): FollowUp[] {
  if (manifestError) {
    const advice = isMissingPluginError(manifestError)
      ? 'Check the plugin entry in the app config. For a package, make sure it is installed. For a local file, check that its path exists.'
      : 'Fix the error reported by the dev server while generating the manifest.';
    return [
      {
        id: 'smoke-again',
        command: retryCommand,
        why: `${manifestError.message} — ${advice} Then run smoke again.`,
      },
    ];
  }
  return [
    {
      id: 'typecheck',
      command: `${PROGRAM_PREFIX} typecheck`,
      why: `The entry bundle does not compile${bundleFile ? ` (${bundleFile})` : ''}, and the compiler reports every error in the project rather than only the one the bundler stopped on.`,
    },
    {
      id: 'smoke-again',
      command: retryCommand,
      why: 'The dev server reads the project again on the next request, so this is the gate to run again after the fix.',
    },
  ];
}
