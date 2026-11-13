// @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads
//
// Rungs 1 and 2, the reloads that keep the app's process, as one decision that `runtime:reload`
// and `smoke` both take. Only `runtime:reload` in `auto` goes on to the relaunch.

import { type ReloadAttempt } from './attempt';
import { askableInPlace, reloadOverRuntimeAsync } from './inPlace';
import {
  CHURN_NOT_ASKED,
  PAGE_RELOAD_PROOF_MS,
  prepareRungOneAsync,
  runRungOneAsync,
  settleRungOne,
  type CommandSocketChurn,
  type PreparedRungOne,
  type RungOneOutcome,
  type Settled,
} from './rungOne';

/** How often an unlisted session app is looked for again. */
const RELIST_INTERVAL_MS = 500;

export interface InPlaceRungs {
  /** The observation the rungs acted on: a later read when the own app was not listed yet. */
  prepared: PreparedRungOne;
  attempts: ReloadAttempt[];
  rungOne: RungOneOutcome | null;
  churn: CommandSocketChurn;
  settled: Settled;
}

/**
 * `auto` (and `smoke`): rung 1, then rung 2 where it applies. `rung-one`: a pinned
 * `--method dev-server`. `runtime`: a pinned `--method runtime`, rung 2 alone on every own target.
 */
export type InPlaceRungChoice = 'auto' | 'rung-one' | 'runtime';

export async function runInPlaceRungsAsync(
  devServerUrl: string,
  projectRoot: string,
  {
    prepared: first,
    rungs,
    remainingMs,
  }: { prepared: PreparedRungOne; rungs: InPlaceRungChoice; remainingMs: () => number }
): Promise<InPlaceRungs> {
  if (rungs === 'runtime') {
    const rungTwo = await reloadOverRuntimeAsync(
      devServerUrl,
      first.classifiedTargets.read,
      remainingMs()
    );
    return {
      prepared: first,
      attempts: [rungTwo.attempt],
      rungOne: null,
      churn: CHURN_NOT_ASKED,
      settled: settleRungTwo(rungTwo, null),
    };
  }
  const prepared = await untilOwnListedAsync(devServerUrl, projectRoot, first, remainingMs);
  const rungOne = await runRungOneAsync(devServerUrl, { prepared, budgetMs: remainingMs() });
  const attempts: ReloadAttempt[] = [rungOne.attempt];
  const settled = settleRungOne(rungOne);
  // Rung 2 is measured live only on an iOS EAS session, after a `Page.reload` that proved nothing:
  // one that reached the app, or none while an own target is listed. It needs no
  // `nativePageReloads`. Never on Expo Go, where the call can close the app.
  const askable =
    rungs === 'auto' &&
    prepared.policy.trigger === 'ios-eas-session' &&
    (rungOne.kind === 'delivered' || rungOne.kind === 'not-delivered')
      ? askableInPlace(prepared.classifiedTargets.read)
      : [];
  if (askable.length === 0) {
    return { prepared, attempts, rungOne, churn: rungOne.churn, settled };
  }
  const rungTwo = await reloadOverRuntimeAsync(devServerUrl, askable, remainingMs());
  attempts.push(rungTwo.attempt);
  return {
    prepared,
    attempts,
    rungOne,
    churn: rungOne.churn,
    settled: settleRungTwo(rungTwo, settled.method),
  };
}

function settleRungTwo(
  rungTwo: Awaited<ReturnType<typeof reloadOverRuntimeAsync>>,
  before: Settled['method']
): Settled {
  switch (rungTwo.kind) {
    case 'proved':
      return { kind: 'proved', method: 'runtime', proof: 'debugger-context-replaced' };
    case 'in-flight':
      // The call went and its context did not answer: the reload may be on its way, and a relaunch
      // now would stop the app inside it. The bundle decides.
      return { kind: 'observe', method: 'runtime' };
    case 'delivered':
      return {
        kind: 'relaunch',
        method: before ?? 'runtime',
        why: `${rungTwo.clause}, so the app was relaunched on this worktree's device instead`,
      };
    case 'unprovable':
    case 'not-delivered':
      return {
        kind: 'relaunch',
        method: before,
        why: `${rungTwo.clause}, so the app was relaunched on this worktree's device instead`,
      };
  }
}

/**
 * Right after `dev`, an iOS EAS session's app may not be listed yet. Read the list again, inside
 * rung 1's own `Page.reload` window, until an own target shows.
 */
async function untilOwnListedAsync(
  devServerUrl: string,
  projectRoot: string,
  prepared: PreparedRungOne,
  remainingMs: () => number
): Promise<PreparedRungOne> {
  if (prepared.policy.trigger !== 'ios-eas-session' || prepared.classifiedTargets.read.length > 0) {
    return prepared;
  }
  const deadline = Date.now() + Math.min(remainingMs(), PAGE_RELOAD_PROOF_MS);
  let current = prepared;
  while (current.classifiedTargets.read.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RELIST_INTERVAL_MS));
    current = await prepareRungOneAsync(devServerUrl, projectRoot, prepared.targetSelection, {
      budgetMs: Math.max(1, deadline - Date.now()),
      preflight: current,
      choice: prepared.choice,
    });
  }
  return current;
}
