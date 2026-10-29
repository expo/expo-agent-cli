// @ref llp/0001-agentic-cli-on-expo-cli.rfc.md §Constraints
// The config the app itself sees: a dynamic `app.config.js`/`.ts` evaluated with `@expo/config`
// after the project's env files are loaded, which is what `expo config` and `@expo/fingerprint`
// do (expo/expo#48839). `getConfig` on its own never reads `.env` files.
import { getConfig, type ExpoConfig } from '@expo/config';
import { loadProjectEnv } from '@expo/env';
import fs from 'fs';
import Module from 'module';
import path from 'path';

const scope = globalThis as { __DEV__?: boolean };

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
  /** Evaluate the config without running its config plugins. The declared `plugins` are kept. */
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
  const dev = '__DEV__' in scope ? { value: scope.__DEV__ } : null;
  const stdoutWrite = process.stdout.write;
  try {
    // `expo config` sets `__DEV__` from the mode as well, and a config may read it.
    scope.__DEV__ = mode === 'development';
    loadProjectEnv(projectRoot, { mode, silent: true, force: true });
    process.stdout.write = ((chunk: any, ...rest: any[]) =>
      (process.stderr.write as any)(chunk, ...rest)) as typeof process.stdout.write;
    const options = { skipSDKVersionRequirement: true, isPublicConfig, skipPlugins };
    const config = getConfig(projectRoot, options);
    if (skipPlugins && config.dynamicConfigPath && !('plugins' in config.exp)) {
      const plugins = readDeclaredPlugins(projectRoot, config.dynamicConfigPath, options);
      if (Array.isArray(plugins)) {
        config.exp.plugins = plugins;
      }
    }
    return {
      ok: true,
      exp: config.exp,
      staticConfigFile: relativeTo(projectRoot, config.staticConfigPath),
      dynamicConfigFile: relativeTo(projectRoot, config.dynamicConfigPath),
    };
  } catch (error: unknown) {
    return { ok: false, error: reasonOf(error instanceof Error ? error.message : String(error)) };
  } finally {
    process.stdout.write = stdoutWrite;
    if (dev) {
      scope.__DEV__ = dev.value;
    } else {
      delete scope.__DEV__;
    }
    restoreEnv(env);
  }
}

/**
 * The `plugins` the dynamic config returns, which `getConfig` deletes when it skips them.
 *
 * `getConfig` takes the config module from `require.cache` once it is loaded, so a second run
 * calls a wrapped export and sees the returned object before the delete. No plugin module loads.
 * Undefined when that fails, which leaves the values read so far standing.
 */
function readDeclaredPlugins(
  projectRoot: string,
  dynamicConfigPath: string,
  options: Parameters<typeof getConfig>[1]
): unknown {
  // Through `Module`, because the bundler replaces a bare `createRequire()` call.
  const cache = Module.createRequire(dynamicConfigPath).cache;
  const mod = cache[dynamicConfigPath] ?? cache[realpathOrSelf(dynamicConfigPath)];
  if (mod == null) {
    return undefined;
  }
  const original = mod.exports;
  const hasDefault = original?.default != null;
  const exported = hasDefault ? original.default : original;
  if (typeof exported !== 'function') {
    return pluginsOf(exported);
  }

  let declared: unknown;
  const capture = (request: unknown) => {
    const result = exported(request);
    declared = pluginsOf(result);
    return result;
  };
  mod.exports = hasDefault ? { ...original, default: capture } : capture;
  try {
    getConfig(projectRoot, options);
    return declared;
  } catch {
    return undefined;
  } finally {
    mod.exports = original;
  }
}

// Node keys `require.cache` by the real path, and `/tmp` is a symlink on macOS.
function realpathOrSelf(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

/** `@expo/config` reads the `expo` key when the config returns one, and the object itself if not. */
function pluginsOf(result: any): unknown {
  return (result?.expo ?? result)?.plugins;
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

function relativeTo(projectRoot: string, file: string | null): string | null {
  return file ? path.relative(projectRoot, file) || path.basename(file) : null;
}
