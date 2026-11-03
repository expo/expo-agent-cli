// @ref llp/0004-smart-start-and-project-state.rfc.md §Decision table
// The two rows above the table: no app to plan for, or no installed app to read the facts from.
// Both plan nothing, so no row below can plan an install or a build here.

import { PROGRAM_PREFIX } from '../programName';
import { INSTALL_DEPENDENCIES_COMMAND } from '../project/dependencies';
import type { ProjectState, StartPlan } from '../project/types';
import type { StartPlanRule } from './types';

/** The empty plan of a directory with no app to act on, or null when the table decides. */
export function planWithoutApp(state: ProjectState): StartPlan | null {
  // @ref llp/0004-smart-start-and-project-state.rfc.md §Not an Expo app
  // The first row, above the web short-circuit, because it is not a fact about how the app runs —
  // it is the fact that there is no app. Without it the table read "no `expo` dependency" as "lacks
  // a dev client" and planned `expo install expo-dev-client` plus a native build for whatever
  // repository the caller happened to be standing in. Every command that would *act* on the plan
  // stops before reaching here; this row is what the commands that only *describe* the directory
  // print, so the engine and the guard never disagree.
  if (!state.isExpoApp) {
    return emptyPlan('not-expo-app', [
      `This directory is not an Expo app: its package.json declares no "expo" dependency.`,
      `There is nothing here to get onto a device, so the plan is empty. The app is most likely one directory down, or "${PROGRAM_PREFIX} new my-app" would create one here.`,
    ]);
  }
  // @ref llp/0004-smart-start-and-project-state.rfc.md §Dependencies not installed
  // `sdkVersion` is read from the installed `expo`, so null means node_modules has none. The rows
  // below read expo-dev-client and the fingerprint from there too, and would plan a dev-client
  // install and a first build for a project that may already declare and have both.
  if (state.sdkVersion == null) {
    return emptyPlan('dependencies-not-installed', [
      `This project's dependencies are not installed: its package.json declares "expo", and no installed expo resolves from it.`,
      `Every other fact of the plan is read from node_modules, so nothing is planned until "${INSTALL_DEPENDENCIES_COMMAND}" installs the lockfile.`,
    ]);
  }
  return null;
}

function emptyPlan(rule: StartPlanRule, reasons: string[]): StartPlan {
  return { target: 'none', rule, steps: [], reasons, buildLocation: null };
}
