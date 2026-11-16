// @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads
// @ref llp/0005-runtime-loop-tools.rfc.md §What proves a reload
//
// The two rung 1 mechanisms that act on each own target: CDP `Page.reload` (while the scope skips an
// app or is an iOS EAS session) and `expo.reloadAppAsync(reason)` (a pinned `--method runtime`).
// Both are proved the same way, on the target they were sent to: a marker global that the new
// JavaScript context does not have (`../contextReplaced.ts`).

import { firstLine } from '../../utils/text';
import type { CdpTarget } from '../cdpClient';
import { jsContextReplacedAsync, type ContextReplaced } from '../contextReplaced';
import { RELOAD_REASON, type TargetReloadOutcome } from './attempt';
import { debugEvent } from './events';
import type { CommandSocketChurn, RungOneOutcome } from './rungOne';

export type InPlaceMechanism = 'page-reload' | 'runtime';

const RUNTIME_RELOAD_EXPRESSION = `(function () {
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

/**
 * What differs per mechanism. `proofMs` bounds rung 1's window: it is separate from `--timeout`, so
 * a proof that does not come leaves the rest of the budget to the relaunch or, for `runtime`, to the
 * bundle observation. `answerMs` bounds one target's answer: `expo.reloadAppAsync` answers
 * at once or never (its context goes), so its bound is short and the marker reads keep most of the
 * window. `unproved` maps a check that saw no new context to the target's outcome. `unlisted` is the
 * clause when no own target is listed.
 */
const MECHANISMS = {
  'page-reload': {
    label: 'Page.reload',
    proofMs: 8000,
    answerMs: 4000,
    event: 'page_reload_sent',
    unlisted: 'no app of this worktree is listed on the dev server',
    // Nothing shows that a `Page.reload` whose answer was lost reached the app.
    unproved: {
      'not-replaced': 'delivered-unproved',
      'answer-lost': 'not-delivered',
      unmarkable: 'unmarkable',
    },
  },
  runtime: {
    label: 'expo.reloadAppAsync',
    proofMs: 5000,
    answerMs: 1500,
    event: 'runtime_reload_sent',
    unlisted:
      'no app of this worktree is listed on the dev server, so there is no runtime to ask — this method reloads an app through its debugger and cannot start one',
    // The call tears down the context that would answer it, so a lost answer is a call that ran.
    unproved: {
      'not-replaced': 'delivered-unproved',
      'answer-lost': 'delivered-unproved',
      unmarkable: 'unmarkable',
    },
  },
} as const satisfies Record<
  InPlaceMechanism,
  {
    label: string;
    proofMs: number;
    answerMs: number;
    event: 'page_reload_sent' | 'runtime_reload_sent';
    unlisted: string;
    unproved: Record<Exclude<ContextReplaced['kind'], 'replaced'>, TargetReloadOutcome['outcome']>;
  }
>;

/** The name of each in-place mechanism, as the reports say it. */
export function inPlaceLabel(mechanism: InPlaceMechanism): string {
  return MECHANISMS[mechanism].label;
}

/** The end of rung 1's window for `mechanism`, which every own target and the relist share. */
export function proofDeadline(mechanism: InPlaceMechanism, budgetMs: number): number {
  return Date.now() + Math.min(Math.max(0, budgetMs), MECHANISMS[mechanism].proofMs);
}

/**
 * Take the action on each own target that can take it, and prove it on that target.
 *
 * The answer is delivery, not proof, and `Page.reload` keeps the target's page id [observed — SDK
 * 58 development build, React Native 0.88, iOS 27 simulator, 2026-10-21]. So a marker global is set
 * before the action, and the reload is proved when the same target answers without it. One target
 * proved is enough: it stops the other checks.
 *
 * @param why the sentence the attempt's reason ends with, or null.
 * @param churn what the run reports for the command socket, which this rung does not ask.
 */
export async function reloadInPlaceAsync(
  devServerUrl: string,
  {
    mechanism,
    own,
    deadline,
    why = null,
    churn,
  }: {
    mechanism: InPlaceMechanism;
    own: CdpTarget[];
    deadline: number;
    why?: string | null;
    churn: CommandSocketChurn;
  }
): Promise<RungOneOutcome> {
  const provedOne = new AbortController();
  const outcomes = await Promise.all(
    own.map((target) => reloadTargetAsync(devServerUrl, mechanism, target, deadline, provedOne))
  );
  const proved = outcomes.filter((each) => each.outcome === 'context-replaced');
  const answered = outcomes.filter(
    (each) => each.outcome === 'context-replaced' || each.outcome === 'delivered-unproved'
  );
  const notes = outcomes
    .filter((each) => each.reason)
    .map((each) => `"${each.deviceName}": ${each.reason}`);
  const reloadable = outcomes.filter((each) => each.outcome !== 'unsupported');
  debugEvent(MECHANISMS[mechanism].event, {
    targets: reloadable.length,
    answered: answered.length,
  });
  const kind =
    proved.length > 0
      ? 'proved'
      : answered.length > 0
        ? 'delivered'
        : reloadable.length > 0 && reloadable.every((each) => each.outcome === 'unmarkable')
          ? 'unprovable'
          : 'not-delivered';
  const names = (kind === 'proved' ? proved : answered)
    .map((each) => `"${each.deviceName}"`)
    .join(', ');
  const { label, unlisted } = MECHANISMS[mechanism];
  const clause = {
    proved: `${names} answered from a new JavaScript context after ${label}`,
    delivered: `${names} took ${label}, and no new JavaScript context was seen`,
    unprovable: `no app of this worktree could carry the marker that proves the reload, so no ${label} was sent`,
    'not-delivered':
      own.length === 0
        ? unlisted
        : reloadable.length === 0
          ? `no app of this worktree takes ${label}`
          : `no app of this worktree answered ${label}`,
  }[kind];
  const attempt = {
    method: mechanism,
    ok: kind === 'proved',
    delivered: kind === 'proved' || kind === 'delivered',
    outcomes,
    reason: `${clause}${notes.length ? ` (${notes.join('; ')})` : ''}${why ? `. ${why}` : ''}`,
    leftAppStopped: null,
  };
  return kind === 'proved'
    ? { kind, proof: 'debugger-context-replaced', attempt, churn }
    : {
        kind,
        attempt,
        churn,
        relaunchWhy: clause,
      };
}

async function reloadTargetAsync(
  devServerUrl: string,
  mechanism: InPlaceMechanism,
  target: CdpTarget,
  deadline: number,
  provedOne: AbortController
): Promise<TargetReloadOutcome> {
  const identity = { targetId: target.id, deviceName: target.deviceName };
  if (mechanism === 'page-reload' && target.reactNative?.capabilities?.nativePageReloads !== true) {
    return {
      ...identity,
      outcome: 'unsupported',
      reason: 'the target does not support Page.reload',
    };
  }
  const answerMs = () =>
    Math.max(1, Math.min(MECHANISMS[mechanism].answerMs, deadline - Date.now()));
  try {
    const seen = await jsContextReplacedAsync(devServerUrl, target, {
      act: async (session) => {
        if (mechanism === 'page-reload') {
          return await session.sendAsync('Page.reload', {}, answerMs());
        }
        const answer = (await session.sendAsync(
          'Runtime.evaluate',
          { expression: RUNTIME_RELOAD_EXPRESSION, returnByValue: true },
          answerMs()
        )) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
        const value = answer.result?.value;
        // `sent` says the call was made, not that it resolved: a rejection is caught in the app and
        // shows only as no new context. An answer that is not `sent` is an app that was not asked:
        // it fails here, at once, and is not delivered, rather than read as a reload that proved nothing.
        if (value !== 'sent') {
          throw new Error(
            (typeof value === 'string' && CANNOT_RELOAD[value]) ||
              (answer.exceptionDetails
                ? `the app threw while it was asked to reload itself: ${answer.exceptionDetails.text ?? 'an exception'}`
                : `the app answered the reload call with ${JSON.stringify(value ?? null)}, which this command cannot read`)
          );
        }
        return answer;
      },
      timeoutMs: Math.max(0, deadline - Date.now()),
      deadline,
      signal: provedOne.signal,
    });
    if (seen.kind === 'replaced') {
      provedOne.abort();
      return { ...identity, outcome: 'context-replaced', reason: null };
    }
    if (provedOne.signal.aborted) {
      return { ...identity, outcome: 'stopped', reason: STOPPED };
    }
    return { ...identity, outcome: MECHANISMS[mechanism].unproved[seen.kind], reason: seen.reason };
  } catch (error: unknown) {
    return provedOne.signal.aborted
      ? { ...identity, outcome: 'stopped', reason: STOPPED }
      : {
          ...identity,
          outcome: 'not-delivered',
          reason: firstLine(error instanceof Error ? error.message : String(error)),
        };
  }
}

const STOPPED = 'another app of this worktree proved the reload first, so this check stopped';
