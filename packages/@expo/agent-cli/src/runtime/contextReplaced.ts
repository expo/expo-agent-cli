// @ref llp/0005-runtime-loop-tools.rfc.md §What proves a reload

import { randomBytes } from 'crypto';

import { firstLine } from '../utils/text';
import {
  CdpClient,
  CdpTimeoutError,
  runtimeEvaluateAsync,
  type CdpSession,
  type CdpTarget,
} from './cdpClient';
import { EMPTY_DEVICE_INVENTORY, READ_EVERY_TARGET } from './targetSelection';

/** How long one read of the marker may take. */
const READ_MS = 1000;

/** How long the action may take to answer. */
const ACT_MS = 5000;

/** How often the marker is read again after the action. */
const POLL_MS = 250;

export type ContextReplaced =
  /** An evaluate answered on the same target, and the marker was gone. */
  | { kind: 'replaced' }
  /** The budget ran out with no such answer. */
  | { kind: 'not-replaced'; reason: string }
  /** The action's answer never came, so it may not have run, and no read proved it did. */
  | { kind: 'answer-lost'; reason: string }
  /** The marker could not be set, so nothing could prove the action: it was not taken. */
  | { kind: 'unmarkable'; reason: string };

/**
 * Set a marker on the target, take the action, and read the marker until it is gone.
 *
 * A read that fails, and a read that still finds the marker, are "not yet": a reloading context
 * refuses requests for a moment, and the old one can answer once more after the action.
 *
 * An action whose answer is lost (the socket drops, its time runs out, or the phase is aborted) may
 * have run, so the marker is read anyway, within the same deadline, and the reason names the lost
 * answer. Any other failure of the action, a CDP error included, is thrown.
 */
export async function jsContextReplacedAsync(
  devServerUrl: string,
  target: Pick<CdpTarget, 'id'>,
  {
    act,
    timeoutMs,
    deadline,
  }: {
    act: (session: Pick<CdpSession, 'sendAsync'>) => Promise<unknown>;
    timeoutMs: number;
    /** Optional deadline for the entire operation, shared by multi-target callers. */
    deadline?: number;
  }
): Promise<ContextReplaced> {
  const clock = phaseClock(deadline);
  clock.limit(READ_MS);
  const client = () =>
    new CdpClient({
      metroUrl: devServerUrl,
      signal: clock.signal(),
      targetSelection: READ_EVERY_TARGET,
      deviceInventory: EMPTY_DEVICE_INVENTORY,
      targetSelector: async (targets) => targets.find((each) => each.id === target.id) ?? null,
    });
  const nonce = randomBytes(8).toString('hex');
  // Each check owns its property: another reload check must not overwrite its proof.
  const marker = `globalThis.__expoAgentCliReloadMarker_${nonce}`;
  // One connection for every read. `Page.reload` keeps the target id, so the connection can outlive
  // the reload; one that drops is opened again, which also checks the target is still listed.
  let session: CdpSession | null = null;
  const ask = async (expression: string) => {
    clock.signal().throwIfAborted();
    if (session == null || session.closed) {
      session?.close();
      session = await client().openSessionAsync();
    }
    const open = session;
    const read = await runtimeEvaluateAsync(open, expression, {
      returnByValue: true,
      timeoutMs: Math.min(READ_MS, clock.remaining()),
    });
    return { open, read };
  };
  const closeSession = async () => {
    if (session != null) {
      if (!session.closed && clock.open()) {
        // Best effort: a failed reload must not leave a new marker behind on every attempt.
        await runtimeEvaluateAsync(session, `delete ${marker}`, {
          returnByValue: true,
          timeoutMs: Math.min(READ_MS, clock.remaining()),
        }).catch(() => {});
      }
      session.close();
    }
  };

  try {
    let marked: CdpSession;
    try {
      const { open, read: set } = await ask(
        `(${marker} = ${JSON.stringify(nonce)}, ${marker} === ${JSON.stringify(nonce)})`
      );
      if (set.value !== true) {
        return {
          kind: 'unmarkable',
          reason: set.exceptionText ?? 'the app did not keep the marker',
        };
      }
      marked = open;
    } catch (error: unknown) {
      return { kind: 'unmarkable', reason: describe(error) };
    }

    clock.limit(ACT_MS);
    const lost = await act(marked).then(
      () => null,
      (error: unknown) => {
        if (error instanceof CdpTimeoutError || marked.closed || clock.signal().aborted) {
          return describe(error);
        }
        throw error;
      }
    );

    clock.limit(timeoutMs);
    for (let last = false; ;) {
      let reason: string;
      try {
        const { read } = await ask(`${marker} === ${JSON.stringify(nonce)}`);
        if (read.value === false) return { kind: 'replaced' };
        reason = 'the marker set before it was still there, so the JavaScript context was the same';
      } catch (error: unknown) {
        reason = `the last read of the marker failed: ${describe(error)}`;
      }
      if (last || !clock.open()) return notReplaced(reason, lost);
      // Less than an interval left still covers one more read, taken at once.
      if (clock.remaining() > POLL_MS) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      else last = true;
    }
  } finally {
    await closeSession();
    clock.stop();
  }
}

/** No read proved the action. `lost` names an action's answer that never came. */
function notReplaced(reason: string, lost: string | null): ContextReplaced {
  return lost == null
    ? { kind: 'not-replaced', reason }
    : { kind: 'answer-lost', reason: `the answer to the action was lost (${lost}), and ${reason}` };
}

/** One abort controller per phase, each bounded by its budget and by the whole proof's deadline. */
function phaseClock(deadline: number | undefined) {
  let controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiresAt = Date.now();
  const expire = () => controller.abort(new Error('Context proof deadline expired.'));
  return {
    signal: () => controller.signal,
    remaining: () => Math.max(1, expiresAt - Date.now()),
    open: () => !controller.signal.aborted && Date.now() < expiresAt,
    limit(budget: number) {
      clearTimeout(timer);
      // A phase that ran out aborted its controller; the next phase gets its own.
      if (controller.signal.aborted) controller = new AbortController();
      expiresAt = Math.min(deadline ?? Infinity, Date.now() + budget);
      if (expiresAt <= Date.now()) expire();
      timer = setTimeout(expire, Math.max(0, expiresAt - Date.now()));
    },
    stop: () => clearTimeout(timer),
  };
}

function describe(error: unknown): string {
  return firstLine(error instanceof Error ? error.message : String(error));
}
