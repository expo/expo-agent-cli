import { PROGRAM_PREFIX } from '../programName';
import type { BundleCheckError } from '../runtime/bundleCheck';
import { manifestRepairAdvice } from '../runtime/manifestFailure';
import type { FollowUp } from './types';

export function brokenBundleFollowUps(
  error: BundleCheckError | null,
  retryCommand: string
): FollowUp[] {
  if (error?.source === 'manifest') {
    return [
      {
        id: 'smoke-again',
        command: retryCommand,
        why: `${manifestRepairAdvice(error)} Then run smoke again.`,
      },
    ];
  }
  const bundleFile = error?.filename;
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
