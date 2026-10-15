// @ref llp/0035-one-device-per-worktree.rfc.md §Lifecycle output
import fs from 'fs';
import path from 'path';

import type { DevOptions } from './resolveOptions';

/** Recovery preferences, never evidence that a process or device is alive. */
export type LastDevRequest = Pick<
  DevOptions,
  'platform' | 'port' | 'device' | 'buildBackend' | 'runTarget'
>;

const FILE = 'agent-cli-last-dev.json';

export function readLastDevRequest(projectRoot: string): LastDevRequest | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(projectRoot, '.expo', FILE), 'utf8'));
    if (
      value?.version !== 1 ||
      !['ios', 'android', 'web'].includes(value.platform) ||
      !(
        value.port === null ||
        (Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535)
      ) ||
      ![null, 'local', 'eas'].includes(value.buildBackend) ||
      ![null, 'expo-go', 'dev-build'].includes(value.runTarget) ||
      !(value.device === undefined || typeof value.device === 'string')
    )
      return null;
    const { platform, port, device, buildBackend, runTarget } = value;
    return { platform, port, device, buildBackend, runTarget };
  } catch {
    return null;
  }
}

export function recordLastDevRequest(projectRoot: string, options: DevOptions): void {
  if (options.mode !== 'run') return;
  try {
    // Nonrecursive: a late invocation must not resurrect a deleted checkout.
    try {
      fs.mkdirSync(path.join(projectRoot, '.expo'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return;
    }
    const { platform, port, device, buildBackend, runTarget } = options;
    fs.writeFileSync(
      path.join(projectRoot, '.expo', FILE),
      JSON.stringify({
        version: 1,
        platform,
        port,
        device,
        buildBackend,
        runTarget,
      }) + '\n'
    );
  } catch {
    // Advisory only. An unwritable cache must not prevent development.
  }
}
