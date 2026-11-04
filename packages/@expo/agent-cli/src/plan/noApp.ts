// @ref llp/0004-smart-start-and-project-state.rfc.md §Decision table
// The two states with no app to act on: no app here, or an app with nothing installed to read the
// facts from. Each plans nothing, and every reader of the plan says the same thing about it, so
// what each state says lives in one table.

import { PROGRAM_PREFIX } from '../programName';
import { INSTALL_DEPENDENCIES_COMMAND } from '../project/expoApp';
import type { AppState, ProjectState, StartPlan } from '../project/types';

export type NoAppRule = Exclude<AppState, 'ready'>;

interface NoAppState {
  /** The plan's reasons. */
  reasons: string[];
  /** The `next` of `status`: the one command that gives this directory an app to act on. */
  command: string;
  /** Why `next` names it. The one `status` follow-up says the same, as a sentence. */
  why: string;
  /** Said on the `status` project line. */
  label: string;
}

export const NO_APP: Record<NoAppRule, NoAppState> = {
  // @ref llp/0004-smart-start-and-project-state.rfc.md §Not an Expo app
  // Not a fact about how the app runs, but the fact that there is no app. Without it the table
  // read "no `expo` dependency" as "lacks a dev client" and planned `expo install expo-dev-client`
  // plus a native build for whatever repository the caller happened to be standing in.
  'not-expo-app': {
    reasons: [
      `This directory is not an Expo app: its package.json declares no "expo" dependency.`,
      `There is nothing here to get onto a device, so the plan is empty. The app is most likely one directory down, or "${PROGRAM_PREFIX} new my-app" would create one here.`,
    ],
    // The safe one of the three recoveries `NOT_EXPO_APP` spells out: creating an app changes
    // nothing that is already here, where adding Expo to this package would write into a repository
    // the caller most likely only walked past.
    command: `${PROGRAM_PREFIX} new my-app`,
    why: "this directory is not an Expo app, so there is nothing here to get onto a device — change to the app's own directory, or create one here",
    label: 'not an Expo app',
  },
  // @ref llp/0004-smart-start-and-project-state.rfc.md §Dependencies not installed
  // Every other row reads expo-dev-client and the fingerprint from node_modules, and would plan a
  // dev-client install and a first build for a project that may already declare and have both.
  'dependencies-not-installed': {
    reasons: [
      `This project's dependencies are not installed: its package.json declares "expo", and no installed expo resolves from it.`,
      `Every other fact of the plan is read from node_modules, so nothing is planned until "${INSTALL_DEPENDENCIES_COMMAND}" installs them.`,
    ],
    command: INSTALL_DEPENDENCIES_COMMAND,
    why: 'the dependencies are not installed, so every fact the plan reads from node_modules is missing — this installs them; run status again after it',
    label: 'dependencies not installed',
  },
};

/**
 * The empty plan of a directory with no app to act on, or null when the table decides.
 *
 * Above every row of the table, the web short-circuit included. Every command that would *act* on
 * the plan stops before reaching here; this is what the commands that only *describe* the
 * directory print, so the engine and the guard never disagree.
 */
export function planWithoutApp(state: ProjectState): StartPlan | null {
  const { app } = state;
  return app === 'ready'
    ? null
    : { target: 'none', rule: app, steps: [], reasons: NO_APP[app].reasons, buildLocation: null };
}
