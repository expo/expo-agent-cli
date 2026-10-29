// @ref llp/0001-agentic-cli-on-expo-cli.rfc.md §Constraints
// The config the app itself sees: a dynamic `app.config.js`/`.ts` evaluated with `@expo/config`
// after the project's env files are loaded, which is what `expo config` and `@expo/fingerprint`
// do (expo/expo#48839). `getConfig` on its own never reads `.env` files.
import { getConfig, getConfigFilePaths, type ExpoConfig } from '@expo/config';
import { loadProjectEnv } from '@expo/env';

import { captureDeclaredPlugins } from './declaredPlugins';

const scope = globalThis as { __DEV__?: boolean };

export type EvaluatedExpoConfig = { ok: true; exp: ExpoConfig } | { ok: false; error: string };

/**
 * Evaluate the project's config the way `expo start` serves it: the `development` env files, the
 * public config, and no config plugin run, so a plugin that is not installed does not fail the read.
 *
 * The project's env files are loaded into this process for the evaluation and taken out again
 * after it, so a later subprocess inherits the environment this CLI was started with. Project code
 * runs here, so its writes to stdout go to stderr for the duration: a `--json` run owns stdout.
 *
 * `ok: false` is an answer about the evaluation, never about the config: a config that throws has
 * not said what it is.
 */
export function evaluateExpoConfig(projectRoot: string): EvaluatedExpoConfig {
  const env = { ...process.env };
  const dev = '__DEV__' in scope ? { value: scope.__DEV__ } : null;
  const stdoutWrite = process.stdout.write;
  let release: (() => void) | null = null;
  try {
    // `expo config` sets `__DEV__` from the mode as well, and a config may read it.
    scope.__DEV__ = true;
    loadProjectEnv(projectRoot, { mode: 'development', silent: true, force: true });
    process.stdout.write = ((chunk: any, ...rest: any[]) =>
      (process.stderr.write as any)(chunk, ...rest)) as typeof process.stdout.write;
    const { dynamicConfigPath } = getConfigFilePaths(projectRoot);
    const capture = dynamicConfigPath ? captureDeclaredPlugins(dynamicConfigPath) : null;
    release = capture?.release ?? null;
    const config = getConfig(projectRoot, {
      skipSDKVersionRequirement: true,
      isPublicConfig: true,
      skipPlugins: true,
    });
    if (capture) {
      const declared = capture.declared();
      if (declared == null) {
        return { ok: false, error: 'the plugins it returns could not be read' };
      }
      if (Array.isArray(declared.plugins)) {
        config.exp.plugins = declared.plugins;
      }
    }
    return { ok: true, exp: config.exp };
  } catch (error: unknown) {
    return { ok: false, error: reasonOf(error instanceof Error ? error.message : String(error)) };
  } finally {
    release?.();
    process.stdout.write = stdoutWrite;
    if (dev) {
      scope.__DEV__ = dev.value;
    } else {
      delete scope.__DEV__;
    }
    restoreEnv(env);
  }
}

/** Put `process.env` back to `env`: keys the evaluation added go, and changed values come back. */
function restoreEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in env)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] !== value) {
      process.env[key] = value;
    }
  }
}

// `getConfig` puts an `Error reading Expo config at <path>:` header above what the config threw.
function reasonOf(message: string): string {
  const lines = message.split('\n').filter((line) => line.trim());
  const reason = lines[0]?.startsWith('Error reading Expo config at ') ? lines[1] : lines[0];
  return reason ?? message;
}
