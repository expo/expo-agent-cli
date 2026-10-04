import { homedir } from 'node:os';
import path from 'node:path';

import { env } from './env';

/** Resolve Expo's shared settings directory without creating or modifying it. */
export function getExpoHomeDirectory(): string {
  return (
    process.env.__UNSAFE_EXPO_HOME_DIRECTORY ||
    path.join(
      homedir(),
      env.EXPO_STAGING ? '.expo-staging' : env.EXPO_LOCAL ? '.expo-local' : '.expo'
    )
  );
}
