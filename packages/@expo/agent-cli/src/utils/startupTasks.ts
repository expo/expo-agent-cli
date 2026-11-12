import { AsyncLocalStorage } from 'async_hooks';

const tasks = new AsyncLocalStorage<Set<Promise<unknown>>>();

export function trackStartupTask<T>(work: Promise<T>): Promise<T> {
  const pending = tasks.getStore();
  pending?.add(work);
  const remove = () => pending?.delete(work);
  void work.then(remove, remove);
  return work;
}

export async function withStartupTasksAsync<T>(run: () => Promise<T>): Promise<T> {
  const pending = new Set<Promise<unknown>>();
  return tasks.run(pending, async () => {
    try {
      return await run();
    } finally {
      while (pending.size) await Promise.allSettled(pending);
    }
  });
}
