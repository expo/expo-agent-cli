// @ref llp/0005-runtime-loop-tools.rfc.md §Reloading the app

/** Each target retains its own delivery and replacement evidence. */
export interface TargetReloadOutcome {
  targetId: string;
  deviceName: string;
  outcome:
    | 'unsupported'
    | 'unmarkable'
    | 'not-delivered'
    | 'delivered-unproved'
    | 'context-replaced'
    /** The check stopped because another own target proved the reload first. */
    | 'stopped';
  reason: string | null;
}

/** One way of reloading, and what it did. */
export type ReloadAttempt =
  | (AttemptOutcome & { method: 'dev-server' | 'device' })
  /**
   * The mechanisms proved on the target they act on: rung 1's CDP `Page.reload` while the scope
   * skips an app (llp/0005 §Target owner), and a pinned `--method runtime`.
   */
  | (AttemptOutcome & {
      method: 'page-reload' | 'runtime';
      outcomes: TargetReloadOutcome[];
    });

interface AttemptOutcome {
  /** The app was reloaded by this method. */
  ok: boolean;
  /**
   * Whether the mechanism's action **reached the app**, which is not whether it worked.
   *
   * A broadcast has three outcomes, not two: the socket refused it, the frame went out and the app
   * was seen to come back, or the frame went out and nothing was seen. A delivered frame with no
   * proof is `ok: false, delivered: true`, so the run continues to the two observations that exist
   * for a mechanism whose own proof is missing. Only a refused frame is `delivered: false`.
   *
   * Null for an attempt where delivery is not a separate question from the outcome, which is every
   * attempt that decides by running a device tool: `simctl terminate` naming a process that is not
   * there fails, and there is no "delivered but unproved" for it.
   */
  delivered?: boolean | null;
  /** Why it did not work, or what it did. Never null: an attempt always has something to say. */
  reason: string;
  /**
   * The application id this attempt stopped and could not start again, or null.
   *
   * The device method is a force-stop and a relaunch, so a relaunch that is refused leaves the app
   * **closed** — a state this command produced, so the report names it.
   * Null for every attempt that stopped nothing, including a stop that itself failed.
   */
  leftAppStopped: string | null;
}

/** The attempt the run settled on: the last one that reloaded the app or reached it. */
export function settledAttempt(attempts: readonly ReloadAttempt[]): ReloadAttempt | undefined {
  return attempts.findLast((attempt) => attempt.ok || attempt.delivered === true);
}

/** The mechanisms proved on the target they act on. */
export type TargetProofMethod = 'page-reload' | 'runtime';
export type TargetProofAttempt = Extract<ReloadAttempt, { method: TargetProofMethod }>;

export function hasTargetOutcomes(attempt: ReloadAttempt): attempt is TargetProofAttempt {
  return 'outcomes' in attempt;
}

/** What each mechanism sends to the target, as the report names it. */
export const ACTION_NAME: Record<TargetProofMethod, string> = {
  'page-reload': 'Page.reload',
  runtime: 'expo.reloadAppAsync',
};

export function contextReplacedClause(names: string, method: TargetProofMethod): string {
  return `${names} answered from a new JavaScript context after ${ACTION_NAME[method]}`;
}

/**
 * What the targets' outcomes add up to. `proved`: a target answered from a new context.
 * `delivered`: a target answered and no new context was seen. `unprovable`: every target that
 * takes the action could not carry the marker, so the action was not sent.
 */
export function summarizeTargetOutcomes(
  outcomes: readonly TargetReloadOutcome[]
): 'proved' | 'delivered' | 'unprovable' | 'not-delivered' {
  if (outcomes.some((each) => each.outcome === 'context-replaced')) return 'proved';
  if (outcomes.some((each) => each.outcome === 'delivered-unproved')) return 'delivered';
  const reloadable = outcomes.filter((each) => each.outcome !== 'unsupported');
  return reloadable.length > 0 && reloadable.every((each) => each.outcome === 'unmarkable')
    ? 'unprovable'
    : 'not-delivered';
}

/** An attempt of a mechanism proved on its targets: `ok` and `delivered` follow the outcomes. */
export function targetProofAttempt(
  method: TargetProofMethod,
  outcomes: TargetReloadOutcome[],
  reason: string
): TargetProofAttempt {
  const summary = summarizeTargetOutcomes(outcomes);
  return {
    method,
    ok: summary === 'proved',
    delivered: summary === 'proved' || summary === 'delivered',
    reason,
    outcomes,
    leftAppStopped: null,
  };
}

/**
 * Why the mechanism brings the app back under the page id it had, or null when it does not. Then a
 * page id the dev server had not listed can prove the reload.
 */
const KEEPS_PAGE_ID: Record<ReloadAttempt['method'], string | null> = {
  'page-reload': 'the app answered Page.reload, which keeps its page id',
  device: 'a relaunched app registers again under the page id it had',
  'dev-server': null,
  runtime: 'the app answered expo.reloadAppAsync, which keeps its page id',
};

/** {@link KEEPS_PAGE_ID} for the attempt the run settled on. */
export function keepsPageId(attempts: readonly ReloadAttempt[]): string | null {
  const settled = settledAttempt(attempts);
  return settled ? KEEPS_PAGE_ID[settled.method] : null;
}

/** The witnesses behind the aggregate context-replaced label and human report. */
export function contextReplacedTargets(attempts: readonly ReloadAttempt[]): TargetReloadOutcome[] {
  return attempts
    .filter(hasTargetOutcomes)
    .flatMap((attempt) => attempt.outcomes.filter((each) => each.outcome === 'context-replaced'));
}
