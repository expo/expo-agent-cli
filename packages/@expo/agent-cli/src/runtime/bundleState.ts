// @ref llp/0005-runtime-loop-tools.rfc.md §The bundle state
import type { WebSocket } from 'ws';

import { probeTargetAsync, type CdpTarget } from './cdpClient';

/** Own targets split by bundle state. A target that cannot say counts as attached. */
export interface AttachedApps {
  attached: CdpTarget[];
  loading: CdpTarget[];
}

const PROBE_TIMEOUT_MS = 2000;
/** The least a probe gets near a deadline: a probe that times out says nothing. */
const PROBE_FLOOR_MS = 250;

/**
 * One probe per target, in parallel. Never throws.
 *
 * @param options.deadline caps each probe at the time left, so a wait ends near its deadline.
 */
export async function attachedAppsAsync(
  read: readonly CdpTarget[],
  options: { deadline?: number; createWebSocket?: (url: string) => WebSocket } = {}
): Promise<AttachedApps> {
  const timeoutMs =
    options.deadline == null
      ? PROBE_TIMEOUT_MS
      : Math.min(PROBE_TIMEOUT_MS, Math.max(PROBE_FLOOR_MS, options.deadline - Date.now()));
  const probes = await Promise.all(
    read.map((target) =>
      probeTargetAsync(target.webSocketDebuggerUrl, {
        timeoutMs,
        createWebSocket: options.createWebSocket,
      })
    )
  );
  return {
    attached: read.filter((_, index) => probes[index] !== 'not-run'),
    loading: read.filter((_, index) => probes[index] === 'not-run'),
  };
}
