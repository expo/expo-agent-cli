// @ref llp/0004-smart-start-and-project-state.rfc.md
// Reading the config plugins of a project from its static app config.
//
// Only `app.json` and `app.config.json` are read. A dynamic `app.config.js`/`.ts` would have to
// be evaluated to learn its plugins, which runs project code inside the CLI — the process
// boundary of llp/0001 §Constraints item 5 exists to avoid exactly that. For a project with only
// a dynamic config, `plugins` is empty and `dynamic` is true, so callers can report the plugin
// answer as unknown instead of as "no plugins". Resolving those plugins is a job for an
// `expo config` subprocess, tracked as follow-up work.
import path from 'path';

import { fileExistsAsync } from '../utils/dir';
import { parsePackageNameFromModulePath, readJsonFileAsync } from './nodeModules';

/** One entry of the app config `plugins` array. */
export interface AppConfigPlugin {
  /** The entry as written in the config, e.g. `expo-build-properties`. */
  id: string;
  /** The package the plugin comes from, or `null` for a file inside the project. */
  packageName: string | null;
}

export interface StaticAppConfig {
  /** File the plugins were read from, relative to the project root. Null when there is none. */
  source: string | null;
  plugins: AppConfigPlugin[];
  /** A dynamic app config exists, so {@link plugins} may be incomplete. */
  dynamic: boolean;
}

/** Static config files, in the order `@expo/config` resolves them (`getStaticConfigFilePath`). */
const STATIC_CONFIG_FILES = ['app.config.json', 'app.json'];

/** Dynamic config files `@expo/config` resolves (`DYNAMIC_CONFIG_EXTS`), never evaluated here. */
const DYNAMIC_CONFIG_FILES = [
  'app.config.ts',
  'app.config.mts',
  'app.config.cts',
  'app.config.mjs',
  'app.config.cjs',
  'app.config.js',
];

/** The static app config, as written, and whether a dynamic one exists beside it. */
export interface StaticExpoConfig {
  /** File the config was read from, relative to the project root. Null when there is none. */
  source: string | null;
  /** The `expo` object of that file, or the file itself when it is a bare config. Null with no file. */
  config: Record<string, any> | null;
  /** A dynamic app config exists, so {@link config} is not what the app sees. */
  dynamic: boolean;
  /** The static file exists but does not parse, so {@link config} is null without being absent. */
  unreadable: boolean;
}

/** A dynamic app config is reported as present and never evaluated (llp/0001 §Constraints item 5). */
export async function readStaticExpoConfigAsync(projectRoot: string): Promise<StaticExpoConfig> {
  const dynamic = (
    await Promise.all(
      DYNAMIC_CONFIG_FILES.map((file) => fileExistsAsync(path.join(projectRoot, file)))
    )
  ).some(Boolean);

  // Expo takes the first file that exists, and does not fall back when it does not parse.
  for (const file of STATIC_CONFIG_FILES) {
    if (!(await fileExistsAsync(path.join(projectRoot, file)))) {
      continue;
    }
    const contents = await readJsonFileAsync<Record<string, any>>(path.join(projectRoot, file));
    if (contents == null || typeof contents !== 'object') {
      return { source: file, config: null, dynamic, unreadable: true };
    }
    // Both `{ "expo": { ... } }` and a bare config object are valid.
    const config = (contents.expo ?? contents) as Record<string, any>;
    return { source: file, config, dynamic, unreadable: false };
  }

  return { source: null, config: null, dynamic, unreadable: false };
}

/** Read the config plugins declared in the project's static app config. */
export async function readStaticAppConfigAsync(projectRoot: string): Promise<StaticAppConfig> {
  const { source, config, dynamic } = await readStaticExpoConfigAsync(projectRoot);
  return { source, plugins: parsePlugins(config?.plugins), dynamic };
}

/**
 * The project's `extra.eas.projectId`, as far as its static config says.
 *
 * @ref llp/0027-everything-on-eas.rfc.md §Check the EAS project before starting the environment
 * A null `projectId` with `dynamic: true` proves nothing: the dynamic config may set the id.
 */
export interface EasProjectLink {
  /** The `extra.eas.projectId` of the static config, or null when it names none. */
  projectId: string | null;
  /** File it was read from, relative to the project root. Null when there is no static config. */
  source: string | null;
  /** A dynamic app config exists, so a null {@link projectId} is not an answer. */
  dynamic: boolean;
  /** {@link source} does not parse, so a null {@link projectId} is not an answer either. */
  unreadable: boolean;
}

export async function readStaticEasProjectAsync(projectRoot: string): Promise<EasProjectLink> {
  const { source, config, dynamic, unreadable } = await readStaticExpoConfigAsync(projectRoot);
  const projectId = config?.extra?.eas?.projectId;
  return {
    projectId: typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null,
    source,
    dynamic,
    unreadable,
  };
}

/** Normalize the `plugins` array, whose entries are a module path or `[path, options]`. */
function parsePlugins(plugins: unknown): AppConfigPlugin[] {
  if (!Array.isArray(plugins)) {
    return [];
  }

  const parsed: AppConfigPlugin[] = [];
  for (const entry of plugins) {
    const id = typeof entry === 'string' ? entry : Array.isArray(entry) ? entry[0] : null;
    if (typeof id !== 'string' || !id) {
      continue;
    }
    parsed.push({ id, packageName: parsePackageNameFromModulePath(id) });
  }
  return parsed;
}
