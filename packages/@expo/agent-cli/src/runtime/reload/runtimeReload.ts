import { createDefaultTargetSelector, runtimeEvaluateAsync, type CdpTarget } from '../cdpClient';
import { ActionRefusedError } from '../contextReplaced';
import {
  contextReplacedClause,
  targetProofAttempt,
  type TargetProofAttempt,
  type TargetReloadOutcome,
} from './attempt';
import { reloadTargetAsync, type TargetAction } from './targetProof';

/**
 * SDK 58's native `reloadAppAsync` takes one string, the reason. Called with none it rejects with
 * "Received 0 arguments, but 1 was expected" and reloads nothing [observed — SDK 58 development
 * build, Expo simulator iOS session, 2026-11-12].
 */
const RELOAD_REASON = '@expo/agent-cli runtime:reload';

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
): Promise<TargetProofAttempt> {
  const started = Date.now();
  if (own.length === 0) {
    return targetProofAttempt(
      'runtime',
      [],
      `no app of this worktree is connected to the dev server, so there is no runtime to ask — this method reloads an app through its debugger and cannot start one`
    );
  }
  const target = await createDefaultTargetSelector()(own);
  if (target == null) {
    return targetProofAttempt('runtime', [], 'no app of this worktree answered over the debugger');
  }

  // After the target probe, which can take seconds on targets that do not answer: the window is
  // the proof's own, and `budgetMs` still bounds it.
  const deadline = Date.now() + Math.min(Math.max(0, budgetMs - (Date.now() - started)), PROOF_MS);
  const outcome = await reloadTargetAsync(devServerUrl, target, RUNTIME_RELOAD, { deadline });
  return targetProofAttempt('runtime', [outcome], describeOutcome(outcome));
}

function describeOutcome({ deviceName, outcome, reason }: TargetReloadOutcome): string {
  const name = `"${deviceName}"`;
  switch (outcome) {
    case 'context-replaced':
      return contextReplacedClause(name, 'runtime');
    case 'delivered-unproved':
      return `${name} was asked to reload with expo.reloadAppAsync, and the reload was not proved: ${reason}`;
    case 'unmarkable':
      return `nothing could prove a reload of ${name}, so expo.reloadAppAsync was not called: ${reason}`;
    // `unsupported` and `stopped` do not occur: one target, no stop, and no capability check.
    case 'not-delivered':
    case 'unsupported':
    case 'stopped':
      return reason ?? `${name} did not answer expo.reloadAppAsync`;
  }
}

const RUNTIME_RELOAD: TargetAction = {
  act: async (session, deadline) => {
    const answer = await runtimeEvaluateAsync(session, RELOAD_EXPRESSION, {
      returnByValue: true,
      timeoutMs: Math.max(1, Math.min(ANSWER_MS, deadline - Date.now())),
    });
    if (answer.value !== 'sent') {
      throw new ActionRefusedError(
        (typeof answer.value === 'string' && CANNOT_RELOAD[answer.value]) ||
          (answer.exceptionText
            ? `the app threw while it was asked to reload itself: ${answer.exceptionText}`
            : `the app answered the reload call with ${JSON.stringify(answer.value ?? null)}, which this command cannot read`)
      );
    }
  },
  // The call tears down the context that would answer, so a lost answer is a call that ran.
  answerLost: 'delivered-unproved',
};
