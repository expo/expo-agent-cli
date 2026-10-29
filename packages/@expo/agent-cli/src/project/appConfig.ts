// @ref llp/0004-smart-start-and-project-state.rfc.md
// Reading the app config the app itself sees.
//
// A project with only `app.json`/`app.config.json` is read from that file, and nothing is
// evaluated. A dynamic `app.config.js`/`.ts` is evaluated with `@expo/config` after the project's
// env files are loaded (`src/project/evaluatedConfig.ts`), the way `expo config` reads it. When that
// fails, the static file stands and `evaluationError` says why, so a caller can report a missing
// value as unknown instead of as absent.
import { getFiles as getEnvFiles } from '@expo/env';
import fs from 'fs';
import path from 'path';

import { evaluateExpoConfig } from './evaluatedConfig';
import { parsePackageNameFromModulePath } from './nodeModules';

/** One entry of the app config `plugins` array. */
export interface AppConfigPlugin {
  /** The entry as written in the config, e.g. `expo-build-properties`. */
  id: string;
  /** The package the plugin comes from, or `null` for a file inside the project. */
  packageName: string | null;
}

export interface AppConfigPlugins {
  /** File the plugins were read from, relative to the project root. Null when there is none. */
  source: string | null;
  plugins: AppConfigPlugin[];
  /** Why the plugins of the dynamic config are unknown, so {@link plugins} is empty. */
  unknownBecause: string | null;
}

/** Static config files, in the order `@expo/config` resolves them (`getStaticConfigFilePath`). */
export const STATIC_CONFIG_FILES = ['app.config.json', 'app.json'];

/** Dynamic config files `@expo/config` resolves (`DYNAMIC_CONFIG_EXTS`). */
export const DYNAMIC_CONFIG_FILES = [
  'app.config.ts',
  'app.config.mts',
  'app.config.cts',
  'app.config.mjs',
  'app.config.cjs',
  'app.config.js',
];

/** The app config the app sees, and where it came from. */
export interface ProjectExpoConfig {
  /**
   * File the config was read from, relative to the project root: the dynamic file once it was
   * evaluated, else the static one. Null when there is none.
   */
  source: string | null;
  /** The `expo` object of the config. Null with no config, or a static file that does not parse. */
  config: Record<string, any> | null;
  /** Name of the dynamic config file in the project, if any. */
  dynamicConfigFile: string | null;
  /** The static file exists but does not parse, so {@link config} is null without being absent. */
  unreadable: boolean;
  /**
   * Why {@link dynamicConfigFile} could not be evaluated, when it exists and {@link config} is the
   * static read. Null when it was evaluated, or there is none.
   */
  evaluationError: string | null;
  /** {@link dynamicConfigFile} was evaluated, but the `plugins` it returns could not be read. */
  pluginsUnknown: boolean;
}

/** The last evaluation per project in this process, with the files it was evaluated from. */
const evaluations = new Map<string, { inputs: string; read: ProjectExpoConfig }>();

/**
 * Read the project's app config.
 *
 * The dev loop's view: the env files are those of `development`, and the config plugins are not
 * run, so a plugin module that is not installed does not fail the read. The declared `plugins`
 * are kept.
 *
 * A dynamic config is evaluated once per process while its inputs stay the same, so the scheme,
 * the ids and the plugins one command reads all come from one call of it. Nothing is kept across
 * runs, for the reason llp/0011 gives: a dynamic config can read env vars and files that no stamp
 * sees.
 */
export function readExpoConfig(projectRoot: string): ProjectExpoConfig {
  const dynamicConfigFile =
    DYNAMIC_CONFIG_FILES.find((file) => fs.existsSync(path.join(projectRoot, file))) ?? null;
  const staticRead = readStaticConfig(projectRoot);
  if (dynamicConfigFile == null) {
    return { ...staticRead, dynamicConfigFile, evaluationError: null, pluginsUnknown: false };
  }

  const inputs = readEvaluationInputs(projectRoot, dynamicConfigFile);
  const last = evaluations.get(projectRoot);
  if (last?.inputs === inputs) {
    return last.read;
  }
  const read = evaluateDynamicConfig(projectRoot, dynamicConfigFile, staticRead);
  evaluations.set(projectRoot, { inputs, read });
  return read;
}

/** The contents of the files an evaluation reads: the configs, `package.json` and the env files. */
function readEvaluationInputs(projectRoot: string, dynamicConfigFile: string): string {
  return [dynamicConfigFile, ...STATIC_CONFIG_FILES, 'package.json', ...getEnvFiles('development')]
    .map((file) => {
      try {
        return `${file}\0${fs.readFileSync(path.join(projectRoot, file), 'utf8')}`;
      } catch {
        return `${file}\0`;
      }
    })
    .join('\0');
}

function evaluateDynamicConfig(
  projectRoot: string,
  dynamicConfigFile: string,
  staticRead: Pick<ProjectExpoConfig, 'source' | 'config' | 'unreadable'>
): ProjectExpoConfig {
  const evaluated = evaluateExpoConfig(projectRoot, {
    mode: 'development',
    isPublicConfig: true,
    skipPlugins: true,
  });
  if (!evaluated.ok) {
    return {
      ...staticRead,
      dynamicConfigFile,
      evaluationError: evaluated.error,
      pluginsUnknown: false,
    };
  }
  return {
    source: dynamicConfigFile,
    config: evaluated.exp as Record<string, any>,
    dynamicConfigFile,
    unreadable: false,
    evaluationError: null,
    pluginsUnknown: evaluated.pluginsUnknown,
  };
}

/** Whether the project has any app config file, without reading or evaluating it. */
export function hasAppConfigFile(projectRoot: string): boolean {
  return [...STATIC_CONFIG_FILES, ...DYNAMIC_CONFIG_FILES].some((file) =>
    fs.existsSync(path.join(projectRoot, file))
  );
}

/** Read the config plugins the project declares. */
export function readAppConfigPlugins(projectRoot: string): AppConfigPlugins {
  const read = readExpoConfig(projectRoot);
  const unknownBecause = whyPluginsAreUnknown(read);
  // A file that does not parse was not read, so it is not named as the source. The static list
  // does not stand in for a dynamic config whose plugins are unknown.
  return {
    source: read.unreadable ? null : read.source,
    plugins: unknownBecause == null ? parsePlugins(read.config?.plugins) : [],
    unknownBecause,
  };
}

/** Why the `plugins` of the config the app sees are unknown, or null when they were read. */
export function whyPluginsAreUnknown(read: ProjectExpoConfig): string | null {
  if (read.evaluationError != null) {
    return `${read.dynamicConfigFile} could not be evaluated (${read.evaluationError})`;
  }
  if (read.pluginsUnknown) {
    return `the plugins ${read.dynamicConfigFile} returns could not be read`;
  }
  return null;
}

/**
 * The project's `extra.eas.projectId`.
 *
 * @ref llp/0027-everything-on-eas.rfc.md §Check the EAS project before starting the environment
 * A null `projectId` with an `evaluationError` proves nothing: the dynamic config may set the id.
 */
export interface EasProjectLink {
  /** The `extra.eas.projectId` of the config, or null when it names none. */
  projectId: string | null;
  /** File it was read from, relative to the project root. Null when there is no config. */
  source: string | null;
  /** The dynamic config could not be evaluated, so a null {@link projectId} is not an answer. */
  evaluationError: string | null;
  /** {@link source} does not parse, so a null {@link projectId} is not an answer either. */
  unreadable: boolean;
}

export function readEasProject(projectRoot: string): EasProjectLink {
  const { source, config, unreadable, evaluationError } = readExpoConfig(projectRoot);
  const projectId = config?.extra?.eas?.projectId;
  return {
    projectId: typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null,
    source,
    evaluationError,
    unreadable,
  };
}

/** The first static config file that exists, as `@expo/config` takes it: no fallback past one that does not parse. */
function readStaticConfig(
  projectRoot: string
): Pick<ProjectExpoConfig, 'source' | 'config' | 'unreadable'> {
  for (const file of STATIC_CONFIG_FILES) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(projectRoot, file), 'utf8');
    } catch {
      continue;
    }
    let contents: unknown;
    try {
      contents = JSON.parse(text);
    } catch {
      return { source: file, config: null, unreadable: true };
    }
    if (contents == null || typeof contents !== 'object' || Array.isArray(contents)) {
      return { source: file, config: null, unreadable: true };
    }
    // Both `{ "expo": { ... } }` and a bare config object are valid.
    const record = contents as Record<string, any>;
    return {
      source: file,
      config: (record.expo ?? record) as Record<string, any>,
      unreadable: false,
    };
  }
  return { source: null, config: null, unreadable: false };
}

/** Normalize the `plugins` array, whose entries are a module path or `[path, options]`. */
function parsePlugins(plugins: unknown): AppConfigPlugin[] {
  return (readPluginIds(plugins) ?? []).map((id) => ({
    id,
    packageName: parsePackageNameFromModulePath(id),
  }));
}

/**
 * The ids of a `plugins` array as the config spells them, or null when the value is not an array.
 *
 * Null rather than an empty list, because the two mean different things to a caller with a
 * fallback: an evaluated config that names no plugins has answered, and one that carries no
 * `plugins` key has not.
 */
export function readPluginIds(plugins: unknown): string[] | null {
  if (!Array.isArray(plugins)) {
    return null;
  }

  const ids: string[] = [];
  for (const entry of plugins) {
    const id = typeof entry === 'string' ? entry : Array.isArray(entry) ? entry[0] : null;
    if (typeof id === 'string' && id) {
      ids.push(id);
    }
  }
  return ids;
}
