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

/**
 * Wait until the scope holds a debugger target and its runtime does not answer that no bundle ran,
 * until the deadline, or until `stillWanted` says no. The one poll for a loaded app: `navigate`
 * and `dev --wait-ready` both wait with it.
 *
 * @param classify places a target list in the caller's scope.
 * @returns how many targets the scope had when the wait ended, and the last answer to the bundle
 * question. Zero targets, or `loaded: false`, means the wait ended without a loaded app.
 */
export async function waitForLoadedAppAsync(
  devServerUrl: string,
  classify: (targets: CdpTarget[], deadline: number) => Promise<{ read: CdpTarget[] }>,
  deadline: number,
  stillWanted: () => boolean = () => true
): Promise<{ targets: number; loaded: AppLoaded }> {
  // An app that a poll saw stays the answer when the list is empty for the last read: a short gap
  // in the list must not start a recovery that stops a loading app.
  let seen: { targets: number; loaded: AppLoaded } | null = null;
  for (;;) {
    const probe = await probeDevServerAsync(devServerUrl);
    const read = probe.reachable ? (await classify(probe.targets, deadline)).read : [];
    const targets = read.length;
    const loaded = targets > 0 ? await readAppLoadedAsync(read, deadline) : null;
    if (targets > 0) seen = { targets, loaded };
    if (targets > 0 && loaded !== false) return { targets, loaded };
    if (Date.now() >= deadline || !stillWanted()) return seen ?? { targets, loaded };
    await new Promise((resolve) => setTimeout(resolve, LOADED_APP_POLL_MS));
  }
}
