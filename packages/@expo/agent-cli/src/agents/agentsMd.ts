// @ref llp/0006-agent-native-cli-surface.rfc.md §Surface improvements
// One managed block inside a file the user owns. Everything outside the two markers is the
// user's, and is preserved byte for byte, so a rerun is safe at any time.
import fs from 'fs';
import path from 'path';

import { CommandError } from '../utils/errors';
import type { AgentsMdResult, ClaudeMdResult } from './types';

/** The file the block is maintained in, relative to the project root. */
export const AGENTS_MD_FILE = 'AGENTS.md';

export const BLOCK_START = '<!-- BEGIN EXPO AGENT CLI MANAGED BLOCK -->';
export const BLOCK_END = '<!-- END EXPO AGENT CLI MANAGED BLOCK -->';

/**
 * Return the contents of `AGENTS.md` with the managed block set to `blockBody`.
 *
 * Pure, so the byte-for-byte guarantee is testable without a file system: the lines outside the
 * markers are never rebuilt, only spliced around.
 */
export function applyManagedBlock(contents: string | null, blockBody: string): string {
  const blockLines = [BLOCK_START, ...blockBody.replace(/\n+$/, '').split('\n'), BLOCK_END];

  if (!contents?.length) {
    return blockLines.join('\n') + '\n';
  }

  const lines = contents.split('\n');
  const start = lines.indexOf(BLOCK_START);

  if (start >= 0) {
    const end = lines.indexOf(BLOCK_END, start);
    if (end < 0) {
      throw new CommandError(
        'AGENTS_MD_UNCLOSED_BLOCK',
        `${AGENTS_MD_FILE} has a "${BLOCK_START}" marker without a matching "${BLOCK_END}" marker, so the managed block has no end and rewriting it would delete the rest of the file. Add the end marker back, or delete the start marker to let the block be appended again, then run the command again.`
      );
    }
    const next = [...lines];
    next.splice(start, end - start + 1, ...blockLines);
    return withTrailingNewline(next.join('\n'));
  }

  // No block yet: append it after the user's content, separated by one blank line.
  const next = [...lines];
  while (next.at(-1) === '') {
    next.pop();
  }
  next.push('', ...blockLines);
  return withTrailingNewline(next.join('\n'));
}

/**
 * Write the managed block into the project's `AGENTS.md`, creating the file when it is missing.
 *
 * A file that already holds this exact block is left untouched, so the report can say `skipped`
 * and a rerun never shows up in `git status`.
 */
export async function writeManagedBlockAsync(
  projectRoot: string,
  blockBody: string
): Promise<AgentsMdResult> {
  const filePath = await resolveAgentsMdPathAsync(projectRoot);
  const contents = await fs.promises.readFile(filePath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const next = applyManagedBlock(contents, blockBody);

  if (next === contents) {
    return { path: AGENTS_MD_FILE, action: 'skipped' };
  }

  await fs.promises.writeFile(filePath, next);
  return { path: AGENTS_MD_FILE, action: contents == null ? 'created' : 'updated' };
}

/** Only the conventional AGENTS.md → root CLAUDE.md alias is writable through a symlink. */
export async function resolveAgentsMdPathAsync(projectRoot: string): Promise<string> {
  const filePath = path.join(projectRoot, AGENTS_MD_FILE);
  const stats = await fs.promises.lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stats?.isSymbolicLink()) {
    const target = path.resolve(path.dirname(filePath), await fs.promises.readlink(filePath));
    const claudePath = path.join(projectRoot, 'CLAUDE.md');
    const claudeStats = await fs.promises.lstat(claudePath).catch(() => null);
    if (target === path.resolve(claudePath) && claudeStats?.isFile()) return claudePath;
    throw new CommandError(
      'AGENTS_MD_SYMLINK',
      'AGENTS.md is a symlink. Setup only writes through a link to the regular CLAUDE.md in this project root. Use a regular AGENTS.md or that shared-file layout.'
    );
  }
  if (stats && !stats.isFile()) {
    throw new CommandError('AGENTS_MD_NOT_FILE', 'AGENTS.md must be a regular file.');
  }
  return filePath;
}

/** Share the project instructions through Claude's file import syntax without replacing user text. */
export async function ensureClaudeMdReferenceAsync(projectRoot: string): Promise<ClaudeMdResult> {
  const filePath = path.join(projectRoot, 'CLAUDE.md');
  const stats = await fs.promises.lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const [claudeTarget, agentsTarget] = await Promise.all([
    fs.promises.realpath(filePath).catch(() => null),
    fs.promises.realpath(path.join(projectRoot, AGENTS_MD_FILE)).catch(() => null),
  ]);
  if (claudeTarget != null && claudeTarget === agentsTarget) {
    return { path: 'CLAUDE.md', action: 'skipped' };
  }
  if (stats?.isSymbolicLink() || (stats && !stats.isFile())) {
    throw new CommandError(
      'CLAUDE_MD_NOT_FILE',
      'CLAUDE.md is a symlink to another file or is not a regular file. Setup only reuses a symlink to AGENTS.md; it will not change another target.'
    );
  }
  const contents = stats ? await fs.promises.readFile(filePath, 'utf8') : '';
  const { prose, openBlock } = claudeImportText(contents);
  if (/(?:^|\s)@(?:\.\/)?AGENTS\.md(?=$|[\s,;:!?]|\.(?:\s|$))/.test(prose)) {
    return { path: 'CLAUDE.md', action: 'skipped' };
  }
  if (openBlock) {
    throw new CommandError(
      'CLAUDE_MD_UNCLOSED_BLOCK',
      'CLAUDE.md has an unclosed code block or HTML comment. Close it before rerunning setup so the AGENTS.md import can be read as instructions.'
    );
  }
  const separator = !contents
    ? ''
    : contents.endsWith('\n\n')
      ? ''
      : contents.endsWith('\n')
        ? '\n'
        : '\n\n';
  await fs.promises.writeFile(filePath, contents + separator + '@AGENTS.md\n');
  return { path: 'CLAUDE.md', action: stats ? 'updated' : 'created' };
}

/** Imports inside Markdown examples and comments do not load shared instructions. */
function claudeImportText(contents: string): { prose: string; openBlock: boolean } {
  let openComment = false;
  const uncommented = contents.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => {
    if (!comment.endsWith('-->')) openComment = true;
    return '';
  });
  let fence: string | null = null;
  const lines: string[] = [];
  for (const line of uncommented.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence[0] &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = null;
    } else if (marker) {
      fence = marker[1]!;
    } else if (!/^( {4}|\t)/.test(line)) {
      lines.push(line);
    }
  }
  return {
    prose: lines.join('\n').replace(/(`+)[\s\S]*?\1/g, ''),
    openBlock: openComment || fence != null,
  };
}

function withTrailingNewline(contents: string): string {
  return contents.endsWith('\n') ? contents : contents + '\n';
}
