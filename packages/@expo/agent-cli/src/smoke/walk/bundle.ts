import type { BundleCheckResult } from '../../runtime/bundleCheck';
import { bundleErrorSentence, noScreenshot } from '../results';
import { FIRST_BUNDLE_TIMEOUT_MS } from '../timeouts';
import type { DevServerFound } from './devServer';
import type { PhaseWalk, Step } from './walk';

/** What every exit from phase 2 on reports about the dev server. */
export interface RunBase extends DevServerFound {
  projectRootMatched: boolean | null;
}

// @ref ../timeouts §FIRST_BUNDLE_TIMEOUT_MS. On a dev server this run started, phases 2 and 3 are
// the dev server *coming up* rather than this run reading it, so they get the cold budget and what
// they spend is not taken off the window the caller gave the reads.
function coldBundleBudget(walk: PhaseWalk): { warming: boolean; warmingBudget: () => number } {
  const warming = walk.environment.devServer === 'started';
  return { warming, warmingBudget: () => (warming ? FIRST_BUNDLE_TIMEOUT_MS : walk.remaining()) };
}

// ---- Phase 2: has its bundler finished, and is it this project's? -------------------------
export async function bundlerReadyStep(
  walk: PhaseWalk,
  found: DevServerFound
): Promise<Step<RunBase>> {
  const { deps } = walk;
  const { warming, warmingBudget } = coldBundleBudget(walk);
  const readiness = await walk.record(
    'bundler-ready',
    async () => {
      const result = await deps.waitForBundlerReady(found.devServerUrl, warmingBudget());
      // Checked before the timeout, because it is decided rather than pending: no amount of looking
      // again turns another project's dev server into this one's (llp/0010 §Other gates, in brief).
      if (result.projectRootMatched === false) {
        return {
          status: 'failed' as const,
          reason: `it serves ${result.reportedProjectRoot ?? 'another project'}, not this one`,
          value: result,
        };
      }
      if (result.ready) {
        return { status: 'ok' as const, value: result };
      }
      return {
        status: result.timedOut ? ('inconclusive' as const) : ('failed' as const),
        reason: result.reason ?? 'the bundler did not answer',
        value: result,
      };
    },
    warmingBudget()
  );
  if (warming) {
    walk.chargeToBootstrap();
  }

  const base = { ...found, projectRootMatched: readiness.projectRootMatched };

  if (readiness.projectRootMatched === false) {
    // Building *their* entry bundle answers nothing about this code, and reading *their* app is
    // worse: it would report on a stranger's runtime as though it were this project's.
    walk.skipRest(
      'bundle',
      'the dev server serves another project, so nothing here is about this one'
    );
    return {
      stop: walk.done('failed', {
        ...base,
        screenshot: noScreenshot(
          'the dev server serves another project, so nothing was photographed'
        ),
      }),
    };
  }
  if (!readiness.ready) {
    walk.skipRest(
      'bundle',
      'the bundler never answered, so there was no bundle to read the app through'
    );
    return {
      stop: walk.done(readiness.timedOut ? 'inconclusive' : 'failed', {
        ...base,
        screenshot: noScreenshot('the bundler was not ready, so nothing was photographed'),
      }),
    };
  }
  return { next: base };
}

// ---- Phase 3: does this project's own code compile? ---------------------------------------
export async function bundleStep(walk: PhaseWalk, base: RunBase): Promise<Step<BundleCheckResult>> {
  const { deps } = walk;
  const { warming, warmingBudget } = coldBundleBudget(walk);
  const bundle = await walk.record(
    'bundle',
    async () => {
      const result = await deps.checkEntryBundle(base.devServerUrl, warmingBudget());
      switch (result.outcome) {
        case 'ok':
          return { status: 'ok' as const, value: result };
        case 'broken':
          return { status: 'failed' as const, reason: bundleErrorSentence(result), value: result };
        case 'timeout':
          return {
            status: 'inconclusive' as const,
            reason: 'the bundler was still building it when the budget ran out',
            value: result,
          };
        default:
          // Fail-open, unchanged from `dev:wait`: a dev server that answered nothing this CLI
          // understands has not shown the project to be broken (llp/0010 §An empty target list is inconclusive).
          return {
            status: 'inconclusive' as const,
            reason: result.reason ?? 'the bundler gave no answer about the entry bundle',
            value: result,
          };
      }
    },
    warmingBudget()
  );
  if (warming) {
    walk.chargeToBootstrap();
  }

  if (bundle.outcome === 'broken') {
    // Nothing after this is worth doing: the app cannot be running code that does not compile, and
    // an error window against the red screen would report the bundler's own error as the app's.
    walk.skipRest('app', 'the entry bundle does not compile, so there is no working app to read');
    return {
      stop: walk.done('failed', {
        ...base,
        bundle,
        screenshot: noScreenshot('the entry bundle does not compile, so nothing was photographed'),
      }),
    };
  }
  if (bundle.outcome === 'timeout') {
    walk.skipRest(
      'app',
      'the entry bundle was still building, so nothing is known about the app yet'
    );
    return {
      stop: walk.done('inconclusive', {
        ...base,
        bundle,
        screenshot: noScreenshot(
          'the entry bundle was still building, so nothing was photographed'
        ),
      }),
    };
  }
  return { next: bundle };
}
