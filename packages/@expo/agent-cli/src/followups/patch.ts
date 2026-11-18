// @ref llp/0037-patch-command.rfc.md §Impact and follow-ups

import { PROGRAM_PREFIX } from '../programName';
import { capFollowUps, type FollowUp } from './types';

export interface PatchFollowUpInput {
  packageName: string;
  /** The patch changes native files. */
  native: boolean;
}

/** What to do after a patch was saved: rebuild or reload. */
export function buildPatchFollowUps({ packageName, native }: PatchFollowUpInput): FollowUp[] {
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
      why: `The patch changes JavaScript only, so reloading the app is enough to pick it up.`,
    });
  }
  return capFollowUps(followups);
}
