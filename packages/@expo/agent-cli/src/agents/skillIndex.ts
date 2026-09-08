// @ref llp/0003-knowledge-tools-and-skills.rfc.md §Instruction skill index
import fs from 'fs';
import path from 'path';

import { PROGRAM_PREFIX } from '../programName';
import type { DiscoveredSkill } from '../skills/types';
import { CommandError } from '../utils/errors';
import { toPosixPath } from '../utils/filePath';
import { BLOCK_START, BLOCK_END, resolveAgentsMdPathAsync } from './agentsMd';

const INDEX_START = '<!-- BEGIN EXPO PACKAGE SKILLS -->';
const INDEX_END = '<!-- END EXPO PACKAGE SKILLS -->';

export interface LinkedSkill {
  packageName: string;
  name: string;
  paths: string[];
}

/** Verify targets, rather than mistaking a user's same-named skill for a package link. */
export async function collectLinkedSkillsAsync(
  projectRoot: string,
  skills: DiscoveredSkill[],
  skillsDirs: string[]
): Promise<LinkedSkill[]> {
  const entries: LinkedSkill[] = [];
  const directories = [...new Set(skillsDirs)].sort();
  for (const skill of skills) {
    const target = await fs.promises.realpath(path.join(skill.path, 'SKILL.md')).catch(() => null);
    if (!target) continue;
    const paths: string[] = [];
    for (const dir of directories) {
      const linkPath = path.join(projectRoot, dir, skill.linkName);
      const stats = await fs.promises.lstat(linkPath).catch(() => null);
      if (!stats?.isSymbolicLink()) continue;
      const linkedFile = path.join(linkPath, 'SKILL.md');
      if ((await fs.promises.realpath(linkedFile).catch(() => null)) === target) {
        paths.push(toPosixPath(path.relative(projectRoot, linkedFile)));
      }
    }
    if (paths.length) entries.push({ packageName: skill.packageName, name: skill.name, paths });
  }
  return entries.sort((a, b) => compare(a.packageName, b.packageName) || compare(a.name, b.name));
}

export function renderSkillIndex(entries: LinkedSkill[] | null): string {
  const body = entries?.length
    ? [
        'Before using or modifying a package listed below, read its relevant skill for package-specific guidance. Each link for a row opens the same skill.',
        '',
        '| Package | Skill | Read |',
        '| --- | --- | --- |',
        ...entries.map(
          (entry) =>
            `| ${escapeCell(entry.packageName)} | ${escapeCell(entry.name)} | ${entry.paths
              .map(
                (file) =>
                  `[${escapeCell(file)}](${file.split('/').map(encodeURIComponent).join('/')})`
              )
              .join(', ')} |`
        ),
      ]
    : [
        entries == null
          ? 'Package skills could not be inspected.'
          : 'No linked package skills are available.',
      ];
  return [
    INDEX_START,
    '## Package skills',
    '',
    ...body,
    '',
    `Run \`${PROGRAM_PREFIX} skills:sync\` after changing dependencies to refresh this index. Run \`${PROGRAM_PREFIX} skills:list\` to see available package skills.`,
    INDEX_END,
  ].join('\n');
}

/** Refresh an opted-in index without creating instruction files or regenerating project facts. */
export async function refreshSkillIndexAsync(
  projectRoot: string,
  skills: DiscoveredSkill[],
  skillsDirs: string[]
): Promise<void> {
  const contents = await fs.promises
    .readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8')
    .catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  if (contents == null) return;
  const outerStart = contents.indexOf(BLOCK_START);
  const outerEnd = contents.indexOf(BLOCK_END, outerStart);
  const start = contents.indexOf(INDEX_START, outerStart);
  if (outerStart < 0 || start < 0) return;
  const end = contents.indexOf(INDEX_END, start);
  if (outerEnd < 0 || start > outerEnd || end < 0 || end > outerEnd) {
    throw new CommandError(
      'AGENTS_MD_INVALID_INDEX',
      'The managed package skill index in AGENTS.md has unmatched markers. Rerun agents:setup to regenerate the managed block.'
    );
  }
  const filePath = await resolveAgentsMdPathAsync(projectRoot);
  const entries = await collectLinkedSkillsAsync(projectRoot, skills, skillsDirs);
  const next =
    contents.slice(0, start) + renderSkillIndex(entries) + contents.slice(end + INDEX_END.length);
  if (next !== contents) await fs.promises.writeFile(filePath, next);
}

function escapeCell(value: string): string {
  const escapes: Record<string, string> = {
    '@': '&#64;',
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '|': '&#124;',
    '`': '&#96;',
    '[': '&#91;',
    ']': '&#93;',
    '\\': '&#92;',
  };
  return value.replace(/\s+/g, ' ').replace(/[@&<>|`[\]\\]/g, (char) => escapes[char]!);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
