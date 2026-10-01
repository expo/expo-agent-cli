import os from 'os';
import path from 'path';

/**
 * The directory the Expo CLI family keeps its machine state in, usually `~/.expo`.
 *
 * The same three rules the family uses, in the same order [observed — `@expo/cli`
 * `api/user/UserSettings.ts` `getExpoHomeDirectory`, and eas-cli resolves the same directory]:
 * `__UNSAFE_EXPO_HOME_DIRECTORY` wins, then `EXPO_STAGING`, then `EXPO_LOCAL`.
 */
export function expoHomeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const home = os.homedir();
  if (env.__UNSAFE_EXPO_HOME_DIRECTORY) {
    return env.__UNSAFE_EXPO_HOME_DIRECTORY;
  }
  if (isTruthy(env.EXPO_STAGING)) {
    return path.join(home, '.expo-staging');
  }
  if (isTruthy(env.EXPO_LOCAL)) {
    return path.join(home, '.expo-local');
  }
  return path.join(home, '.expo');
}

/** How the Expo family reads a boolean environment variable [`boolish`, @expo/cli]. */
function isTruthy(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}
