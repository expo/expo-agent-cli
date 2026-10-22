// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
// This project's dev server that no lock answers for: its CLI process ended (a SIGKILL) and left
// Metro running. `status`, `dev:stop` and `dev` decide "this project's" by one check.

import { probeBundlerAsync } from '../runtime/bundlerStatus';
import { discoverDevServerAsync } from '../runtime/devServer';
import { findPortListenerAsync } from './portListener';

/** How long the ownership read and each scan read may take. */
const OWNERSHIP_READ_TIMEOUT_MS = 1500;

export interface UntrackedDevServer {
  port: number;
  url: string;
  /** The process listening on the port, or null when this machine would not name it. */
  pid: number | null;
}

/**
 * Whether the dev server at `url` names this project on `GET /status`: the check `status` reports
 * as `projectRootMatched` (`waitForBundlerReadyAsync` and `matchProjectRoot`). A server that names
 * no project is not proved to be this project's.
 */
export async function servesThisProjectAsync(url: string, projectRoot: string): Promise<boolean> {
  const probe = await probeBundlerAsync(url, {
    projectRoot,
    timeoutMs: OWNERSHIP_READ_TIMEOUT_MS,
  });
  return probe.projectRootMatched === true;
}

/**
 * The dev server `status` finds for this project, when no lock answers for it and it names this
 * project. Callers read the lock first.
 */
export async function findUntrackedDevServerAsync(
  projectRoot: string
): Promise<UntrackedDevServer | null> {
  const found = await discoverDevServerAsync(undefined, {
    projectRoot,
    statusTimeoutMs: OWNERSHIP_READ_TIMEOUT_MS,
  });
  if (!found.reachable || found.source === 'lock') {
    return null;
  }
  if (!(await servesThisProjectAsync(found.devServerUrl, projectRoot))) {
    return null;
  }
  const port = Number(new URL(found.devServerUrl).port);
  const listener = await findPortListenerAsync(port);
  return { port, url: found.devServerUrl, pid: listener?.pid ?? null };
}

/** One sentence that names the server and why no run owns it. */
export function untrackedDevServerClause({ port, pid }: UntrackedDevServer): string {
  return `This project's dev server on port ${port}${pid != null ? ` (pid ${pid})` : ''} has no lock: its CLI process ended`;
}
