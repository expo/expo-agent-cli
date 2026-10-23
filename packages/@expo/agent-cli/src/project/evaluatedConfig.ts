// @ref llp/0001-agentic-cli-on-expo-cli.rfc.md §Constraints
// The config the app itself sees: a dynamic `app.config.js`/`.ts` evaluated with `@expo/config`
// after the project's env files are loaded, which is what `expo config` and `@expo/fingerprint`
// do (expo/expo#48839). `getConfig` on its own never reads `.env` files.
import { getConfig, type ExpoConfig } from '@expo/config';
import { loadProjectEnv } from '@expo/env';
import path from 'path';

/**
 * The mode the env files are read in, which decides which `.env.*` files apply.
 *
 * `development` is what `expo start` serves, so the dev loop (`dev`, `navigate`, `runtime:*`)
 * reads the config the running app sees. `production` is what a release build and `deploy` see.
 */
export type ConfigEnvMode = 'development' | 'production';

export type EvaluatedExpoConfig =
  | {
      ok: true;
      exp: ExpoConfig;
      /** Name of the static config file, relative to the project root, if any. */
      staticConfigFile: string | null;
      /** Name of the dynamic config file, relative to the project root, if any. */
      dynamicConfigFile: string | null;
    }
  | { ok: false; error: string };

export interface EvaluateExpoConfigOptions {
  /** Which env files the config is evaluated with. Every caller says which build it is about. */
  mode: ConfigEnvMode;
  /** Drop the private keys, the way `expo config --type public` does. */
  isPublicConfig?: boolean;
  /** Evaluate the config without running its config plugins. */
  skipPlugins?: boolean;
}

/**
 * Evaluate the project's config the way the app and `expo config` see it.
 *
 * The project's env files are loaded into this process for the evaluation and taken out again
 * after it, so a later subprocess inherits the environment this CLI was started with. Project code
 * runs here, so its writes to stdout go to stderr for the duration: a `--json` run owns stdout.
 *
 * `ok: false` is an answer about the evaluation, never about the config: a config that throws has
 * not said what it is.
 */
export function evaluateExpoConfig(
  projectRoot: string,
  { mode, isPublicConfig, skipPlugins }: EvaluateExpoConfigOptions
): EvaluatedExpoConfig {
  const env = { ...process.env };
  const stdoutWrite = process.stdout.write;
  try {
    loadProjectEnv(projectRoot, { mode, silent: true, force: true });
    process.stdout.write = ((chunk: any, ...rest: any[]) =>
      (process.stderr.write as any)(chunk, ...rest)) as typeof process.stdout.write;
    const config = getConfig(projectRoot, {
      skipSDKVersionRequirement: true,
      isPublicConfig,
      skipPlugins,
    });
    return {
      ok: true,
      exp: config.exp,
      staticConfigFile: relativeTo(projectRoot, config.staticConfigPath),
      dynamicConfigFile: relativeTo(projectRoot, config.dynamicConfigPath),
    };
  } catch (error: unknown) {
    return { ok: false, error: firstLine(error instanceof Error ? error.message : String(error)) };
  } finally {
    process.stdout.write = stdoutWrite;
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

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim()) ?? text;
}

function relativeTo(projectRoot: string, file: string | null): string | null {
  return file ? path.relative(projectRoot, file) || path.basename(file) : null;
}
