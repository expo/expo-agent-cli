// @ref llp/0037-patch-command.rfc.md §Impact and follow-ups

import { PROGRAM_PREFIX } from '../programName';
import { capFollowUps, type FollowUp } from './types';

export interface PatchFollowUpInput {
  packageName: string;
  /** The patch changes native files, from the diff. */
  native: boolean;
  /**
   * The patch file is under `patches/`, which `@expo/fingerprint` hashes as one source
   * (`patchPackage`), so `status` reports a native change for any patch there, JavaScript or not.
   */
  hashedByFingerprint: boolean;
}

/**
 * What to do after a patch was saved: rebuild or reload. The diff decides, not the fingerprint: the
 * fingerprint moves for every patch under `patches/`.
 */
export function buildPatchFollowUps({
  packageName,
  native,
  hashedByFingerprint,
}: PatchFollowUpInput): FollowUp[] {
  const followups: FollowUp[] = [];
  if (native) {
    followups.push({
      id: 'dev',
      command: `${PROGRAM_PREFIX} dev`,
      why: `The patch changes native code of ${packageName}, and the app that runs now was built without it: this plans and makes the development build that has it. Expo Go cannot load a patched native module.`,
    });
  } else {
    followups.push({
      id: 'reload-app',
      command: `${PROGRAM_PREFIX} runtime:reload`,
      why: `The patch changes JavaScript only, so reloading the app is enough to pick it up.${
        hashedByFingerprint
          ? ' "status" can still report a native fingerprint change, because the fingerprint hashes every file in patches/; the diff has no native file, so no new build is needed.'
          : ''
      }`,
    });
  }
  return capFollowUps(followups);
}
