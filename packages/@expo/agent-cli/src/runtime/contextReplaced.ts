// @ref llp/0005-runtime-loop-tools.rfc.md §What proves a reload
// Whether an action replaced the JavaScript context of one debugger target.
//
// `Page.reload` keeps the target's page id, so a fresh target cannot prove it. A global the old
// context held and the new one does not can: it is set before the action, and read on the same
// target id after it.

import { randomBytes } from 'crypto';

import { firstLine } from '../utils/text';
import { CdpClient, runtimeEvaluateAsync, type CdpSession, type CdpTarget } from './cdpClient';
import { NO_DEVICE_FACTS, scopeOfFlags } from './runScope';

const MARKER = 'globalThis.__expoAgentCliReloadMarker';

/** How long one read of the marker may take. */
const READ_MS = 1000;

/** How often the marker is read again after the action. */
const POLL_MS = 250;

export type ContextReplaced =
  /** An evaluate answered on the same target, and the marker was gone. */
  | { kind: 'replaced' }
  /** The budget ran out with no such answer. */
  | { kind: 'not-replaced'; reason: string }
  /** The marker could not be set, so nothing could prove the action: it was not taken. */
  | { kind: 'unmarkable'; reason: string };

/**
 * Set a marker on the target, take the action, and read the marker until it is gone.
 *
 * A read that fails, and a read that still finds the marker, are "not yet": a reloading context
 * refuses requests for a moment, and the old one can answer once more after the action.
 */
export async function jsContextReplacedAsync(
  devServerUrl: string,
  target: Pick<CdpTarget, 'id'>,
  { act, timeoutMs }: { act: (client: CdpClient) => Promise<unknown>; timeoutMs: number }
): Promise<ContextReplaced> {
  const client = () =>
    new CdpClient({
      metroUrl: devServerUrl,
      scope: scopeOfFlags({ platform: null, eas: false }),
      facts: NO_DEVICE_FACTS,
      targetSelector: async (targets) => targets.find((each) => each.id === target.id) ?? null,
    });
  const nonce = JSON.stringify(randomBytes(8).toString('hex'));
  // One connection for every read. `Page.reload` keeps the target id, so the connection can outlive
  // the reload; one that drops is opened again, which also checks the target is still listed.
  let session: CdpSession | null = null;
  const ask = async (expression: string) => {
    if (session == null || session.closed) {
      session = await client().openSessionAsync();
    }
    return await runtimeEvaluateAsync(session, expression, {
      returnByValue: true,
      timeoutMs: READ_MS,
    });
  };
  const closeSession = () => session?.close();

  try {
    try {
      const set = await ask(`${MARKER} = ${nonce}`);
      if (JSON.stringify(set.value) !== nonce) {
        return {
          kind: 'unmarkable',
          reason: set.exceptionText ?? 'the app did not keep the marker',
        };
      }
    } catch (error: unknown) {
      return { kind: 'unmarkable', reason: describe(error) };
    }

    await act(client());

    const deadline = Date.now() + timeoutMs;
    let reason = 'no read of the marker answered';
    for (;;) {
      try {
        const read = await ask(`${MARKER} === ${nonce}`);
        if (read.value === false) {
          return { kind: 'replaced' };
        }
        reason = 'the marker set before it was still there, so the JavaScript context was the same';
      } catch (error: unknown) {
        reason = `the last read of the marker failed: ${describe(error)}`;
      }
      if (Date.now() + POLL_MS >= deadline) {
        return { kind: 'not-replaced', reason };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    closeSession();
  }
}

function describe(error: unknown): string {
  return firstLine(error instanceof Error ? error.message : String(error));
}
