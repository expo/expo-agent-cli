// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
// This project's dev server that no lock answers for: its CLI process ended (a SIGKILL) and left
// Metro running. `status`, `dev:stop` and `dev` decide "this project's" by one check.

import { probeBundlerAsync } from '../runtime/bundlerStatus';
import { discoverDevServerAsync } from '../runtime/discoverDevServer';
import { readLastDevRequest } from './lastRequest';
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
 *
 * `status` looks at the port of the last `dev` request before the ladder, and so does this: a
 * foreground run on a named port writes no log the ladder could read.
 *
 * @param ports more ports to look at first: `dev` records its own request before it looks, so it
 * passes the port of the request before it, and the port it was given.
 */
export async function findUntrackedDevServerAsync(
  projectRoot: string,
  ports: (number | null | undefined)[] = []
): Promise<UntrackedDevServer | null> {
  const candidates = [...ports, readLastDevRequest(projectRoot)?.port].filter(
    (port): port is number => port != null
  );
  for (const port of new Set(candidates)) {
    const url = `http://127.0.0.1:${port}`;
    const probe = await discoverDevServerAsync(url, {
      signal: AbortSignal.timeout(OWNERSHIP_READ_TIMEOUT_MS),
    });
    if (probe.reachable && (await servesThisProjectAsync(url, projectRoot))) {
      return withListenerAsync(port, url);
    }
  }
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
  return withListenerAsync(Number(new URL(found.devServerUrl).port), found.devServerUrl);
}

async function withListenerAsync(port: number, url: string): Promise<UntrackedDevServer> {
  const listener = await findPortListenerAsync(port);
  return { port, url, pid: listener?.pid ?? null };
}

/** One sentence that names the server and why no run owns it. */
export function untrackedDevServerClause({ port, pid }: UntrackedDevServer): string {
  return `This project's dev server on port ${port}${pid != null ? ` (pid ${pid})` : ''} has no lock: its CLI process ended`;
}
