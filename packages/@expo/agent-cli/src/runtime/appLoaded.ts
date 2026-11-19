// @ref llp/0005-runtime-loop-tools.rfc.md §A loaded app

import { createDefaultTargetSelector, evaluateJsFromCdpAsync, type CdpTarget } from './cdpClient';

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
