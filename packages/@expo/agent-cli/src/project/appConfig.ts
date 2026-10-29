// @ref llp/0004-smart-start-and-project-state.rfc.md
// Reading the app config the app itself sees.
//
// A project with only `app.json`/`app.config.json` is read from that file, and nothing is
// evaluated. A dynamic `app.config.js`/`.ts` is evaluated with `@expo/config` after the project's
// env files are loaded (`src/project/evaluatedConfig.ts`), the way `expo config` reads it. When that
// fails, the result says why and carries the static read, so a caller can report a missing value as
// unknown instead of as absent.
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

/** The `expo` object of an app config. */
export type ExpoConfigObject = Record<string, any>;

/** What reading the first static config file came to. `file` is relative to the project root. */
export type StaticConfigRead =
  | { kind: 'none' }
  | { kind: 'unreadable'; file: string }
  | { kind: 'static'; file: string; config: ExpoConfigObject };

/** What reading the app config the app sees came to. `file` is relative to the project root. */
export type ProjectExpoConfig =
  | StaticConfigRead
  | { kind: 'evaluated'; file: string; config: ExpoConfigObject }
  | { kind: 'evaluation-failed'; file: string; error: string; fallback: StaticConfigRead };

/** The read that holds values: the evaluated or static one, or the static read a failed evaluation left. */
export function configOf(
  read: ProjectExpoConfig
): Extract<ProjectExpoConfig, { kind: 'static' | 'evaluated' }> | null {
  const settled = read.kind === 'evaluation-failed' ? read.fallback : read;
  return settled.kind === 'static' || settled.kind === 'evaluated' ? settled : null;
}

/** One sentence on a dynamic config that could not be evaluated, or null when there is none. */
export function evaluationFailureOf(read: ProjectExpoConfig): string | null {
  return read.kind === 'evaluation-failed'
    ? `${read.file} could not be evaluated (${read.error})`
    : null;
}

const reads = new Map<string, ProjectExpoConfig>();

/**
 * Read the project's app config.
 *
 * A dynamic config is evaluated once per project per process, so the scheme, the ids and the
 * plugins one command reads all come from one call of it. Nothing is kept across runs, for the
 * reason llp/0011 gives: a dynamic config can read env vars and files that no stamp sees.
 */
export function readExpoConfig(projectRoot: string): ProjectExpoConfig {
  const known = reads.get(projectRoot);
  if (known) {
    return known;
  }
  const read = readUncached(projectRoot);
  reads.set(projectRoot, read);
  return read;
}

/** Forget every read, for a caller that changes a config file and reads it again. */
export function forgetExpoConfigReads(): void {
  reads.clear();
}

function readUncached(projectRoot: string): ProjectExpoConfig {
  const staticRead = readStaticConfig(projectRoot);
  const dynamicConfigFile = DYNAMIC_CONFIG_FILES.find((file) =>
    fs.existsSync(path.join(projectRoot, file))
  );
  if (dynamicConfigFile == null) {
    return staticRead;
  }
  const evaluated = evaluateExpoConfig(projectRoot);
  return evaluated.ok
    ? { kind: 'evaluated', file: dynamicConfigFile, config: evaluated.exp as ExpoConfigObject }
    : {
        kind: 'evaluation-failed',
        file: dynamicConfigFile,
        error: evaluated.error,
        fallback: staticRead,
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
  switch (read.kind) {
    case 'none':
    case 'unreadable':
      // A file that does not parse was not read, so it is not named as the source.
      return { source: null, plugins: [], unknownBecause: null };
    case 'static':
    case 'evaluated':
      return {
        source: read.file,
        plugins: parsePlugins(read.config.plugins),
        unknownBecause: null,
      };
    case 'evaluation-failed':
      // The static list does not stand in for a dynamic config whose plugins are unknown.
      return { source: null, plugins: [], unknownBecause: evaluationFailureOf(read) };
  }
}

/**
 * Whether the project is linked to an EAS project, by its `extra.eas.projectId`.
 *
 * @ref llp/0027-everything-on-eas.rfc.md §Check the EAS project before starting the environment
 * A config that names no id is `unlinked` only when it was read. One that could not be evaluated
 * may set the id, so it is `unknown`.
 */
export type EasProjectLink =
  | { kind: 'linked'; projectId: string; source: string }
  | { kind: 'unlinked'; source: string | null }
  | { kind: 'unreadable'; source: string }
  | { kind: 'unknown'; source: string; why: string };

export function readEasProject(projectRoot: string): EasProjectLink {
  const read = readExpoConfig(projectRoot);
  const settled = read.kind === 'evaluation-failed' ? read.fallback : read;
  if (settled.kind === 'unreadable') {
    return { kind: 'unreadable', source: settled.file };
  }
  const values = configOf(read);
  const projectId = values?.config.extra?.eas?.projectId;
  if (values && typeof projectId === 'string' && projectId.trim()) {
    return { kind: 'linked', projectId: projectId.trim(), source: values.file };
  }
  if (read.kind === 'evaluation-failed') {
    return { kind: 'unknown', source: read.file, why: evaluationFailureOf(read)! };
  }
  return { kind: 'unlinked', source: settled.kind === 'none' ? null : settled.file };
}

/** The first static config file that exists, as `@expo/config` takes it: no fallback past one that does not parse. */
function readStaticConfig(projectRoot: string): StaticConfigRead {
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
      return { kind: 'unreadable', file };
    }
    if (contents == null || typeof contents !== 'object' || Array.isArray(contents)) {
      return { kind: 'unreadable', file };
    }
    // Both `{ "expo": { ... } }` and a bare config object are valid.
    const record = contents as ExpoConfigObject;
    return { kind: 'static', file, config: (record.expo ?? record) as ExpoConfigObject };
  }
  return { kind: 'none' };
}

/** Normalize the `plugins` array, whose entries are a module path or `[path, options]`. */
function parsePlugins(plugins: unknown): AppConfigPlugin[] {
  return readPluginIds(plugins).map((id) => ({
    id,
    packageName: parsePackageNameFromModulePath(id),
  }));
}

/** The ids of a `plugins` array as the config spells them. Anything but an array has none. */
export function readPluginIds(plugins: unknown): string[] {
  if (!Array.isArray(plugins)) {
    return [];
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
