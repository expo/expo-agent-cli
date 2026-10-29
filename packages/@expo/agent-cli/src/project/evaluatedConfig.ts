// @ref llp/0001-agentic-cli-on-expo-cli.rfc.md §Constraints
// The config the app itself sees: a dynamic `app.config.js`/`.ts` evaluated with `@expo/config`
// after the project's env files are loaded, which is what `expo config` and `@expo/fingerprint`
// do (expo/expo#48839). `getConfig` on its own never reads `.env` files.
import { getConfig, getConfigFilePaths, type ExpoConfig } from '@expo/config';
import { loadProjectEnv } from '@expo/env';
import { loadModuleSync } from '@expo/require-utils';
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
      /**
       * The plugins the dynamic config returns could not be read, so a missing `exp.plugins` is
       * not an empty list.
       */
      pluginsUnknown: boolean;
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
  let forget: (() => void) | null = null;
  try {
    // `expo config` sets `__DEV__` from the mode as well, and a config may read it.
    scope.__DEV__ = mode === 'development';
    loadProjectEnv(projectRoot, { mode, silent: true, force: true });
    process.stdout.write = ((chunk: any, ...rest: any[]) =>
      (process.stderr.write as any)(chunk, ...rest)) as typeof process.stdout.write;
    const { dynamicConfigPath } = getConfigFilePaths(projectRoot);
    let watch: DeclaredPluginsWatch | null = null;
    if (skipPlugins && dynamicConfigPath) {
      forget = forgetModulesLoadedFrom(dynamicConfigPath);
      // A config that throws while it loads throws here, and `getConfig` does not run it again.
      watch = watchDeclaredPlugins(dynamicConfigPath);
    }
    const config = getConfig(projectRoot, {
      skipSDKVersionRequirement: true,
      isPublicConfig,
      skipPlugins,
    });
    const declared = watch?.declared() ?? null;
    if (Array.isArray(declared?.plugins)) {
      config.exp.plugins = declared.plugins;
    }
    return {
      ok: true,
      exp: config.exp,
      staticConfigFile: relativeTo(projectRoot, config.staticConfigPath),
      dynamicConfigFile: relativeTo(projectRoot, config.dynamicConfigPath),
      pluginsUnknown: watch != null && declared == null,
    };
  } catch (error: unknown) {
    return { ok: false, error: reasonOf(error instanceof Error ? error.message : String(error)) };
  } finally {
    forget?.();
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
 * Drop the config from `require.cache` now, and on the returned call drop every module loaded
 * since, so the next evaluation runs the config and the helpers it requires fresh.
 */
function forgetModulesLoadedFrom(dynamicConfigPath: string): () => void {
  const cache = requireCache(dynamicConfigPath);
  for (const key of [dynamicConfigPath, realpathOrSelf(dynamicConfigPath)]) {
    delete cache[key];
  }
  const before = new Set(Object.keys(cache));
  return () => {
    for (const key of Object.keys(cache)) {
      if (!before.has(key)) {
        delete cache[key];
      }
    }
  };
}

interface DeclaredPluginsWatch {
  /** What the config returned for `plugins`, or null when no fresh call was seen. */
  declared(): { plugins: unknown } | null;
}

/** Exports a previous evaluation already called: a module Node served again, not a new run. */
const calledExports = new WeakSet<object>();

/**
 * Watch the `plugins` the dynamic config returns, which `getConfig` deletes when it skips them.
 *
 * The module is loaded into `require.cache` first, where `getConfig` takes it from, with its export
 * wrapped. So the one call that gives the scheme also gives the plugins, and no plugin module
 * loads. Node serves an ES module again without running it, so its plugins are unknown on a second
 * evaluation in one process.
 */
function watchDeclaredPlugins(dynamicConfigPath: string): DeclaredPluginsWatch {
  const cache = requireCache(dynamicConfigPath);
  loadModuleSync(dynamicConfigPath);
  const mod = cache[dynamicConfigPath] ?? cache[realpathOrSelf(dynamicConfigPath)];
  if (mod == null) {
    return { declared: () => null };
  }

  const original = mod.exports;
  const hasDefault = original?.default != null;
  const exported = hasDefault ? original.default : original;
  if (typeof exported !== 'function') {
    return { declared: () => ({ plugins: pluginsOf(exported) }) };
  }
  if (calledExports.has(exported)) {
    return { declared: () => null };
  }
  calledExports.add(exported);
  let declared: { plugins: unknown } | null = null;
  const capture = (request: unknown) => {
    const result = exported(request);
    declared = { plugins: pluginsOf(result) };
    return result;
  };
  mod.exports = hasDefault ? { ...original, default: capture } : capture;
  return { declared: () => declared };
}

// Through `Module`, because the bundler replaces a bare `createRequire()` call.
function requireCache(file: string): NodeJS.Dict<NodeJS.Module> {
  return Module.createRequire(file).cache;
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
