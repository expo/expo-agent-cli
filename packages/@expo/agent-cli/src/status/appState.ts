// @ref llp/0004-smart-start-and-project-state.rfc.md §Dependencies not installed
// The probe's one app-state value, and the two `status --json` project fields that carry it.

import type { AppState } from '../project/types';
import type { ProjectAppFields } from './types';

export function appStateFields(app: AppState): ProjectAppFields {
  return app === 'not-expo-app'
    ? { isExpoApp: false, dependenciesInstalled: null }
    : { isExpoApp: true, dependenciesInstalled: app === 'ready' };
}

/** The {@link AppState} that {@link appStateFields} wrote. */
export function appStateOf(fields: ProjectAppFields): AppState {
  if (!fields.isExpoApp) {
    return 'not-expo-app';
  }
  return fields.dependenciesInstalled ? 'ready' : 'dependencies-not-installed';
}
