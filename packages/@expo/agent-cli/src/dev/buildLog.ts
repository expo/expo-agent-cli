// @ref llp/0012-build-explain.rfc.md §What ships, and what is reserved
// Where the output of the last native build `@expo/agent-cli dev` ran is kept, per platform.
//
// `expo run:ios` and `expo run:android` print thousands of lines and exit, and the one that says
// why a build failed is somewhere in them. `inspect:build-log --local --ios` is how an agent reads
// that line afterwards without having captured the run itself — so the run captures it: every
// byte the step printed, in the order it arrived, into one file per platform under
// `.expo/dev/logs/`, truncated on each build. One file per platform and not per run, because the
// question is always about the *last* build, and a log that accumulated across runs would answer
// it with a build from last week.
//
// Written only when the output passes through this process — `tee` and `capture`, which is every
// run without a terminal watching it, a detached run included. An interactive run hands the
// terminal to the tool (`inherit`) and nothing passes through here, so no file is written; the
// person watching saw the build, and `inspect:build-log --local` says where the log would have been.

import path from 'path';

import type { NativePlatform } from '../plan/types';

/** Directory of the per-run logs, as `.expo`'s own README describes it. */
const DEV_LOGS_DIR = path.join('.expo', 'dev', 'logs');

/** Where the last native build of one platform wrote its output. */
export function buildLogPath(projectRoot: string, platform: NativePlatform): string {
  return path.join(projectRoot, DEV_LOGS_DIR, `build-${platform}.log`);
}

/** The platform an `expo run:*` step builds for, or null for any other step. */
export function buildStepPlatform(args: string[]): NativePlatform | null {
  switch (args[0]) {
    case 'run:ios':
      return 'ios';
    case 'run:android':
      return 'android';
    default:
      return null;
  }
}
