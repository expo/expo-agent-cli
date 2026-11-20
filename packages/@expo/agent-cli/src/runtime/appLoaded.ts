// @ref llp/0005-runtime-loop-tools.rfc.md §A loaded app

import { createDefaultTargetSelector, evaluateJsFromCdpAsync, type CdpTarget } from './cdpClient';
import { probeDevServerAsync } from './devServer';

/** true: a bundle ran. false: the runtime answered that no bundle ran. null: cannot ask. */
export type AppLoaded = boolean | null;

// `__r` is the Metro `require`. Each Metro bundle defines it before any module runs.
export const APP_LOADED_EXPRESSION = `typeof globalThis.__r === 'function' ? 'bundle:ran' : 'bundle:none'`;

const APP_LOADED_PROBE_MS = 1500;
/** The least a probe gets near a deadline: a probe that times out says nothing. */
const APP_LOADED_PROBE_FLOOR_MS = 250;

/** 'bundle:ran' -> true, 'bundle:none' -> false, each other value -> null. */
export function appLoadedFromAnswer(value: unknown): AppLoaded {
  if (value === 'bundle:ran') return true;
  if (value === 'bundle:none') return false;
  return null;
}

/**
 * Ask the target that the default target selector returns for `targets`, which is the target that
 * a read command reads. Never throws.
 *
 * @param deadline caps the question at the time left, so a wait ends near its deadline.
 */
export async function readAppLoadedAsync(
  targets: readonly CdpTarget[],
  deadline?: number
): Promise<AppLoaded> {
  try {
    const target = await createDefaultTargetSelector()([...targets]);
    if (target == null) return null;
    const left = deadline == null ? Infinity : deadline - Date.now();
    return appLoadedFromAnswer(
      await evaluateJsFromCdpAsync(
        target.webSocketDebuggerUrl,
        APP_LOADED_EXPRESSION,
        Math.min(APP_LOADED_PROBE_MS, Math.max(APP_LOADED_PROBE_FLOOR_MS, left))
      )
    );
  } catch {
    return null;
  }
}

/** How often the debugger target list is read again while a wait for a loaded app runs. */
const LOADED_APP_POLL_MS = 500;
/** How often a running probe checks `stillWanted`. */
const STILL_WANTED_CHECK_MS = 100;

/** One probe that the deadline and `stillWanted` both cut short, so neither waits on a hung request. */
async function probeUntilAsync(devServerUrl: string, deadline: number, stillWanted: () => boolean) {
  const stop = new AbortController();
  const timer = setInterval(() => {
    if (!stillWanted() || Date.now() >= deadline) stop.abort();
  }, STILL_WANTED_CHECK_MS);
  const left = Math.max(deadline - Date.now(), APP_LOADED_PROBE_FLOOR_MS);
  try {
    return await probeDevServerAsync(devServerUrl, {
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(left)]),
    });
  } finally {
    clearInterval(timer);
  }
}

/**
 * How a wait for a loaded app ended.
 *
 * - `loaded`: the scope holds `targets`, and the runtime did not answer that no bundle ran.
 * - `not-loaded`: the scope held `targets`, and the runtime answered that no bundle ran.
 * - `not-attached`: the scope held no target at the deadline. `devServerAnswered` is whether any
 *   poll of the wait reached the dev server.
 * - `abandoned`: the caller's `stillWanted` said no first.
 */
export type LoadedAppWait =
  | { kind: 'loaded'; targets: number; loaded: true | null }
  | { kind: 'not-loaded'; targets: number }
  | { kind: 'not-attached'; devServerAnswered: boolean }
  | { kind: 'abandoned' };

/** The targets of the scope when the wait ended: zero unless an app was attached. */
export function loadedAppWaitTargets(wait: LoadedAppWait): number {
  return wait.kind === 'loaded' || wait.kind === 'not-loaded' ? wait.targets : 0;
}

/** The last answer to the bundle question, as {@link AppLoaded}. */
export function loadedAppWaitLoaded(wait: LoadedAppWait): AppLoaded {
  if (wait.kind === 'loaded') return wait.loaded;
  return wait.kind === 'not-loaded' ? false : null;
}

/**
 * Wait until the scope holds a debugger target and its runtime does not answer that no bundle ran,
 * until the deadline, or until `stillWanted` says no. The one poll for a loaded app: `navigate`
 * and `dev --wait-ready` both wait with it.
 *
 * @param classify places a target list in the caller's scope.
 * @param staleTargetIds targets listed before an open that reloads the app: they are the app from
 * before the reload, so only another target counts (the rule of `waitForFreshAppConnectionAsync`).
 */
export async function waitForLoadedAppAsync(
  devServerUrl: string,
  classify: (targets: CdpTarget[], deadline: number) => Promise<{ read: CdpTarget[] }>,
  deadline: number,
  {
    stillWanted = () => true,
    staleTargetIds = [],
  }: { stillWanted?: () => boolean; staleTargetIds?: readonly string[] } = {}
): Promise<LoadedAppWait> {
  const stale = new Set(staleTargetIds);
  // An app that a poll saw stays the answer when the list is empty for the last read: a short gap
  // in the list must not start a recovery that stops a loading app.
  let seen: Extract<LoadedAppWait, { kind: 'not-loaded' }> | null = null;
  let reached = false;
  for (;;) {
    const probe = await probeUntilAsync(devServerUrl, deadline, stillWanted);
    reached ||= probe.reachable;
    const scoped = probe.reachable ? (await classify(probe.targets, deadline)).read : [];
    const read = scoped.filter((target) => !stale.has(target.id));
    if (read.length > 0) {
      const loaded = await readAppLoadedAsync(read, deadline);
      if (loaded !== false) return { kind: 'loaded', targets: read.length, loaded };
      seen = { kind: 'not-loaded', targets: read.length };
    }
    if (!stillWanted()) return { kind: 'abandoned' };
    if (Date.now() >= deadline) {
      return seen ?? { kind: 'not-attached', devServerAnswered: reached };
    }
    await new Promise((resolve) => setTimeout(resolve, LOADED_APP_POLL_MS));
  }
}
