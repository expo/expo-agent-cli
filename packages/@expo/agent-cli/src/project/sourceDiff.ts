// @ref llp/0004-smart-start-and-project-state.rfc.md §Installed-app fingerprint check
// Naming what moved between two fingerprints: the same identity rule `status` diffs with, a readable
// name per source, and the project/dependency split that decides which names a message may use.

import { diffItemSource, type FingerprintSource } from './fingerprint';
import { diffFingerprintSourcesLocally } from './localDiff';

export interface SourceChange {
  /** A readable name of the source, such as `app config` or `plugins/withFoo.js`. */
  source: string;
  change: 'added' | 'removed' | 'changed';
  /** Only project sources are named in messages; a dependency path is not something to act on. */
  scope: 'project' | 'dependency';
}

/** What differs between two source lists. */
export function diffSources(
  before: FingerprintSource[],
  after: FingerprintSource[]
): SourceChange[] {
  return diffFingerprintSourcesLocally(before, after).map((item) => ({
    ...describeSource(diffItemSource(item)),
    change: item.op,
  }));
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
      source: contentsName(source.id),
      scope: source.id?.startsWith('package:') ? 'dependency' : 'project',
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

function contentsName(id: string | undefined): string {
  if (id === 'expoConfig') return 'the app config';
  if (id?.startsWith('expoAutolinkingConfig:')) return 'Expo autolinking configuration';
  if (id?.startsWith('rncoreAutolinkingConfig')) return 'React Native autolinking configuration';
  if (id === 'packageJson:scripts') return 'package.json scripts';
  return id ?? 'contents';
}
