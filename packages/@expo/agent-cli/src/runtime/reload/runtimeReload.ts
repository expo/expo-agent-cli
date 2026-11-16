import { createDefaultTargetSelector, runtimeEvaluateAsync, type CdpTarget } from '../cdpClient';
import { jsContextReplacedAsync } from '../contextReplaced';
import { type ReloadAttempt, type TargetReloadOutcome } from './attempt';
import { firstLine } from '../../utils/text';

/**
 * SDK 58's native `reloadAppAsync` takes one string, the reason. Called with none it rejects with
 * "Received 0 arguments, but 1 was expected" and reloads nothing [observed — SDK 58 development
 * build, Expo simulator iOS session, 2026-11-12].
 */
export const RELOAD_REASON = '@expo/agent-cli runtime:reload';

/** Answers `sent` once the call is made; a rejection shows only as no new context. */
const RELOAD_EXPRESSION = `(function () {
  var e = globalThis.expo;
  if (e == null) return 'no-expo-global';
  if (typeof e.reloadAppAsync !== 'function') return 'no-reload-function';
  Promise.resolve(e.reloadAppAsync(${JSON.stringify(RELOAD_REASON)})).catch(function () {});
  return 'sent';
})()`;

const CANNOT_RELOAD: Record<string, string> = {
  'no-expo-global':
    'the app has no "expo" global, so there is nothing on it to reload with — this needs an app built on the expo package',
  'no-reload-function': `the app's "expo" global has no reloadAppAsync, so this runtime cannot be asked to reload itself — a newer expo package has it`,
};

/** The proof's share of `--timeout`: the bundle watch keeps the rest. */
const PROOF_MS = 5000;

/** The call answers at once or never, because it tears down the context that would answer. */
const ANSWER_MS = 1500;

/**
 * Reload by asking the app's own `expo` global to reload it, over the debugger.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads — the cloud loop, K2 and K3.
 *
 * The mechanism a caller chooses, and never one `auto` reaches for. **On Expo Go the same call
 * closes the app** [observed — Expo Go SDK 57, iOS 26.5 simulator, 2026-08-27: the app left the
 * screen and `/json/list` was still empty 13 s later]. One runtime reloads and another quits, and
 * this command cannot tell which in advance.
 *
 * It is `expo.reloadAppAsync` because that is what a Hermes runtime has: no `require` and no
 * `import()`, so `DevSettings.reload()` is unreachable from an expression
 * [observed, cloud simulator, 2026-08-27].
 *
 * The app keeps its page id [observed — SDK 58 development build, 2026-11-13], so the proof is the
 * one `Page.reload` has: a marker global that the new JavaScript context does not have
 * (`../contextReplaced.ts`). A lost answer is a call that ran: it is delivered, not proved.
 */
export async function reloadOverRuntimeAsync(
  devServerUrl: string,
  own: CdpTarget[],
  budgetMs: number
): Promise<ReloadAttempt> {
  const attempt = (
    reason: string,
    outcomes: TargetReloadOutcome[] = [],
    outcome?: TargetReloadOutcome['outcome']
  ): ReloadAttempt => ({
    method: 'runtime',
    ok: outcome === 'context-replaced',
    delivered: outcome === 'context-replaced' || outcome === 'delivered-unproved',
    reason,
    outcomes,
    leftAppStopped: null,
  });

  if (own.length === 0) {
    return attempt(
      `no app is connected to the dev server, so there is no runtime to ask — this method reloads an app through its debugger and cannot start one`
    );
  }
  const target = await createDefaultTargetSelector()(own);
  if (target == null) {
    return attempt('no app of this worktree answered over the debugger');
  }

  const deadline = Date.now() + Math.min(Math.max(0, budgetMs), PROOF_MS);
  const name = `"${target.deviceName}"`;
  const settle = (outcome: TargetReloadOutcome['outcome'], reason: string) =>
    attempt(
      reason,
      [
        {
          targetId: target.id,
          deviceName: target.deviceName,
          outcome,
          reason: outcome === 'context-replaced' ? null : reason,
        },
      ],
      outcome
    );
  try {
    const seen = await jsContextReplacedAsync(devServerUrl, target, {
      act: async (session) => {
        const answer = await runtimeEvaluateAsync(session, RELOAD_EXPRESSION, {
          returnByValue: true,
          timeoutMs: Math.max(1, Math.min(ANSWER_MS, deadline - Date.now())),
        });
        if (answer.value !== 'sent') {
          throw new Error(
            (typeof answer.value === 'string' && CANNOT_RELOAD[answer.value]) ||
              (answer.exceptionText
                ? `the app threw while it was asked to reload itself: ${answer.exceptionText}`
                : `the app answered the reload call with ${JSON.stringify(answer.value ?? null)}, which this command cannot read`)
          );
        }
      },
      timeoutMs: Math.max(0, deadline - Date.now()),
      deadline,
    });
    switch (seen.kind) {
      case 'replaced':
        return settle(
          'context-replaced',
          `${name} answered from a new JavaScript context after expo.reloadAppAsync`
        );
      case 'unmarkable':
        return settle(
          'unmarkable',
          `${name} could not keep the marker that proves a reload, so expo.reloadAppAsync was not called: ${seen.reason}`
        );
      default:
        return settle(
          'delivered-unproved',
          `${name} was asked to reload with expo.reloadAppAsync, and no new JavaScript context was seen: ${seen.reason}`
        );
    }
  } catch (error: unknown) {
    return settle(
      'not-delivered',
      firstLine(error instanceof Error ? error.message : String(error))
    );
  }
}
