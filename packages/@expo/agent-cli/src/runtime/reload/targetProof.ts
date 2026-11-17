// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
import { firstLine } from '../../utils/text';
import type { CdpSession, CdpTarget } from '../cdpClient';
import { jsContextReplacedAsync, type ContextReplaced } from '../contextReplaced';
import type { TargetReloadOutcome } from './attempt';

/** One mechanism's action on a target, and what a lost answer to it counts as. */
export interface TargetAction {
  /** Throws `ActionRefusedError` when the app answers and does not take the action. */
  act: (session: Pick<CdpSession, 'sendAsync'>, deadline: number) => Promise<void>;
  answerLost: 'not-delivered' | 'delivered-unproved';
}

/**
 * Take the action on one target and prove it there: the same target answers from a new
 * JavaScript context before `deadline`. `stop` ends the check, and the outcome is then `stopped`.
 */
export async function reloadTargetAsync(
  devServerUrl: string,
  target: CdpTarget,
  { act, answerLost }: TargetAction,
  { deadline, stop }: { deadline: number; stop?: { signal: AbortSignal; reason: string } }
): Promise<TargetReloadOutcome> {
  const identity = { targetId: target.id, deviceName: target.deviceName };
  const stopped = (): TargetReloadOutcome | null =>
    stop?.signal.aborted ? { ...identity, outcome: 'stopped', reason: stop.reason } : null;
  try {
    const seen = await jsContextReplacedAsync(devServerUrl, target, {
      act: (session) => act(session, deadline),
      timeoutMs: Math.max(0, deadline - Date.now()),
      deadline,
      signal: stop?.signal,
    });
    if (seen.kind === 'replaced') {
      return { ...identity, outcome: 'context-replaced', reason: null };
    }
    return (
      stopped() ?? {
        ...identity,
        outcome: seen.kind === 'answer-lost' ? answerLost : UNPROVED[seen.kind],
        reason: seen.reason,
      }
    );
  } catch (error: unknown) {
    return (
      stopped() ?? {
        ...identity,
        outcome: 'not-delivered',
        reason: firstLine(error instanceof Error ? error.message : String(error)),
      }
    );
  }
}

const UNPROVED = {
  'not-replaced': 'delivered-unproved',
  unmarkable: 'unmarkable',
} as const satisfies Record<
  Exclude<ContextReplaced['kind'], 'replaced' | 'answer-lost'>,
  TargetReloadOutcome['outcome']
>;
