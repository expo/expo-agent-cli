import { AsyncLocalStorage } from 'async_hooks';
import type { ChildProcess } from 'child_process';

import { killProcessTree } from './processGroup';

type Deadline = { expired: boolean; children: Set<ChildProcess>; error: Error };
const deadlines = new AsyncLocalStorage<Deadline>();

/** Bound a read and the subprocesses it starts, including sequential fallback commands. */
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
      for (const child of scope.children) killProcessTree(child, 'SIGKILL');
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

/** Check immediately before spawning: an expired read must not start another fallback. */
export function assertSubprocessDeadline(): void {
  const scope = deadlines.getStore();
  if (scope?.expired) throw scope.error;
}

/** Register after spawn so the enclosing read can stop every outstanding process on timeout. */
export function trackSubprocessDeadline(child: ChildProcess): void {
  const scope = deadlines.getStore();
  if (!scope) return;
  scope.children.add(child);
  const remove = () => scope.children.delete(child);
  child.once('close', remove);
  child.once('error', remove);
}
