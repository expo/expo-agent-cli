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
  | (AttemptOutcome & { method: 'dev-server' | 'runtime' | 'device' })
  /**
   * Rung 1 while the scope skips an app: CDP `Page.reload` to each of this worktree's targets, and
   * no broadcast (llp/0005 §Target owner).
   */
  | (AttemptOutcome & {
      method: 'page-reload';
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

/**
 * Why the mechanism brings the app back under the page id it had, or null when it does not. Then a
 * page id the dev server had not listed can prove the reload.
 */
const KEEPS_PAGE_ID: Record<ReloadAttempt['method'], string | null> = {
  'page-reload': 'the app answered Page.reload, which keeps its page id',
  device: 'a relaunched app registers again under the page id it had',
  'dev-server': null,
  runtime: null,
};

/** {@link KEEPS_PAGE_ID} for the attempt the run settled on. */
export function keepsPageId(attempts: readonly ReloadAttempt[]): string | null {
  const settled = settledAttempt(attempts);
  return settled ? KEEPS_PAGE_ID[settled.method] : null;
}

/** The witnesses behind the aggregate context-replaced label and human report. */
export function contextReplacedTargets(attempts: readonly ReloadAttempt[]): TargetReloadOutcome[] {
  return attempts.flatMap((attempt) =>
    attempt.method === 'page-reload'
      ? attempt.outcomes.filter((each) => each.outcome === 'context-replaced')
      : []
  );
}
