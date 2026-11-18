// @ref llp/0005-runtime-loop-tools.rfc.md §The bundle state
import type { WebSocket } from 'ws';

import { evaluateJsFromCdpAsync, type CdpTarget } from './cdpClient';

export type BundleState = 'ran' | 'not-run' | 'unknown';

/** Own targets split by bundle state. `unknown` counts as attached. */
export interface AttachedApps {
  attached: CdpTarget[];
  loading: CdpTarget[];
}

export const BUNDLE_STATE_EXPRESSION = 'typeof globalThis.__r';

const PROBE_TIMEOUT_MS = 2000;

/** The state for what the probe resolved to: a string, or undefined for any other value. */
export function bundleStateOf(answer: string | undefined): BundleState {
  if (answer === undefined) return 'unknown';
  return answer === 'function' ? 'ran' : 'not-run';
}

/** One evaluate per target, in parallel. Never throws. */
export async function attachedAppsAsync(
  read: readonly CdpTarget[],
  options: { timeoutMs?: number; createWebSocket?: (url: string) => WebSocket } = {}
): Promise<AttachedApps> {
  const states = await Promise.all(
    read.map((target) =>
      evaluateJsFromCdpAsync(
        target.webSocketDebuggerUrl,
        BUNDLE_STATE_EXPRESSION,
        options.timeoutMs ?? PROBE_TIMEOUT_MS,
        options
      ).then(bundleStateOf, (): BundleState => 'unknown')
    )
  );
  return {
    attached: read.filter((_, index) => states[index] !== 'not-run'),
    loading: read.filter((_, index) => states[index] === 'not-run'),
  };
}
