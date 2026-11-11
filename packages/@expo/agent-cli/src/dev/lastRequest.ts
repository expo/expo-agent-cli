// @ref llp/0035-one-device-per-worktree.rfc.md §Lifecycle output
import fs from 'fs';
import path from 'path';

import { readAgentCliSettings } from '../settings';
import type { DevOptions } from './resolveOptions';
import { parseStartupRequest, startupRequestFrom, type StartupRequest } from './startupRequest';

/** Recovery preferences, never evidence that a process or device is alive. */
export type LastDevRequest = StartupRequest;

const FILE = 'agent-cli-last-dev.json';

export function readLastDevRequest(projectRoot: string): LastDevRequest | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(projectRoot, '.expo', FILE), 'utf8'));
    return value?.version === 2 ? parseStartupRequest(value.request) : null;
  } catch {
    return null;
  }
}

export function recordLastDevRequest(
  projectRoot: string,
  options: DevOptions,
  request?: StartupRequest
): void {
  if (options.mode !== 'run') return;
  try {
    // Nonrecursive: a late invocation must not resurrect a deleted checkout.
    try {
      fs.mkdirSync(path.join(projectRoot, '.expo'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return;
    }
    fs.writeFileSync(
      path.join(projectRoot, '.expo', FILE),
      JSON.stringify({
        version: 2,
        request: request ?? startupRequestFrom(options, readAgentCliSettings(projectRoot).settings),
      }) + '\n'
    );
  } catch {
    // Advisory only. An unwritable cache must not prevent development.
  }
}
