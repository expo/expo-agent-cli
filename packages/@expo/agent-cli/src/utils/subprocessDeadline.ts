// @ref llp/0004-smart-start-and-project-state.rfc.md §Reported by status
// A per-call timeout cannot bound a fallback chain, so one deadline scope is carried by
// AsyncLocalStorage and every subprocess spawned under it registers here.

import { AsyncLocalStorage } from 'async_hooks';
import type { ChildProcess } from 'child_process';

import { killProcessTree } from './processGroup';

type Deadline = { expired: boolean; children: Set<ChildProcess>; error: Error };

const deadlines = new AsyncLocalStorage<Deadline>();

/**
 * Run `work` under a deadline. When it expires, every subprocess still running under it is killed,
 * no further one may start, and the returned promise rejects with `message`.
 */
export async function withSubprocessDeadlineAsync<T>(
  timeoutMs: number,
  message: string,
  work: () => Promise<T>
): Promise<T> {
  const scope: Deadline = { expired: false, children: new Set(), error: new Error(message) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      scope.expired = true;
      for (const child of scope.children) {
        killProcessTree(child, 'SIGKILL');
      }
      reject(scope.error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([deadlines.run(scope, work), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Called before a spawn: an expired read must not start its fallback. Throws when it has. */
export function assertSubprocessDeadline(): void {
  const scope = deadlines.getStore();
  if (scope?.expired) {
    throw scope.error;
  }
}

/** Called after a spawn, so the enclosing deadline can stop the child when it expires. */
export function trackSubprocessDeadline(child: ChildProcess): void {
  const scope = deadlines.getStore();
  if (!scope) {
    return;
  }
  scope.children.add(child);
  const remove = () => scope.children.delete(child);
  child.once('close', remove);
  child.once('error', remove);
}
