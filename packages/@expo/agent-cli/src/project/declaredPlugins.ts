// The `plugins` a dynamic config declares, which `@expo/config` drops when it skips running them:
//
//     // @expo/config 58.0.7, build/plugins/withConfigPlugins.js
//     } else {
//         // Delete the plugins array in case someone added functions or other values which cannot be automatically serialized.
//         delete config.plugins;
//     }
//     return serializeAfterStaticPlugins(config);
//
// `serializeAfterStaticPlugins` already serializes a `plugins` array, so the delete is not needed.
// TODO(kudo,20261029): delete this file once `@expo/config` keeps `plugins` under `skipPlugins`.
import { loadModuleSync } from '@expo/require-utils';
import fs from 'fs';
import Module from 'module';

export interface DeclaredPluginsCapture {
  /** What the config returned for `plugins`, or null when the config was not called. */
  declared(): { plugins: unknown } | null;
  /** Drop every module the evaluation loaded, so the next one runs the config fresh. */
  release(): void;
}

/**
 * Load the config into `require.cache`, where `getConfig` takes it from, with its export wrapped.
 * The one call that gives the scheme then also gives the plugins, and no plugin module loads.
 */
export function captureDeclaredPlugins(dynamicConfigPath: string): DeclaredPluginsCapture {
  const cache = requireCache(dynamicConfigPath);
  for (const key of [dynamicConfigPath, realpathOrSelf(dynamicConfigPath)]) {
    delete cache[key];
  }
  const before = new Set(Object.keys(cache));
  const release = () => {
    for (const key of Object.keys(cache)) {
      if (!before.has(key)) {
        delete cache[key];
      }
    }
  };

  // A config that throws while it loads throws here, and `getConfig` does not run it again.
  loadModuleSync(dynamicConfigPath);
  const mod = cache[dynamicConfigPath] ?? cache[realpathOrSelf(dynamicConfigPath)];
  if (mod == null) {
    return { declared: () => null, release };
  }
  const original = mod.exports;
  const hasDefault = original?.default != null;
  const exported = hasDefault ? original.default : original;
  if (typeof exported !== 'function') {
    return { declared: () => ({ plugins: pluginsOf(exported) }), release };
  }
  let declared: { plugins: unknown } | null = null;
  const capture = (request: unknown) => {
    const result = exported(request);
    declared = { plugins: pluginsOf(result) };
    return result;
  };
  mod.exports = hasDefault ? { ...original, default: capture } : capture;
  return { declared: () => declared, release };
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
