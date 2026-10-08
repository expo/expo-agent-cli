// @ref llp/0030-local-docs.rfc.md §Commands — `docs:sync` suggests a first search.

import { PROGRAM_PREFIX } from '../programName';
import { capFollowUps, type FollowUp } from './types';

export const DOCS_SEARCH_FOLLOWUP_COMMAND = `${PROGRAM_PREFIX} docs:search <query>`;

export interface DocsSyncFollowUpInput {
  /** The SDK major the caller named with `--sdk`, so the search can read the same version. */
  sdkMajor: number | null;
}

export function buildDocsSyncFollowUps({ sdkMajor }: DocsSyncFollowUpInput): FollowUp[] {
  const sdk = sdkMajor != null ? ` Add --sdk ${sdkMajor} to search the version synced here.` : '';
  return capFollowUps([
    {
      id: 'docs-search',
      command: DOCS_SEARCH_FOLLOWUP_COMMAND,
      why: `Ranks the synced pages for a query, with the file and line to read; grep over the directories works too.${sdk}`,
    },
  ]);
}
