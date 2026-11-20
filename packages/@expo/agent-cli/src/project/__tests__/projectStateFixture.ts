import type { ProjectState } from '../types';

/**
 * The one builder of a `ProjectState` fixture: a ready CNG app at `/project` that Expo Go can run.
 * Pass only the fields a test is about, so a new `ProjectState` field is a change to this file.
 */
export function makeProjectState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectRoot: '/project',
    app: 'ready',
    sdkVersion: '54.0.0',
    nativeDirs: { ios: false, android: false },
    usesDevClient: false,
    hasWeb: true,
    expoGo: { compatible: true, reasons: [] },
    fingerprint: { hash: 'abc123def4567890' },
    ...overrides,
  };
}

/** A managed project that cannot run in Expo Go, so its plan contains a development build. */
export function makeDevClientState(overrides: Partial<ProjectState> = {}): ProjectState {
  return makeProjectState({
    usesDevClient: true,
    expoGo: {
      compatible: false,
      reasons: [
        {
          kind: 'unbundled-native-module',
          packageName: 'react-native-mmkv',
          detail: 'react-native-mmkv is not bundled in Expo Go',
        },
      ],
    },
    ...overrides,
  });
}
