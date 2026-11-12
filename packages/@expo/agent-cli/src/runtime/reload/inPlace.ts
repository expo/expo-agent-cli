// @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads
// @ref llp/0005-runtime-loop-tools.rfc.md §What proves a reload
//
// The two reloads that keep the app's process: CDP `Page.reload` (rung 1 while the scope skips an
// app or is an iOS EAS session) and `expo.reloadAppAsync(reason)` (rung 2, and `--method runtime`).
// Both are proved the same way, on the target they were sent to: a marker global that the new
// JavaScript context does not have (`../contextReplaced.ts`).

import { isExpoGoAppId } from '../../navigate/target';
import { firstLine } from '../../utils/text';
import type { CdpTarget } from '../cdpClient';
import { jsContextReplacedAsync, type ContextReplaced } from '../contextReplaced';
import { RELOAD_REASON, type ReloadAttempt, type TargetReloadOutcome } from './attempt';
import { debugEvent } from './events';

export type InPlaceMechanism = 'page-reload' | 'runtime';

/** How long rung 2 has to prove itself, so the relaunch keeps the rest of `--timeout`. */
const RUNTIME_RELOAD_PROOF_MS = 5000;

/**
 * How long one target has to answer the action. `expo.reloadAppAsync` answers at once or never (its
 * context goes), so its bound is short and the marker reads keep most of rung 2's window.
 */
const ANSWER_MS: Record<InPlaceMechanism, number> = { 'page-reload': 4000, runtime: 1500 };

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

const LABEL: Record<InPlaceMechanism, string> = {
  'page-reload': 'Page.reload',
  runtime: 'expo.reloadAppAsync',
};

export interface InPlaceReload {
  kind: 'proved' | 'delivered' | 'unprovable' | 'not-delivered';
  attempt: Extract<ReloadAttempt, { outcomes: TargetReloadOutcome[] }>;
  /** What happened, as the opening clause of whatever the run does next. */
  clause: string;
}

/** The own targets rung 2 may ask in `auto` and `smoke`: on Expo Go the call can close the app. */
export function askableInPlace(own: CdpTarget[]): CdpTarget[] {
  return own.filter((target) => !isExpoGoAppId(target.appId));
}

/**
 * Ask each own target to reload itself with `expo.reloadAppAsync(reason)`, and prove it on that
 * target. Rung 2 of `auto` and `smoke`, and all of `--method runtime`.
 */
export async function reloadOverRuntimeAsync(
  devServerUrl: string,
  own: CdpTarget[],
  budgetMs: number
): Promise<InPlaceReload> {
  if (own.length === 0) {
    const clause =
      'no app is connected to the dev server, so there is no runtime to ask — this method reloads an app through its debugger and cannot start one';
    return {
      kind: 'not-delivered',
      clause,
      attempt: {
        method: 'runtime',
        ok: false,
        delivered: false,
        outcomes: [],
        reason: clause,
        leftAppStopped: null,
      },
    };
  }
  return await reloadInPlaceAsync(devServerUrl, {
    mechanism: 'runtime',
    own,
    deadline: Date.now() + Math.min(Math.max(0, budgetMs), RUNTIME_RELOAD_PROOF_MS),
  });
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
 */
export async function reloadInPlaceAsync(
  devServerUrl: string,
  {
    mechanism,
    own,
    deadline,
    why = null,
  }: { mechanism: InPlaceMechanism; own: CdpTarget[]; deadline: number; why?: string | null }
): Promise<InPlaceReload> {
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
  debugEvent(mechanism === 'page-reload' ? 'page_reload_sent' : 'runtime_reload_sent', {
    targets: reloadable.length,
    answered: answered.length,
  });
  const kind: InPlaceReload['kind'] =
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
  const label = LABEL[mechanism];
  const clause = {
    proved: `${names} answered from a new JavaScript context after ${label}`,
    delivered: `${names} answered ${label} over the debugger, and no new JavaScript context was seen`,
    unprovable: `no app of this worktree could carry the marker that proves the reload, so no ${label} was sent`,
    'not-delivered':
      reloadable.length === 0
        ? `no app of this worktree takes ${label}`
        : `no app of this worktree answered ${label}`,
  }[kind];
  return {
    kind,
    clause,
    attempt: {
      method: mechanism,
      ok: kind === 'proved',
      delivered: kind === 'proved' || kind === 'delivered',
      outcomes,
      reason: `${clause}${notes.length ? ` (${notes.join('; ')})` : ''}${why ? `. ${why}` : ''}`,
      leftAppStopped: null,
    },
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
  const answerMs = () => Math.max(1, Math.min(ANSWER_MS[mechanism], deadline - Date.now()));
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
        // An answer that is not `sent` is an app that was not asked: it fails here, at once, and
        // is not delivered, rather than read as a reload that proved nothing.
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
    return { ...identity, outcome: UNPROVED[mechanism][seen.kind], reason: seen.reason };
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

/**
 * Nothing shows that a `Page.reload` whose answer was lost reached the app, so it is not counted as
 * answered. `expo.reloadAppAsync` tears down the context that would answer it, so a lost answer is
 * the usual shape of a call that ran: the run watches for a fresh target or a bundle.
 */
const UNPROVED = {
  'page-reload': {
    'not-replaced': 'delivered-unproved',
    'answer-lost': 'not-delivered',
    unmarkable: 'unmarkable',
  },
  runtime: {
    'not-replaced': 'delivered-unproved',
    'answer-lost': 'delivered-unproved',
    unmarkable: 'unmarkable',
  },
} as const satisfies Record<
  InPlaceMechanism,
  Record<Exclude<ContextReplaced['kind'], 'replaced'>, TargetReloadOutcome['outcome']>
>;

const STOPPED = 'another app of this worktree proved the reload first, so this check stopped';
