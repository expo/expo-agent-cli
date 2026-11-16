// @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads
//
// The reload that keeps the app's process, as one decision that `runtime:reload` and `smoke` both
// take: rung 1, or a pinned `--method runtime`. Only `runtime:reload` in `auto` goes on to the
// relaunch.

import { type ReloadAttempt } from './attempt';
import { reloadOverRuntimeAsync } from './inPlace';
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

export async function runInPlaceRungsAsync(
  devServerUrl: string,
  projectRoot: string,
  {
    prepared: first,
    runtime,
    remainingMs,
  }: {
    prepared: PreparedRungOne;
    /** A pinned `--method runtime`: `expo.reloadAppAsync` on every own target, instead of rung 1. */
    runtime: boolean;
    remainingMs: () => number;
  }
): Promise<InPlaceRungs> {
  if (runtime) {
    const call = await reloadOverRuntimeAsync(
      devServerUrl,
      first.classifiedTargets.read,
      remainingMs()
    );
    return {
      prepared: first,
      attempts: [call.attempt],
      rungOne: null,
      churn: CHURN_NOT_ASKED,
      settled: settleRuntime(call),
    };
  }
  const prepared = await untilOwnListedAsync(devServerUrl, projectRoot, first, remainingMs);
  const rungOne = await runRungOneAsync(devServerUrl, { prepared, budgetMs: remainingMs() });
  return {
    prepared,
    attempts: [rungOne.attempt],
    rungOne,
    churn: rungOne.churn,
    settled: settleRungOne(rungOne),
  };
}

function settleRuntime(call: Awaited<ReturnType<typeof reloadOverRuntimeAsync>>): Settled {
  switch (call.kind) {
    case 'proved':
      return { kind: 'proved', method: 'runtime', proof: 'debugger-context-replaced' };
    case 'in-flight':
    case 'delivered':
      // The call ran: the shared observations decide. A pinned method never climbs.
      return { kind: 'observe', method: 'runtime' };
    case 'unprovable':
    case 'not-delivered':
      return { kind: 'relaunch', method: null, why: call.clause };
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
