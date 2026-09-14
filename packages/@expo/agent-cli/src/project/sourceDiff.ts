// @ref llp/0028-installed-app-check.rfc.md §What the answer is
// Naming what moved between two fingerprints. Both the installed-app check and the prebuild marker
// compare two source lists and have to say which input changed, so the identity, the naming and the
// project/dependency split live here rather than in either caller.

import type { FingerprintSource } from '../project/fingerprint';

export interface SourceChange {
  /** A readable name of the source, such as `app config` or `plugins/withFoo.js`. */
  source: string;
  change: 'added' | 'removed' | 'changed';
  /** Only project sources are named in messages; a dependency path is not something to act on. */
  scope: 'project' | 'dependency';
}

/**
 * Index sources by a stable identity. `overrideHashKey` is part of the key when set: it exists to
 * keep a source identifiable when its path varies between environments.
 */
export function toSourceHashMap(
  sources: FingerprintSource[]
): Map<string, { hash: string; source: FingerprintSource }> {
  const map = new Map<string, { hash: string; source: FingerprintSource }>();
  for (const source of sources) {
    if (typeof source.hash !== 'string') {
      continue;
    }
    const override = typeof source.overrideHashKey === 'string' ? source.overrideHashKey : null;
    const key =
      source.type === 'contents'
        ? `contents:${source.id}`
        : source.type === 'package'
          ? `package:${override ?? source.name}`
          : `${source.type}:${override ?? source.filePath}`;
    map.set(key, { hash: source.hash, source });
  }
  return map;
}

/** What differs between two source lists, named. */
export function diffSources(
  before: FingerprintSource[],
  after: FingerprintSource[]
): SourceChange[] {
  const a = toSourceHashMap(before);
  const b = toSourceHashMap(after);
  const changes: SourceChange[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const was = a.get(key);
    const now = b.get(key);
    if (was?.hash === now?.hash) {
      continue;
    }
    const change = !was ? 'added' : !now ? 'removed' : 'changed';
    changes.push({ ...describeSource((now ?? was)!.source), change });
  }
  return changes;
}

/** The project sources of `changes`, as a phrase. Empty when only dependencies moved. */
export function formatChangedSources(changes: SourceChange[], max: number = 3): string {
  const project = changes.filter((change) => change.scope === 'project');
  const named = project.slice(0, max).map((change) => change.source);
  const remaining = project.length - named.length;
  return named.join(', ') + (remaining > 0 ? `, and ${remaining} more` : '');
}

export function describeSource(source: FingerprintSource): Pick<SourceChange, 'source' | 'scope'> {
  if (source.type === 'contents') {
    return {
      source: source.id === 'expoConfig' ? 'the app config' : (source.id ?? 'contents'),
      scope: 'project',
    };
  }
  if (source.type === 'package') {
    return { source: `package ${source.name ?? ''}`.trim(), scope: 'dependency' };
  }
  const filePath = source.filePath ?? '';
  return { source: filePath, scope: isDependencyPath(filePath) ? 'dependency' : 'project' };
}

/** A path outside the project: a linked workspace package (`..`) or an installed one. */
function isDependencyPath(filePath: string): boolean {
  const segments = filePath.split(/[\\/]/);
  return segments[0] === '..' || segments.includes('node_modules');
}
