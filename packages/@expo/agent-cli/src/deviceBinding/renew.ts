// @ref llp/0030-one-device-per-worktree.rfc.md §Lease
import { extendLeaseAsync, EXTEND_EVERY_MS } from './lease';
import { ownBindingFiles } from './records';
import { readBindingFile } from './registry';
import { defaultTools } from './tools';
import type { DeviceTools } from './types';

/** Keep devices leased for the whole runner, including files bound after it started. */
export async function withLeaseExtendedAsync<T>(
  projectRoot: string,
  work: () => Promise<T>,
  {
    tools = defaultTools(),
    warn = console.error,
  }: { tools?: DeviceTools; warn?: (message: string) => void } = {}
): Promise<T> {
  if (process.env.AGENT_CLI_NO_DEVICE === '1') return work();
  const states = new Map<string, 'extended' | 'lost'>();
  let ticking: Promise<void> | undefined;
  const tick = async () => {
    for (const { file, platform, backend } of ownBindingFiles(projectRoot)) {
      if (!states.has(file) && readBindingFile(file).kind === 'none') continue;
      try {
        const state = await extendLeaseAsync(projectRoot, platform, backend, tools, {
          waitMs: 5_000,
        });
        if (state === 'lost' && states.get(file) === 'extended') {
          warn(
            `The ${platform} device lease expired or disappeared. Run dev --${platform} to bind it again.`
          );
        }
        states.set(file, state);
      } catch {
        // Skip this tick on contention rather than waiting five seconds for each file.
        return;
      }
    }
  };
  const timer = setInterval(() => {
    ticking ??= tick()
      .catch(() => {})
      .finally(() => {
        ticking = undefined;
      });
  }, EXTEND_EVERY_MS);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
    await ticking;
  }
}
